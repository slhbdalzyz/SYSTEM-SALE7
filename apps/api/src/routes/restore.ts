import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, inTx, type Tx } from "../db";
import { HttpError, requireRole } from "../auth";
import { BACKUP_TABLES } from "./owner";

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
 * Everything else (catalog, sales, stock, customers, suppliers, purchases, transfers, offers,
 * expenses, alerts) is replaced by the file's copy.
 */

/** Kept and updated from the file, never deleted. */
const MERGE = ["stores", "users", "devices"];
/** Never restored from a file. */
const SKIP = ["tenants", "subscription_payments", "audit_log"];
/** The only shop settings a file may change. */
const TENANT_COLS = ["name", "currency", "business_type", "phone", "alert_settings", "settings"];

const REPLACE = BACKUP_TABLES.filter((t) => !MERGE.includes(t.name) && !SKIP.includes(t.name));
const RESTORED = BACKUP_TABLES.filter((t) => !SKIP.includes(t.name) || t.name === "tenants");
const MAX_ROWS = 5_000_000;

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
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
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
