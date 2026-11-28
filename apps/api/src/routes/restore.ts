import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, inTx, type Tx } from "../db";
import { HttpError, requireRole } from "../auth";
import { BACKUP_TABLES } from "./owner";
import { CARRIED } from "./reset";
import { FLOWS } from "./money";

/**
 * Restoring a backup file made by GET /backup.
 *
 * The owner's browser reads the file and uploads its rows in pieces into a staging area
 * (restore_rows). Commit then checks the whole file and swaps the shop's data in one
 * transaction: if anything is wrong, nothing changes.
 *
 * What a restore does not touch, on purpose:
 *  - the subscription (plan, status, paid until) and its payments: a file must not be able to
 *    buy months of service;
 *  - the audit log, which is append-only; the restore itself is added to it;
 *  - passwords, PINs and device tokens, which a backup never holds. People and tills that still
 *    exist keep theirs; ones that come back from the file need a new password or pairing;
 *  - branches, staff and tills that exist now but not in the file. They are kept (only updated
 *    from the file), because tills and logins depend on them.
 * Everything else (catalog, sales, stock, customers and their points, suppliers, purchases,
 * transfers, offers, expenses, alerts) is replaced by the file's copy.
 */

/** Kept and updated from the file, never deleted. */
const MERGE = ["stores", "users", "devices"];
/** Never restored from a file. */
const SKIP = ["tenants", "subscription_payments", "audit_log"];
/** The only shop settings a file may change. */
const TENANT_COLS = ["name", "currency", "business_type", "phone", "alert_settings", "settings", "loyalty", "display_ads"];

const REPLACE = BACKUP_TABLES.filter((t) => !MERGE.includes(t.name) && !SKIP.includes(t.name));
const RESTORED = BACKUP_TABLES.filter((t) => !SKIP.includes(t.name) || t.name === "tenants");
const MAX_ROWS = 5_000_000;

/**
 * A partial restore brings back only some parts of a file and adds them to what the shop has now,
 * without removing anything: after «بداية جديدة», the owner can bring back the customers alone,
 * or the old invoices. What is already here wins; see restoreParts.
 */
export const PARTS = ["products", "customers", "suppliers", "moves"] as const;
type Part = (typeof PARTS)[number];
const PART_TABLES: Record<Part, string[]> = {
  products: ["categories", "products", "product_units", "barcodes", "quick_groups", "quick_keys", "offers", "kits"],
  customers: ["customers"],
  suppliers: ["suppliers"],
  moves: [
    "shifts", "sales", "sale_lines", "payments", "loyalty_entries", "customer_payments", "purchase_invoices", "purchase_lines",
    "supplier_payments", "stock_transfers", "stock_transfer_lines", "stock_movements", "product_serials", "repairs", "quotes",
    "installment_plans", "expenses", "payroll_months", "payroll_entries", "money_movements", "loans", "loan_moves", "alerts",
  ],
};

const manifestSchema = z.object({
  format: z.literal("pos-backup-1"),
  schema: z.string().max(100).nullable(),
  tenantId: z.string().uuid(),
  createdAt: z.string().datetime(),
  tables: z.array(z.object({ name: z.string().max(64), rows: z.number().int().min(0) })).max(100),
});

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

