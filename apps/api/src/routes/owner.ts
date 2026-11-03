import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError, authenticate, requireRole } from "../auth";
import { DEFAULT_ALERT_SETTINGS, alertSettings, pushPublicKey } from "../alerts";

/**
 * Every table that holds a shop's data, in the order a restore would load them, with the
 * columns left out of a backup (secrets that only the server should ever hold).
 */
export const BACKUP_TABLES: { name: string; key: "uuid" | "bigint"; omit?: string[]; own?: string }[] = [
  { name: "tenants", key: "uuid", own: "id" },
  { name: "stores", key: "uuid" },
  { name: "users", key: "uuid", omit: ["password_hash", "pin_hash"] },
  { name: "devices", key: "uuid", omit: ["token_hash"] },
  { name: "categories", key: "uuid" },
  { name: "products", key: "uuid" },
  { name: "product_units", key: "uuid" },
  { name: "barcodes", key: "uuid" },
  { name: "customers", key: "uuid" },
  { name: "suppliers", key: "uuid" },
  { name: "offers", key: "uuid" },
  { name: "shifts", key: "uuid" },
  { name: "sales", key: "uuid" },
  { name: "sale_lines", key: "uuid" },
  { name: "payments", key: "uuid" },
  { name: "customer_payments", key: "uuid" },
  { name: "purchase_invoices", key: "uuid" },
  { name: "purchase_lines", key: "uuid" },
  { name: "supplier_payments", key: "uuid" },
  { name: "stock_transfers", key: "uuid" },
  { name: "stock_transfer_lines", key: "uuid" },
  { name: "stock_movements", key: "uuid" },
  { name: "expenses", key: "uuid" },
  { name: "subscription_payments", key: "uuid" },
  { name: "alerts", key: "bigint" },
  { name: "audit_log", key: "bigint" },
];

const tzSchema = z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/).default("Africa/Tripoli");

const settingsSchema = z.object({
  lowStock: z.boolean(),
  returnOverMinor: z.number().int().min(0),
  discountOverMinor: z.number().int().min(0),
  cashDiffOverMinor: z.number().int().min(0),
  overCreditLimit: z.boolean(),
});

