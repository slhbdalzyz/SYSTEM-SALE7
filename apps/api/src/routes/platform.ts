import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Db, Tx } from "../db";
import { inTx } from "../db";
import { HttpError, requirePlatform } from "../auth";
import { daysLeft, forgetTenant, graceDays, recordSubscriptionPayment, subState } from "../billing";

async function platformAudit(q: Db | Tx, e: { adminId: string; tenantId?: string; action: string; data?: unknown }) {
  await q.query(`INSERT INTO platform_audit (admin_id, tenant_id, action, data) VALUES ($1,$2,$3,$4)`, [e.adminId, e.tenantId ?? null, e.action, e.data ?? null]);
}

const planSchema = z.object({
  name: z.string().min(1).max(60),
  priceMinor: z.number().int().min(0),
  maxStores: z.number().int().min(1),
  maxDevices: z.number().int().min(1),
  maxUsers: z.number().int().min(1),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});

/** The service's own back office: every shop, what it pays, and who is behind. */
export async function platformRoutes(app: FastifyInstance) {
  const staff = { preHandler: requirePlatform };

  /** Public: the price list for the sign-up page. */
  app.get("/plans", async () => {
    const r = await app.db.query(`SELECT code, name, price_minor, max_stores, max_devices, max_users FROM plans WHERE active ORDER BY sort, price_minor`);
    return r.rows;
  });

  app.post("/platform/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const a = (await app.db.query(`SELECT id, name, password_hash FROM platform_admins WHERE email = $1 AND active`, [b.email.toLowerCase()])).rows[0];
    if (!a || !(await bcrypt.compare(b.password, a.password_hash))) throw new HttpError(401, "البريد أو كلمة السر غير صحيحة");
    await platformAudit(app.db, { adminId: a.id, action: "admin.login" });
    return { token: app.jwt.sign({ sub: a.id, tid: "", role: "platform" }, { expiresIn: "8h" }), name: a.name };
  });

  app.get("/platform/overview", staff, async () => {
    const grace = await graceDays(app.db);
    const tenants = (await app.db.query(`SELECT t.status, t.paid_until, p.price_minor FROM tenants t JOIN plans p ON p.code = t.plan_code`)).rows;
    const byState: Record<string, number> = {};
    let mrr = 0;
    let expiringSoon = 0;
    for (const t of tenants) {
      const s = subState(t, grace);
      byState[s] = (byState[s] ?? 0) + 1;
      if (s === "active" || s === "grace") mrr += t.price_minor;
      const d = daysLeft(t.paid_until);
      if ((s === "active" || s === "trial") && d <= 7) expiringSoon++;
    }
    const paid = (await app.db.query(
      `SELECT COALESCE(sum(amount_minor), 0) AS total, count(*)::int AS n FROM subscription_payments WHERE created_at > now() - interval '30 days'`,
    )).rows[0];
    const signups = (await app.db.query(`SELECT count(*)::int AS n FROM tenants WHERE created_at > now() - interval '30 days'`)).rows[0].n;
    return { tenants: tenants.length, byState, mrrMinor: mrr, expiringSoon, paid30Minor: paid.total, payments30: paid.n, signups30: signups };
  });

  app.get("/platform/tenants", staff, async (req) => {
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    const grace = await graceDays(app.db);
    const r = await app.db.query(
      `SELECT t.id, t.name, t.phone, t.status, t.status_reason, t.paid_until, t.plan_code, t.created_at, p.name AS plan_name, p.price_minor,
              (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY created_at LIMIT 1) AS owner_email,
              (SELECT count(*)::int FROM stores s WHERE s.tenant_id = t.id) AS stores,
              (SELECT count(*)::int FROM devices d WHERE d.tenant_id = t.id AND d.active) AS devices,
              (SELECT max(last_seen_at) FROM devices d WHERE d.tenant_id = t.id) AS last_seen_at,
              (SELECT count(*)::int FROM sales s WHERE s.tenant_id = t.id AND s.kind = 'sale' AND s.created_at > now() - interval '30 days') AS sales30,
              (SELECT COALESCE(sum(total_minor), 0) FROM sales s WHERE s.tenant_id = t.id AND s.created_at > now() - interval '30 days') AS revenue30
       FROM tenants t JOIN plans p ON p.code = t.plan_code
       WHERE $1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.phone ILIKE '%' || $1 || '%'
          OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE '%' || $1 || '%')
       ORDER BY t.paid_until`,
      [q || null],
    );
    return r.rows.map((t) => ({ ...t, state: subState(t, grace), days_left: daysLeft(t.paid_until) }));
  });

  app.get("/platform/tenants/:id", staff, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const grace = await graceDays(app.db);
    const t = (await app.db.query(
      `SELECT t.*, p.name AS plan_name, p.price_minor, p.max_stores, p.max_devices, p.max_users FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1`,
      [id],
    )).rows[0];
    if (!t) throw new HttpError(404, "المحل غير موجود");
    const [users, stores, devices, payments, log] = await Promise.all([
      app.db.query(`SELECT name, email, role, active FROM users WHERE tenant_id = $1 ORDER BY created_at`, [id]),
      app.db.query(`SELECT name, address FROM stores WHERE tenant_id = $1 ORDER BY created_at`, [id]),
      app.db.query(`SELECT name, kind, active, last_seen_at FROM devices WHERE tenant_id = $1 ORDER BY created_at`, [id]),
      app.db.query(
        `SELECT sp.*, a.name AS recorded_by_name FROM subscription_payments sp LEFT JOIN platform_admins a ON a.id = sp.recorded_by WHERE sp.tenant_id = $1 ORDER BY sp.created_at DESC`,
        [id],
      ),
      app.db.query(
        `SELECT pa.action, pa.data, pa.created_at, a.name AS admin_name FROM platform_audit pa LEFT JOIN platform_admins a ON a.id = pa.admin_id WHERE pa.tenant_id = $1 ORDER BY pa.id DESC LIMIT 50`,
        [id],
      ),
    ]);
    return { ...t, state: subState(t, grace), days_left: daysLeft(t.paid_until), users: users.rows, stores: stores.rows, devices: devices.rows, payments: payments.rows, log: log.rows };
  });

  /**
   * Records money received and moves the paid-up date forward from where it was, or from
   * today for a shop that had already locked.
   */
  app.post("/platform/tenants/:id/payments", staff, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      months: z.number().int().min(1).max(36),
      planCode: z.string().optional(),
      amountMinor: z.number().int().min(0).optional(),
      method: z.enum(["cash", "bank", "card", "other"]),
      reference: z.string().max(200).optional(),
    }).parse(req.body);
    const out = await inTx(app.db, async (tx) => {
      const r = await recordSubscriptionPayment(tx, id, { ...b, recordedBy: req.user.sub });
      await platformAudit(tx, { adminId: req.user.sub, tenantId: id, action: "payment.record", data: { months: b.months, amountMinor: r.amountMinor, planCode: r.planCode, method: b.method } });
      return { id: r.id, paidUntil: r.paidUntil.toISOString(), amountMinor: r.amountMinor };
    });
    forgetTenant(id);
    return out;
  });

  /** Suspend, reactivate, cancel, change plan, or give a trial more days. */
  app.patch("/platform/tenants/:id", staff, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      status: z.enum(["trial", "active", "suspended", "cancelled"]).optional(),
      reason: z.string().max(300).optional(),
      planCode: z.string().optional(),
      extendDays: z.number().int().min(1).max(365).optional(),
      phone: z.string().max(40).nullable().optional(),
    }).parse(req.body);
    if (b.planCode && !(await app.db.query(`SELECT 1 FROM plans WHERE code = $1`, [b.planCode])).rowCount) throw new HttpError(400, "الباقة غير موجودة");
    const r = await app.db.query(
      `UPDATE tenants SET
         status = COALESCE($2, status),
         status_reason = CASE WHEN $2::text IS NULL THEN status_reason WHEN $2 = 'suspended' THEN $3 ELSE NULL END,
         plan_code = COALESCE($4, plan_code),
         paid_until = CASE WHEN $5::int IS NULL THEN paid_until ELSE GREATEST(paid_until, now()) + make_interval(days => $5::int) END,
         phone = CASE WHEN $6::boolean THEN $7 ELSE phone END
       WHERE id = $1 RETURNING status, paid_until`,
      [id, b.status ?? null, b.reason ?? null, b.planCode ?? null, b.extendDays ?? null, b.phone !== undefined, b.phone ?? null],
    );
    if (!r.rowCount) throw new HttpError(404, "المحل غير موجود");
    await platformAudit(app.db, { adminId: req.user.sub, tenantId: id, action: "tenant.update", data: b });
    forgetTenant(id);
    return r.rows[0];
  });

  app.get("/platform/plans", staff, async () => (await app.db.query(`SELECT * FROM plans ORDER BY sort, price_minor`)).rows);

  app.put("/platform/plans/:code", staff, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^[a-z0-9_-]{2,30}$/) }).parse(req.params);
    const b = planSchema.parse(req.body);
    await app.db.query(
      `INSERT INTO plans (code, name, price_minor, max_stores, max_devices, max_users, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET name = $2, price_minor = $3, max_stores = $4, max_devices = $5, max_users = $6, active = $7, sort = $8`,
      [code, b.name, b.priceMinor, b.maxStores, b.maxDevices, b.maxUsers, b.active, b.sort],
    );
    await platformAudit(app.db, { adminId: req.user.sub, action: "plan.save", data: { code, ...b } });
    return { ok: true };
  });

  app.get("/platform/settings", staff, async () => {
    const r = await app.db.query(`SELECT key, value FROM platform_settings`);
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  });

  app.put("/platform/settings", staff, async (req) => {
    const b = z.object({ payment_instructions: z.string().max(2000).optional(), grace_days: z.number().int().min(0).max(60).optional() }).parse(req.body);
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      await app.db.query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, JSON.stringify(v)]);
    }
    await platformAudit(app.db, { adminId: req.user.sub, action: "settings.save", data: b });
    return { ok: true };
  });
}