export async function restoreRoutes(app: FastifyInstance) {
  const owners = { preHandler: requireRole("owner") };

  async function job(id: string, tid: string) {
    const r = await app.db.query(`SELECT id, manifest, user_id FROM restore_jobs WHERE id = $1 AND tenant_id = $2`, [id, tid]);
    if (!r.rowCount) throw new HttpError(404, "عملية الاسترجاع غير موجودة، ابدا من جديد");
    return r.rows[0] as { id: string; manifest: z.infer<typeof manifestSchema>; user_id: string };
  }

  async function stagedCounts(id: string) {
    const r = await app.db.query(`SELECT tbl, count(*)::int AS n FROM restore_rows WHERE job_id = $1 GROUP BY tbl`, [id]);
    return Object.fromEntries(r.rows.map((x) => [x.tbl as string, x.n as number]));
  }

  /** Starts a restore from the file's first line. Refuses another shop's file or a newer system's. */
  app.post("/restore", owners, async (req) => {
    const parsed = manifestSchema.safeParse((req.body as { manifest?: unknown })?.manifest);
    if (!parsed.success) throw new HttpError(400, "الملف هذا مش نسخة احتياطية من النظام");
    const m = parsed.data;
    if (m.tenantId !== req.user.tid) throw new HttpError(400, "النسخة هذي لمحل ثاني، وما تنفعش هنا");
    const v = (await app.db.query(`SELECT max(name) AS v FROM schema_migrations`)).rows[0].v as string | null;
    if (m.schema && v && m.schema > v) throw new HttpError(400, "النسخة هذي من إصدار أحدث من النظام. حدّث النظام قبل");
    if (m.tables.reduce((a, t) => a + t.rows, 0) > MAX_ROWS) throw new HttpError(400, "النسخة كبيرة برشا");
    // One restore at a time per shop; anything left from an earlier try is dropped.
    await app.db.query(`DELETE FROM restore_jobs WHERE tenant_id = $1 OR created_at < now() - interval '1 day'`, [req.user.tid]);
    const r = await app.db.query(`INSERT INTO restore_jobs (tenant_id, user_id, manifest) VALUES ($1,$2,$3) RETURNING id`, [req.user.tid, req.user.sub, m]);
    return { id: r.rows[0].id as string };
  });

  /** A piece of the file: up to 2000 rows of {t, r}. Rows of tables a restore never writes are dropped. */
  app.post("/restore/:id/rows", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = z.object({ rows: z.array(z.object({ t: z.string().max(64), r: z.record(z.unknown()) })).max(2000) }).parse(req.body);
    await job(id, req.user.tid);
    const keep = rows.filter((x) => RESTORED.some((t) => t.name === x.t));
    if (keep.length) {
      await app.db.query(
        `INSERT INTO restore_rows (job_id, tbl, row) SELECT $1, x->>'t', x->'r' FROM jsonb_array_elements($2::jsonb) x`,
        [id, JSON.stringify(keep)],
      );
    }
    return { ok: true, received: keep.length };
  });

  /** Swaps the shop's data for the file's. Asks for the owner's password again. */
  app.post("/restore/:id/commit", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { password, parts } = z.object({ password: z.string().min(1).max(200), parts: z.array(z.enum(PARTS)).max(PARTS.length).optional() }).parse(req.body);
    const j = await job(id, req.user.tid);
    const me = (await app.db.query(`SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`, [req.user.sub, req.user.tid])).rows[0];
    if (!me?.password_hash || !(await bcrypt.compare(password, me.password_hash))) throw new HttpError(401, "كلمة السر غلط");

    // The upload must be complete: every table the file says it holds, row for row.
    const staged = await stagedCounts(id);
    for (const t of j.manifest.tables) {
      if (!RESTORED.some((x) => x.name === t.name)) continue;
      if ((staged[t.name] ?? 0) !== t.rows) throw new HttpError(400, "الملف ما تحمّلش كامل. جرّب مرة ثانية");
    }
    if ((staged.tenants ?? 0) > 1) throw new HttpError(400, "الملف هذا مش نسخة احتياطية صحيحة");

    const tid = req.user.tid;
    if (parts?.length) {
      const added = await inTx(app.db, (tx) => restoreParts(tx, id, tid, req.user.sub, parts, j.manifest.createdAt)).catch((e: { code?: string }) => {
        if (e instanceof HttpError) throw e;
        if (e.code && /^23/.test(e.code)) throw new HttpError(400, `ما قدرناش نرجّعوا الجزء هذا: البيانات فيها تعارض (${e.code}). ما تغيّر شي`);
        throw e;
      });
      return { ok: true, rows: added };
    }
    const counts = await inTx(app.db, async (tx) => {
      await tx.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tid]);
      const cols = await columns(tx);

      for (const t of [...REPLACE].reverse()) await tx.query(`DELETE FROM ${t.name} WHERE tenant_id = $1`, [tid]);

      await restoreTenant(tx, id, tid);
      const out: Record<string, number> = {};
      for (const t of BACKUP_TABLES) {
        if (SKIP.includes(t.name) || !staged[t.name]) continue;
        out[t.name] = await load(tx, id, tid, t, cols[t.name] ?? [], MERGE.includes(t.name));
      }
      // Whoever restores stays the owner, whatever the file says about them.
      await tx.query(`UPDATE users SET role = 'owner', active = true WHERE id = $1`, [req.user.sub]);
      await sameShopOnly(tx, tid);
      await tx.query(`UPDATE tenants SET restored_at = now() WHERE id = $1`, [tid]);
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: "backup.restore", data: { backupCreatedAt: j.manifest.createdAt, rows: out } });
      await tx.query(`DELETE FROM restore_jobs WHERE id = $1`, [id]);
      return out;
    }).catch((e: { code?: string; message?: string }) => {
      if (e instanceof HttpError) throw e;
      // Constraint errors: the file disagrees with this shop's data (or was edited by hand).
      if (e.code && /^23/.test(e.code)) throw new HttpError(400, `ما قدرناش نرجّعوا النسخة: البيانات فيها تعارض (${e.code}). ما تغيّر شي`);
      throw e;
    });
    return { ok: true, rows: counts };
  });

  app.post("/restore/:id/cancel", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`DELETE FROM restore_jobs WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid]);
    return { ok: true };
  });
}

/** The current columns of each restored table, straight from the database. */
async function columns(tx: Tx): Promise<Record<string, string[]>> {
  const r = await tx.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY ordinal_position`,
    [BACKUP_TABLES.map((t) => t.name)],
  );
  const out: Record<string, string[]> = {};
  for (const x of r.rows) (out[x.table_name] ??= []).push(x.column_name);
  return out;
}