export async function ownerRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };
  const owners = { preHandler: requireRole("owner") };

  async function ownStore(tid: string, storeId: string | undefined) {
    if (!storeId) return;
    const r = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [storeId, tid]);
    if (!r.rowCount) throw new HttpError(404, "الفرع غير موجود");
  }

  /**
   * The owner's phone screen: how today is going against yesterday at the same hour, the
   * month so far after expenses, what is running out, who has a till open, and money owed.
   * Without a storeId it adds up every branch.
   */
  app.get("/dashboard", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), tz: tzSchema }).parse(req.query);
    const tid = req.user.tid;
    await ownStore(tid, q.storeId);
    const store = q.storeId ?? null;
    const args = [tid, store, q.tz];
    const inStore = (a: string) => `${a}.tenant_id = $1 AND ($2::uuid IS NULL OR ${a}.store_id = $2)`;
    const localDay = (col: string) => `(${col} AT TIME ZONE $3)::date`;
    // As text: a date object would shift a day in a server running in another time zone.
    const dayText = (col: string) => `to_char(${col} AT TIME ZONE $3, 'YYYY-MM-DD')`;
    const today = `(now() AT TIME ZONE $3)::date`;

    const [days, lines, exp, stores, low, shifts, owed, unread] = await Promise.all([
      // One row per local day for the last 7 days, plus yesterday up to this time of day.
      app.db.query(
        `SELECT ${dayText("s.created_at")} AS day,
           COALESCE(sum(s.total_minor), 0)::bigint AS total_minor,
           count(*) FILTER (WHERE s.kind = 'sale')::int AS sales_count,
           COALESCE(sum(s.total_minor) FILTER (WHERE s.created_at <= now() - interval '1 day'), 0)::bigint AS until_now_minor
         FROM sales s WHERE ${inStore("s")} AND s.created_at >= now() - interval '8 days'
         GROUP BY 1`,
        args,
      ),
      app.db.query(
        `SELECT ${dayText("s.created_at")} AS day, COALESCE(sum(l.total_minor - l.cost_minor), 0)::bigint AS profit_minor
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE ${inStore("s")} AND s.created_at >= now() - interval '8 days'
         GROUP BY 1`,
        args,
      ),
      app.db.query(
        `SELECT COALESCE(sum(amount_minor) FILTER (WHERE spent_on = ${today}), 0)::bigint AS today_minor,
           COALESCE(sum(amount_minor) FILTER (WHERE date_trunc('month', spent_on) = date_trunc('month', ${today})), 0)::bigint AS month_minor
         FROM expenses e WHERE ${inStore("e")} AND spent_on >= ${today} - 40`,
        args,
      ),
      app.db.query(
        `SELECT st.id, st.name,
           COALESCE((SELECT sum(s.total_minor) FROM sales s WHERE s.store_id = st.id AND ${localDay("s.created_at")} = ${today}), 0)::bigint AS total_minor,
           (SELECT count(*)::int FROM sales s WHERE s.store_id = st.id AND s.kind = 'sale' AND ${localDay("s.created_at")} = ${today}) AS sales_count
         FROM stores st WHERE st.tenant_id = $1 AND st.active AND ($2::uuid IS NULL OR st.id = $2) ORDER BY st.created_at`,
        args,
      ),
      app.db.query(
        `SELECT p.id, p.name, p.is_weighted, p.min_stock_milli, st.name AS store_name, COALESCE(sum(m.qty_milli), 0)::bigint AS stock_milli
         FROM products p CROSS JOIN stores st
         LEFT JOIN stock_movements m ON m.product_id = p.id AND m.store_id = st.id
         WHERE p.tenant_id = $1 AND st.tenant_id = $1 AND st.active AND ($2::uuid IS NULL OR st.id = $2) AND p.active AND p.min_stock_milli > 0
         GROUP BY p.id, st.id HAVING COALESCE(sum(m.qty_milli), 0) <= p.min_stock_milli
         ORDER BY COALESCE(sum(m.qty_milli), 0) <= 0 DESC, p.name`,
        [tid, store],
      ),
      app.db.query(
        `SELECT sh.id, sh.opened_at, u.name AS cashier, d.name AS device, st.name AS store_name,
           sh.opening_cash_minor
             + COALESCE((SELECT sum(p.amount_minor) FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = sh.id AND p.method = 'cash'), 0)
             - COALESCE((SELECT sum(s.change_minor) FROM sales s WHERE s.shift_id = sh.id), 0)
             + COALESCE((SELECT sum(cp.amount_minor) FROM customer_payments cp WHERE cp.shift_id = sh.id AND cp.method = 'cash'), 0) AS expected_cash_minor
         FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN devices d ON d.id = sh.device_id JOIN stores st ON st.id = sh.store_id
         WHERE ${inStore("sh")} AND sh.closed_at IS NULL ORDER BY sh.opened_at`,
        [tid, store],
      ),
      app.db.query(
        `SELECT COALESCE((SELECT sum(balance_minor) FROM customer_balances WHERE tenant_id = $1 AND balance_minor > 0), 0)::bigint AS customers_owe_minor,
           COALESCE((SELECT sum(balance_minor) FROM supplier_balances WHERE tenant_id = $1 AND balance_minor > 0), 0)::bigint AS we_owe_minor`,
        [tid],
      ),
      app.db.query(`SELECT count(*)::int AS n FROM alerts WHERE tenant_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR store_id = $2 OR store_id IS NULL)`, [tid, store]),
    ]);

    const todayStr = (await app.db.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [q.tz])).rows[0].d as string;
    const byDay = new Map(days.rows.map((r) => [r.day as string, r]));
    const profitByDay = new Map(lines.rows.map((r) => [r.day as string, Number(r.profit_minor)]));
    const shift = (n: number) => {
      const d = new Date(`${todayStr}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = shift(i - 6);
      const r = byDay.get(d);
      return { day: d, totalMinor: Number(r?.total_minor ?? 0), salesCount: r?.sales_count ?? 0, profitMinor: profitByDay.get(d) ?? 0 };
    });
    const t = week[6];
    const y = byDay.get(shift(-1));
    const monthPrefix = todayStr.slice(0, 7);
    const month = (await app.db.query(
      `SELECT COALESCE(sum(s.total_minor), 0)::bigint AS total_minor, count(*) FILTER (WHERE s.kind = 'sale')::int AS sales_count,
         COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales x ON x.id = l.sale_id
                   WHERE x.tenant_id = $1 AND ($2::uuid IS NULL OR x.store_id = $2) AND to_char(x.created_at AT TIME ZONE $3, 'YYYY-MM') = $4), 0)::bigint AS profit_minor
       FROM sales s WHERE ${inStore("s")} AND to_char(s.created_at AT TIME ZONE $3, 'YYYY-MM') = $4`,
      [...args, monthPrefix],
    )).rows[0];
    const e = exp.rows[0];

    return {
      date: todayStr,
      today: {
        totalMinor: t.totalMinor,
        salesCount: t.salesCount,
        avgMinor: t.salesCount ? Math.round(t.totalMinor / t.salesCount) : 0,
        profitMinor: t.profitMinor,
        expensesMinor: Number(e.today_minor),
        netMinor: t.profitMinor - Number(e.today_minor),
        yesterdayUntilNowMinor: Number(y?.until_now_minor ?? 0),
        yesterdayMinor: Number(y?.total_minor ?? 0),
      },
      month: {
        totalMinor: Number(month.total_minor),
        salesCount: month.sales_count,
        profitMinor: Number(month.profit_minor),
        expensesMinor: Number(e.month_minor),
        netMinor: Number(month.profit_minor) - Number(e.month_minor),
      },
      week,
      stores: stores.rows.map((s) => ({ id: s.id, name: s.name, totalMinor: Number(s.total_minor), salesCount: s.sales_count })),
      lowStock: { count: low.rowCount ?? low.rows.length, items: low.rows.slice(0, 8).map((p) => ({ id: p.id, name: p.name, storeName: p.store_name, stockMilli: Number(p.stock_milli), minMilli: Number(p.min_stock_milli), weighted: p.is_weighted })) },
      openShifts: shifts.rows.map((s) => ({ id: s.id, cashier: s.cashier, device: s.device, storeName: s.store_name, openedAt: s.opened_at, expectedCashMinor: Number(s.expected_cash_minor) })),
      customersOweMinor: Number(owed.rows[0].customers_owe_minor),
      weOweMinor: Number(owed.rows[0].we_owe_minor),
      unreadAlerts: unread.rows[0].n,
    };
  });

  // ---- Alerts ----

  app.get("/alerts", managers, async (req) => {
    const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    const r = await app.db.query(
      `SELECT a.id, a.kind, a.title, a.body, a.created_at, a.read_at, st.name AS store_name FROM alerts a LEFT JOIN stores st ON st.id = a.store_id
       WHERE a.tenant_id = $1 AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $3`,
      [req.user.tid, q.before ?? null, q.limit],
    );
    const unread = (await app.db.query(`SELECT count(*)::int AS n FROM alerts WHERE tenant_id = $1 AND read_at IS NULL`, [req.user.tid])).rows[0].n;
    return { alerts: r.rows.map((a) => ({ ...a, id: Number(a.id) })), unread };
  });

  app.post("/alerts/read", managers, async (req) => {
    const b = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).parse(req.body ?? {});
    await app.db.query(
      `UPDATE alerts SET read_at = now() WHERE tenant_id = $1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))`,
      [req.user.tid, b.ids ?? null],
    );
    return { ok: true };
  });

  app.get("/alerts/settings", managers, async (req) => ({ ...(await alertSettings(app.db, req.user.tid)), pushKey: pushPublicKey() }));

  app.put("/alerts/settings", owners, async (req) => {
    const b = settingsSchema.parse({ ...DEFAULT_ALERT_SETTINGS, ...(req.body as object) });
    await app.db.query(`UPDATE tenants SET alert_settings = $2 WHERE id = $1`, [req.user.tid, b]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "alerts.settings", data: b });
    return b;
  });

  /** A phone that agreed to notifications. The same phone signing up again just refreshes it. */
  app.post("/push/subscribe", managers, async (req) => {
    if (!pushPublicKey()) throw new HttpError(400, "إشعارات التلفون مش مفعّلة على هذا السيرفر");
    const b = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }) }).parse(req.body);
    if (!b.endpoint.startsWith("https://")) throw new HttpError(400, "عنوان الإشعارات غير صحيح");
    await app.db.query(
      `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET tenant_id = $1, user_id = $2, p256dh = $4, auth = $5`,
      [req.user.tid, req.user.sub, b.endpoint, b.keys.p256dh, b.keys.auth],
    );
    return { ok: true };
  });

  app.post("/push/unsubscribe", managers, async (req) => {
    const b = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await app.db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND tenant_id = $2`, [b.endpoint, req.user.tid]);
    return { ok: true };
  });

  // ---- Expenses ----

  app.get("/expenses", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    const r = await app.db.query(
      `SELECT e.id, e.category, e.amount_minor, e.note, to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on, st.name AS store_name, u.name AS user_name
       FROM expenses e JOIN stores st ON st.id = e.store_id LEFT JOIN users u ON u.id = e.user_id
       WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.store_id = $2) AND to_char(e.spent_on, 'YYYY-MM') = $3
       ORDER BY e.spent_on DESC, e.created_at DESC`,
      [req.user.tid, q.storeId ?? null, q.month],
    );
    const byCategory: Record<string, number> = {};
    for (const x of r.rows) byCategory[x.category] = (byCategory[x.category] ?? 0) + Number(x.amount_minor);
    return { expenses: r.rows, byCategory, totalMinor: Object.values(byCategory).reduce((a, n) => a + n, 0) };
  });

  app.post("/expenses", managers, async (req) => {
    const b = z.object({
      storeId: z.string().uuid(),
      category: z.string().trim().min(1).max(40),
      amountMinor: z.number().int().positive().max(1e12),
      note: z.string().max(200).optional(),
      spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body);
    await ownStore(req.user.tid, b.storeId);
    const r = await app.db.query(
      `INSERT INTO expenses (tenant_id, store_id, category, amount_minor, note, spent_on, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.tid, b.storeId, b.category, b.amountMinor, b.note || null, b.spentOn, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "expense.add", entity: "expense", entityId: r.rows[0].id, data: b });
    return { id: r.rows[0].id };
  });

  app.post("/expenses/:id/delete", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(`DELETE FROM expenses WHERE id = $1 AND tenant_id = $2 RETURNING category, amount_minor, spent_on`, [id, req.user.tid]);
    if (!r.rowCount) throw new HttpError(404, "المصروف غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "expense.delete", entity: "expense", entityId: id, data: r.rows[0] });
    return { ok: true };
  });

  // ---- Backup ----

  /** The owner, or a till the owner allowed to keep backups. */
  async function backupAllowed(req: FastifyRequest) {
    await authenticate(req);
    if (req.user.role === "owner") return;
    if (req.user.did) {
      const d = await app.db.query(`SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2 AND active AND backup`, [req.user.did, req.user.tid]);
      if (d.rowCount) return;
    }
    throw new HttpError(403, "النسخة الاحتياطية لصاحب المحل فقط");
  }

  /** What a backup will hold. The client then fetches each table page by page. */
  app.get("/backup", { preHandler: backupAllowed }, async (req) => {
    const counts = await Promise.all(
      BACKUP_TABLES.map(async (t) => {
        const r = await app.db.query(`SELECT count(*)::int AS n FROM ${t.name} WHERE ${t.own ?? "tenant_id"} = $1`, [req.user.tid]);
        return { name: t.name, rows: r.rows[0].n as number };
      }),
    );
    const v = (await app.db.query(`SELECT max(name) AS v FROM schema_migrations`).catch(() => ({ rows: [{ v: null }] }))).rows[0].v;
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did ?? null, action: "backup.start" });
    return { format: "pos-backup-1", schema: v, tenantId: req.user.tid, createdAt: new Date().toISOString(), tables: counts };
  });

  app.get("/backup/:table", { preHandler: backupAllowed }, async (req) => {
    const { table } = z.object({ table: z.string() }).parse(req.params);
    const q = z.object({ after: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(2000).default(1000) }).parse(req.query);
    const t = BACKUP_TABLES.find((x) => x.name === table);
    if (!t) throw new HttpError(404, "جدول غير معروف");
    if (q.after && !(t.key === "bigint" ? /^\d+$/ : /^[0-9a-f-]{36}$/).test(q.after)) throw new HttpError(400, "بيانات غير صحيحة");
    const r = await app.db.query(
      `SELECT * FROM ${t.name} WHERE ${t.own ?? "tenant_id"} = $1 AND ($2::${t.key} IS NULL OR id > $2::${t.key}) ORDER BY id LIMIT $3`,
      [req.user.tid, q.after ?? null, q.limit],
    );
    const rows = r.rows.map((row) => {
      for (const c of t.omit ?? []) delete row[c];
      return row;
    });
    return { rows, next: rows.length === q.limit ? String(rows[rows.length - 1].id) : null };
  });

  /** The owner turns daily backups on or off for one till. */
  app.patch("/devices/:id/backup", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { backup } = z.object({ backup: z.boolean() }).parse(req.body);
    const r = await app.db.query(`UPDATE devices SET backup = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, req.user.tid, backup]);
    if (!r.rowCount) throw new HttpError(404, "الجهاز غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "device.backup", entity: "device", entityId: id, data: { backup } });
    return { ok: true };
  });
}