async function restoreTenant(tx: Tx, job: string, tid: string) {
  const row = (await tx.query(`SELECT row FROM restore_rows WHERE job_id = $1 AND tbl = 'tenants'`, [job])).rows[0]?.row as Record<string, unknown> | undefined;
  if (!row) return;
  const set = TENANT_COLS.filter((c) => c in row && row[c] !== null);
  if (!set.length) return;
  await tx.query(
    `UPDATE tenants t SET ${set.map((c) => `${q(c)} = r.${q(c)}`).join(", ")} FROM jsonb_populate_record(null::tenants, $2::jsonb) r WHERE t.id = $1`,
    [tid, JSON.stringify(row)],
  );
}

/**
 * Inserts one table's rows from the staging area, in file order. Only columns that exist now and
 * that the file has are written, so an older backup fills new columns with their defaults. The
 * shop is forced to this one, secrets are never taken from a file, and alerts get new ids.
 */
async function load(tx: Tx, job: string, tid: string, t: (typeof BACKUP_TABLES)[number], current: string[], merge: boolean): Promise<number> {
  const inFile = new Set(
    (await tx.query(`SELECT DISTINCT jsonb_object_keys(row) AS k FROM restore_rows WHERE job_id = $1 AND tbl = $2`, [job, t.name])).rows.map((x) => x.k as string),
  );
  const secrets = new Set(t.omit ?? []);
  let cols = current.filter((c) => (inFile.has(c) || c === "tenant_id") && !secrets.has(c));
  if (t.key === "bigint") cols = cols.filter((c) => c !== "id");
  if (merge && !cols.includes("id")) throw new HttpError(400, "الملف هذا مش نسخة احتياطية صحيحة");

  const value = (c: string) => (c === "tenant_id" ? "$2::uuid" : `r.${q(c)}`);
  const insertCols = [...cols];
  const values = cols.map(value);
  // A till that comes back from the file has no token; it must be paired again.
  if (t.name === "devices") {
    insertCols.push("token_hash");
    values.push(`'restored:' || gen_random_uuid()`);
  }
  let sql =
    `INSERT INTO ${t.name} (${insertCols.map(q).join(", ")}) ` +
    `SELECT ${values.join(", ")} FROM restore_rows s, jsonb_populate_record(null::${t.name}, s.row) r ` +
    `WHERE s.job_id = $1 AND s.tbl = $3 ORDER BY s.seq`;
  if (merge) {
    const upd = cols.filter((c) => c !== "id" && c !== "tenant_id");
    sql += ` ON CONFLICT (id) DO UPDATE SET ${upd.length ? upd.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ") : "id = EXCLUDED.id"} WHERE ${t.name}.tenant_id = $2`;
  }
  const r = await tx.query(sql, [job, tid, t.name]);
  const staged = (await tx.query(`SELECT count(*)::int AS n FROM restore_rows WHERE job_id = $1 AND tbl = $2`, [job, t.name])).rows[0].n as number;
  // A row the conflict clause skipped belongs to another shop.
  if ((r.rowCount ?? 0) !== staged) throw new HttpError(400, "النسخة فيها بيانات مش تابعة للمحل هذا");
  return staged;
}

/**
 * Every reference in the restored data must point inside this shop: a hand-made file could
 * otherwise link a sale to another shop's customer or product.
 */
async function sameShopOnly(tx: Tx, tid: string) {
  const tables = BACKUP_TABLES.map((t) => t.name);
  const fks = await tx.query(
    `SELECT c.conrelid::regclass::text AS child, a.attname AS col, c.confrelid::regclass::text AS parent, af.attname AS pcol
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
  );
  for (const f of fks.rows as { child: string; col: string; parent: string; pcol: string }[]) {
    if (!tables.includes(f.child) || !tables.includes(f.parent) || SKIP.includes(f.child) || f.parent === "tenants") continue;
    const bad = await tx.query(
      `SELECT 1 FROM ${f.child} x JOIN ${f.parent} p ON p.${q(f.pcol)} = x.${q(f.col)} WHERE x.tenant_id = $1 AND p.tenant_id <> $1 LIMIT 1`,
      [tid],
    );
    if (bad.rowCount) throw new HttpError(400, "النسخة فيها بيانات مش تابعة للمحل هذا");
  }
}

/**
 * Adds the chosen parts of the staged file to the shop, keeping everything that is here now.
 *
 *  - Old invoices need their items, customers and suppliers, so «moves» brings those too.
 *  - A row already here (same id) is left as it is.
 *  - A row that is the same thing under another id (a department with the same name, a customer
 *    with the same phone, an item with the same barcode or name, brought back from Excel) is
 *    matched to the one here, and everything in the file that pointed at it points at it instead.
 *  - Invoice, quote, repair and transfer numbers taken since are given new ones.
 *  - A row that still can't go in is left out, with whatever depends on it.
 *  - Bringing back the history replaces the opening figures that stood in for it (what
 *    «بداية جديدة» carried over, opening stock and balances entered again from Excel), so
 *    nothing is counted twice.
 */
async function restoreParts(tx: Tx, job: string, tid: string, ownerId: string, parts: Part[], createdAt: string) {
  const moves = parts.includes("moves");
  const chosen = new Set<string>(moves ? Object.values(PART_TABLES).flat() : parts.flatMap((p) => PART_TABLES[p]));
  const order = BACKUP_TABLES.filter((t) => chosen.has(t.name) || MERGE.includes(t.name));
  const names = order.map((t) => t.name);
  await tx.query(`SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE`, [tid]);
  const cols = await columns(tx);
  const fks = (await foreignKeys(tx)).filter((f) => names.includes(f.child) && names.includes(f.parent) && f.child !== f.parent);
  // Only the parts asked for: the rest of the file is dropped from the staging area.
  await tx.query(`DELETE FROM restore_rows WHERE job_id = $1 AND NOT (tbl = ANY($2))`, [job, names]);
  const staged = (t: string) => `(SELECT * FROM restore_rows WHERE job_id = $1 AND tbl = '${t}') s`;
  /** The same customer: the same phone, or the same name when neither has a phone. */
  const sameCustomer = `(c.phone = s.row->>'phone' OR (c.phone IS NULL AND s.row->>'phone' IS NULL AND c.name = s.row->>'name'))`;

  // A link to a table that comes later in the file (a sale's quote, a payroll line's expense) is
  // dropped: those columns are optional, and the row would otherwise point at nothing yet.
  for (const f of fks) {
    if (names.indexOf(f.parent) > names.indexOf(f.child) && f.nullable) {
      await tx.query(`UPDATE restore_rows SET row = row - '${f.col}' WHERE job_id = $1 AND tbl = $2`, [job, f.child]);
    }
  }

  if (moves) {
    // The history comes back, so the opening figures that stood in for it go. Customers and
    // suppliers start from what the file had for them, and their invoices count on top, once.
    await tx.query(`DELETE FROM loyalty_entries WHERE tenant_id = $1 AND note = $2 AND created_at >= $3::timestamptz`, [tid, CARRIED, createdAt]);
    await tx.query(
      `UPDATE customers c SET opening_balance_minor = COALESCE((s.row->>'opening_balance_minor')::bigint, 0)
         FROM ${staged("customers")} WHERE c.tenant_id = $2 AND (c.id = (s.row->>'id')::uuid OR ${sameCustomer})`,
      [job, tid],
    );
    await tx.query(
      `UPDATE suppliers c SET opening_balance_minor = COALESCE((s.row->>'opening_balance_minor')::bigint, 0)
         FROM ${staged("suppliers")} WHERE c.tenant_id = $2 AND (c.id = (s.row->>'id')::uuid OR c.name = s.row->>'name')`,
      [job, tid],
    );
  }

  await tx.query(`CREATE TEMP TABLE IF NOT EXISTS restore_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL)`);
  await tx.query(`CREATE TEMP TABLE IF NOT EXISTS restore_gone (id uuid PRIMARY KEY)`);
  /** Rows of `table` that are already here under another id: the file points at those instead. */
  const match = async (table: string, sql: string) => {
    if (!names.includes(table)) return;
    await tx.query(`DELETE FROM restore_map`);
    await tx.query(`INSERT INTO restore_map (old_id, new_id) SELECT DISTINCT ON (old_id) old_id, new_id FROM (${sql}) x WHERE old_id <> new_id ORDER BY old_id`, [job, tid]);
    for (const f of fks.filter((x) => x.parent === table)) {
      await tx.query(
        `UPDATE restore_rows s SET row = jsonb_set(s.row, '{${f.col}}', to_jsonb(m.new_id::text)) FROM restore_map m
          WHERE s.job_id = $1 AND s.tbl = $2 AND s.row->>'${f.col}' = m.old_id::text`,
        [job, f.child],
      );
    }
    await tx.query(`DELETE FROM restore_rows s USING restore_map m WHERE s.job_id = $1 AND s.tbl = $2 AND s.row->>'id' = m.old_id::text`, [job, table]);
  };
  await match("categories", `SELECT (s.row->>'id')::uuid AS old_id, c.id AS new_id FROM ${staged("categories")} JOIN categories c ON c.tenant_id = $2 AND c.name = s.row->>'name'`);
  await match("customers", `SELECT (s.row->>'id')::uuid AS old_id, c.id AS new_id FROM ${staged("customers")} JOIN customers c ON c.tenant_id = $2 AND ${sameCustomer}`);
  await match("suppliers", `SELECT (s.row->>'id')::uuid AS old_id, c.id AS new_id FROM ${staged("suppliers")} JOIN suppliers c ON c.tenant_id = $2 AND c.name = s.row->>'name'`);
  await match("kits", `SELECT (s.row->>'id')::uuid AS old_id, k.id AS new_id FROM ${staged("kits")} JOIN kits k ON k.tenant_id = $2 AND k.name = s.row->>'name'`);
  // The same item: one of its barcodes is here, or the same name, or the same scale code.
  await match(
    "products",
    `SELECT (u.row->>'product_id')::uuid AS old_id, cu.product_id AS new_id
       FROM restore_rows b
       JOIN restore_rows u ON u.job_id = b.job_id AND u.tbl = 'product_units' AND u.row->>'id' = b.row->>'unit_id'
       JOIN barcodes cb ON cb.tenant_id = $2 AND cb.code = b.row->>'code'
       JOIN product_units cu ON cu.id = cb.unit_id
      WHERE b.job_id = $1 AND b.tbl = 'barcodes'
     UNION ALL
     SELECT (s.row->>'id')::uuid, p.id FROM ${staged("products")} JOIN products p ON p.tenant_id = $2 AND lower(p.name) = lower(s.row->>'name')
     UNION ALL
     SELECT (s.row->>'id')::uuid, p.id FROM ${staged("products")} JOIN products p ON p.tenant_id = $2 AND p.scale_code = s.row->>'scale_code'`,
  );
  // Their packings: the one here of the same size; any other size is added to the item here.
  await match(
    "product_units",
    `SELECT (s.row->>'id')::uuid AS old_id, u.id AS new_id FROM ${staged("product_units")}
       JOIN product_units u ON u.tenant_id = $2 AND u.product_id::text = s.row->>'product_id' AND u.factor_milli = (s.row->>'factor_milli')::bigint`,
  );
  if (names.includes("barcodes")) {
    await tx.query(`DELETE FROM restore_rows s USING barcodes b WHERE s.job_id = $1 AND s.tbl = 'barcodes' AND b.tenant_id = $2 AND b.code = s.row->>'code'`, [job, tid]);
  }
  if (moves) {
    // Opening stock entered since (carried by the reset, or from Excel) gives way to the real history.
    await tx.query(
      `DELETE FROM stock_movements m WHERE m.tenant_id = $2 AND m.kind = 'adjust' AND m.note IN ($3, 'رصيد أول المدة') AND m.created_at >= $4::timestamptz
          AND m.product_id::text IN (SELECT s.row->>'product_id' FROM restore_rows s WHERE s.job_id = $1 AND s.tbl = 'stock_movements')`,
      [job, tid, CARRIED, createdAt],
    );
  }
  // Numbers taken since by new invoices, quotes, repairs or transfers: the old ones get new numbers.
  if (names.includes("sales")) {
    await tx.query(
      `UPDATE restore_rows s SET row = jsonb_set(s.row, '{number}', to_jsonb((s.row->>'number') || '-ق'))
        WHERE s.job_id = $1 AND s.tbl = 'sales'
          AND EXISTS (SELECT 1 FROM sales x WHERE x.tenant_id = $2 AND x.number = s.row->>'number' AND x.id::text <> s.row->>'id')`,
      [job, tid],
    );
  }
  for (const t of ["quotes", "repairs", "stock_transfers"]) {
    if (!names.includes(t)) continue;
    await tx.query(
      `WITH top AS (
         SELECT GREATEST((SELECT COALESCE(max(number), 0) FROM ${t} WHERE tenant_id = $2),
                         (SELECT COALESCE(max((r.row->>'number')::int), 0) FROM restore_rows r WHERE r.job_id = $1 AND r.tbl = '${t}')) AS n
       ), clash AS (
         SELECT s.seq, row_number() OVER (ORDER BY s.seq) AS n FROM restore_rows s
          WHERE s.job_id = $1 AND s.tbl = '${t}'
            AND EXISTS (SELECT 1 FROM ${t} x WHERE x.tenant_id = $2 AND x.number = (s.row->>'number')::int AND x.id::text <> s.row->>'id')
       )
       UPDATE restore_rows s SET row = jsonb_set(s.row, '{number}', to_jsonb(top.n + clash.n)) FROM clash, top WHERE s.seq = clash.seq`,
      [job, tid],
    );
  }
  if (names.includes("product_serials")) {
    await tx.query(`DELETE FROM restore_rows s USING product_serials p WHERE s.job_id = $1 AND s.tbl = 'product_serials' AND p.tenant_id = $2 AND p.serial = s.row->>'serial'`, [job, tid]);
  }

  // The treasury before, to take what the old rows bring back off the opening line the reset left.
  const treasury = async () =>
    new Map((await tx.query(`WITH f AS (${FLOWS}) SELECT account, COALESCE(bank_id::text, '') AS bank, sum(amount)::bigint AS n FROM f GROUP BY 1, 2`, [tid])).rows.map((r) => [`${r.account}|${r.bank}`, Number(r.n)]));
  const moneyBefore = moves ? await treasury() : null;

  const out: Record<string, number> = {};
  for (const t of order) {
    const added = await loadMissing(tx, job, tid, t, cols[t.name] ?? []);
    if (added && !MERGE.includes(t.name)) out[t.name] = added;
    // What is still not here (it clashed with something) is left out, with what points at it.
    const children = fks.filter((f) => f.parent === t.name);
    if (!children.length || t.key !== "uuid") continue;
    await tx.query(`DELETE FROM restore_gone`);
    await tx.query(
      `INSERT INTO restore_gone SELECT DISTINCT (s.row->>'id')::uuid FROM restore_rows s
        WHERE s.job_id = $1 AND s.tbl = $3 AND s.row ? 'id'
          AND NOT EXISTS (SELECT 1 FROM ${t.name} x WHERE x.id::text = s.row->>'id' AND x.tenant_id = $2)`,
      [job, tid, t.name],
    );
    if (!Number((await tx.query(`SELECT count(*) AS n FROM restore_gone`)).rows[0].n)) continue;
    for (const f of children) {
      if (t.name === "users") {
        // Someone who can't come back: what they did stays, under the owner's name.
        await tx.query(
          `UPDATE restore_rows s SET row = jsonb_set(s.row, '{${f.col}}', to_jsonb($3::text)) FROM restore_gone g WHERE s.job_id = $1 AND s.tbl = $2 AND s.row->>'${f.col}' = g.id::text`,
          [job, f.child, ownerId],
        );
      } else if (f.nullable) {
        await tx.query(`UPDATE restore_rows s SET row = s.row - '${f.col}' FROM restore_gone g WHERE s.job_id = $1 AND s.tbl = $2 AND s.row->>'${f.col}' = g.id::text`, [job, f.child]);
      } else {
        await tx.query(`DELETE FROM restore_rows s USING restore_gone g WHERE s.job_id = $1 AND s.tbl = $2 AND s.row->>'${f.col}' = g.id::text`, [job, f.child]);
      }
    }
  }
  if (moneyBefore) {
    // The opening line held the whole history's money; the history is back, so it keeps only the
    // part the file could not bring back (cash taken out of the drawer, say).
    const after = await treasury();
    const carried = (await tx.query(
      `SELECT id, account, COALESCE(bank_account_id::text, '') AS bank, amount_minor FROM money_movements WHERE tenant_id = $1 AND kind = 'opening' AND note = $2 AND created_at >= $3::timestamptz`,
      [tid, CARRIED, createdAt],
    )).rows;
    for (const c of carried) {
      const key = `${c.account}|${c.bank}`;
      const left = Number(c.amount_minor) - ((after.get(key) ?? 0) - (moneyBefore.get(key) ?? 0));
      if (left) await tx.query(`UPDATE money_movements SET amount_minor = $2 WHERE id = $1`, [c.id, left]);
      else await tx.query(`DELETE FROM money_movements WHERE id = $1`, [c.id]);
    }
  }
  await tx.query(`DROP TABLE IF EXISTS restore_map`);
  await tx.query(`DROP TABLE IF EXISTS restore_gone`);
  await sameShopOnly(tx, tid);
  await tx.query(`UPDATE tenants SET restored_at = now() WHERE id = $1`, [tid]);
  await audit(tx, { tenantId: tid, userId: ownerId, action: "backup.restore_parts", data: { parts, backupCreatedAt: createdAt, rows: out } });
  await tx.query(`DELETE FROM restore_jobs WHERE id = $1`, [job]);
  return out;
}

/** Single-column foreign keys, and whether the column may be left empty. */
async function foreignKeys(tx: Tx) {
  const r = await tx.query(
    `SELECT c.conrelid::regclass::text AS child, a.attname AS col, c.confrelid::regclass::text AS parent, NOT a.attnotnull AS nullable
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1`,
  );
  const bare = (n: string) => n.replace(/^.*\./, "").replace(/"/g, "");
  return (r.rows as { child: string; col: string; parent: string; nullable: boolean }[]).map((f) => ({ ...f, child: bare(f.child), parent: bare(f.parent) }));
}

/** Inserts the staged rows of one table that are not here yet, and says how many went in. */
async function loadMissing(tx: Tx, job: string, tid: string, t: (typeof BACKUP_TABLES)[number], current: string[]): Promise<number> {
  const inFile = new Set(
    (await tx.query(`SELECT DISTINCT jsonb_object_keys(row) AS k FROM restore_rows WHERE job_id = $1 AND tbl = $2`, [job, t.name])).rows.map((x) => x.k as string),
  );
  if (!inFile.size) return 0;
  const secrets = new Set(t.omit ?? []);
  let cols = current.filter((c) => (inFile.has(c) || c === "tenant_id") && !secrets.has(c));
  if (t.key === "bigint") cols = cols.filter((c) => c !== "id");
  const insertCols = [...cols];
  const values = cols.map((c) => (c === "tenant_id" ? "$2::uuid" : `r.${q(c)}`));
  if (t.name === "devices") {
    insertCols.push("token_hash");
    values.push(`'restored:' || gen_random_uuid()`);
  }
  const r = await tx.query(
    `INSERT INTO ${t.name} (${insertCols.map(q).join(", ")}) ` +
      `SELECT ${values.join(", ")} FROM restore_rows s, jsonb_populate_record(null::${t.name}, s.row) r ` +
      `WHERE s.job_id = $1 AND s.tbl = $3 ORDER BY s.seq ON CONFLICT DO NOTHING`,
    [job, tid, t.name],
  );
  return r.rowCount ?? 0;
}
