import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { fillPlatformTemplate, formatMoney, newTotpSecret, PLATFORM_ROLES, totpUri, verifyTotp } from "@pos/shared";
import type { Db } from "../db";
import { audit, inTx } from "../db";
import { HttpError, platformGuard } from "../auth";
import { flushPushes, raiseAlert } from "../alerts";
import { daysLeft, graceDays } from "../billing";
import { platformAudit } from "./platform";
import { subscriptionInvoice } from "./subscription";

// ---- Renewal reminders ----

/** Sends one text message through the SMS gateway set in the platform settings. Swappable in tests. */
export type SmsSender = (cfg: { url: string; token: string }, to: string, message: string) => Promise<void>;
let smsSender: SmsSender = async (cfg, to, message) => {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ to, message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`SMS ${r.status}`);
};
export const setSmsSender = (s: SmsSender) => void (smsSender = s);

/** The international form of a Libyan number for SMS and WhatsApp: 091… → 21891…. */
export function intlPhone(p: string | null | undefined): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("218")) return d;
  if (d.startsWith("0")) return `218${d.slice(1)}`;
  if (d.length === 9) return `218${d}`;
  return d;
}

/**
 * Seven days and three days before a shop's subscription ends, and once when it locks: an alert in
 * the shop's app (and on the owner's phone), and a text when an SMS gateway is set. Without one the
 * reminder waits in the platform's list for a one-tap WhatsApp. Safe to run as often as wanted.
 */
export async function runReminders(db: Db, now = Date.now()) {
  const grace = await graceDays(db);
  const settings = Object.fromEntries((await db.query(`SELECT key, value FROM platform_settings WHERE key IN ('reminder_message', 'sms')`)).rows.map((r) => [r.key, r.value]));
  const template: string = settings.reminder_message ?? "اشتراك {shop} ينتهي يوم {date}.";
  const sms = settings.sms as { enabled?: boolean; url?: string; token?: string } | undefined;
  const rows = (await db.query(
    `SELECT t.id, t.name, t.phone, t.paid_until, t.status, p.name AS plan_name, p.price_minor
     FROM tenants t JOIN plans p ON p.code = t.plan_code
     WHERE t.status IN ('trial', 'active') AND t.paid_until < $1::timestamptz + interval '8 days' AND t.paid_until > $1::timestamptz - make_interval(days => $2 + 7)`,
    [new Date(now).toISOString(), grace],
  )).rows;
  let made = 0;
  for (const t of rows) {
    const left = daysLeft(t.paid_until, now);
    const kind = left > 3 && left <= 7 ? "7d" : left >= 0 && left <= 3 ? "3d" : left < -grace ? "locked" : null;
    if (!kind) continue;
    const date = new Date(t.paid_until).toISOString().slice(0, 10);
    const message = kind === "locked"
      ? `اشتراك «${t.name}» انتهى والنظام موقوف عن البيع. جدّد من صفحة «الاشتراك» باش يرجع يخدم.`
      : fillPlatformTemplate(template, { shop: t.name, date, days: Math.max(left, 0), plan: t.plan_name, price: formatMoney(Number(t.price_minor)) });
    const ins = await db.query(
      `INSERT INTO subscription_reminders (tenant_id, kind, period_end, message) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [t.id, kind, date, message],
    );
    if (!ins.rowCount) continue;
    made++;
    const id = ins.rows[0].id;
    await raiseAlert(db, {
      tenantId: t.id, kind: "subscription_due",
      title: kind === "locked" ? "الاشتراك انتهى" : `الاشتراك ينتهي بعد ${Math.max(left, 0)} يوم`,
      body: message, data: { date, kind },
    });
    await flushPushes(db, t.id).catch(() => undefined);
    const to = intlPhone(t.phone);
    if (sms?.enabled && sms.url && to) {
      try {
        await smsSender({ url: sms.url, token: sms.token ?? "" }, to, message);
        await db.query(`UPDATE subscription_reminders SET sent_at = now(), channel = 'sms' WHERE id = $1`, [id]);
      } catch (e) {
        await db.query(`UPDATE subscription_reminders SET error = $2 WHERE id = $1`, [id, String((e as Error).message).slice(0, 300)]);
      }
    }
  }
  return { made };
}

/** The platform back office, grown into a company's: team, audit, money, agents, coupons, messages, support. */
export async function platformProRoutes(app: FastifyInstance) {
  const g = (perm?: Parameters<typeof platformGuard>[0]) => ({ preHandler: platformGuard(perm) });
  const me = (req: { platform?: { id: string } }) => req.platform!.id;

  app.get("/platform/me", g(), async (req) => {
    const a = (await app.db.query(`SELECT id, name, email, role, totp_enabled, agent_id FROM platform_admins WHERE id = $1`, [me(req)])).rows[0];
    return a;
  });

  // ---- Two-step sign-in for platform staff ----
  const twoFa = { preHandler: platformGuard(), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  app.post("/platform/2fa/setup", twoFa, async (req) => {
    const a = (await app.db.query(`SELECT email, totp_enabled FROM platform_admins WHERE id = $1`, [me(req)])).rows[0];
    if (a.totp_enabled) throw new HttpError(400, "التحقق بخطوتين مفعّل من قبل");
    const secret = newTotpSecret();
    await app.db.query(`UPDATE platform_admins SET totp_secret = $2 WHERE id = $1`, [me(req), secret]);
    return { secret, uri: totpUri(secret, a.email, "Sale7 Platform") };
  });
  app.post("/platform/2fa/enable", twoFa, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const a = (await app.db.query(`SELECT totp_secret FROM platform_admins WHERE id = $1`, [me(req)])).rows[0];
    if (!a?.totp_secret) throw new HttpError(400, "ابدأ الإعداد أولاً");
    if (!(await verifyTotp(a.totp_secret, code))) throw new HttpError(400, "الرمز غير صحيح، تأكد من وقت التلفون");
    await app.db.query(`UPDATE platform_admins SET totp_enabled = true WHERE id = $1`, [me(req)]);
    await platformAudit(app.db, { adminId: me(req), action: "admin.2fa_on" });
    return { ok: true };
  });
  app.post("/platform/2fa/disable", twoFa, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const a = (await app.db.query(`SELECT totp_secret, totp_enabled FROM platform_admins WHERE id = $1`, [me(req)])).rows[0];
    if (!a.totp_enabled || !(await verifyTotp(a.totp_secret, code))) throw new HttpError(400, "الرمز غير صحيح");
    await app.db.query(`UPDATE platform_admins SET totp_enabled = false, totp_secret = NULL WHERE id = $1`, [me(req)]);
    await platformAudit(app.db, { adminId: me(req), action: "admin.2fa_off" });
    return { ok: true };
  });

  // ---- The team ----
  app.get("/platform/team", g("team"), async () => {
    const r = await app.db.query(
      `SELECT a.id, a.name, a.email, a.role, a.active, a.totp_enabled, a.last_login_at, a.agent_id, ag.name AS agent_name, a.created_at
       FROM platform_admins a LEFT JOIN agents ag ON ag.id = a.agent_id ORDER BY a.created_at`,
    );
    return r.rows;
  });
  const member = z.object({
    name: z.string().trim().min(2).max(80),
    email: z.string().email().max(120),
    role: z.enum(PLATFORM_ROLES),
    password: z.string().min(8).max(100).optional(),
    agentId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  });
  app.post("/platform/team", g("team"), async (req) => {
    const b = member.parse(req.body);
    if (!b.password) throw new HttpError(400, "اكتب كلمة سر (8 أحرف على الأقل)");
    if (b.role === "agent" && !b.agentId) throw new HttpError(400, "اختار الوكيل لهذا الحساب");
    const hash = await bcrypt.hash(b.password, 10);
    const r = await app.db.query(
      `INSERT INTO platform_admins (name, email, password_hash, role, agent_id) VALUES ($1, lower($2), $3, $4, $5)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [b.name, b.email, hash, b.role, b.role === "agent" ? b.agentId : null],
    );
    if (!r.rowCount) throw new HttpError(409, "هذا البريد مستعمل");
    await platformAudit(app.db, { adminId: me(req), action: "team.add", data: { email: b.email, role: b.role } });
    return { id: r.rows[0].id };
  });
  app.patch("/platform/team/:id", g("team"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = member.partial().parse(req.body);
    if (id === me(req) && (b.active === false || (b.role && b.role !== "owner"))) throw new HttpError(400, "ما تقدرش توقف حسابك أو تنزل صلاحيتك بنفسك");
    if (b.role && b.role !== "owner" || b.active === false) {
      const owners = (await app.db.query(`SELECT count(*)::int AS n FROM platform_admins WHERE role = 'owner' AND active AND id <> $1`, [id])).rows[0].n;
      const target = (await app.db.query(`SELECT role FROM platform_admins WHERE id = $1`, [id])).rows[0];
      if (target?.role === "owner" && owners === 0) throw new HttpError(400, "لازم يبقى مالك واحد على الأقل");
    }
    const hash = b.password ? await bcrypt.hash(b.password, 10) : null;
    const r = await app.db.query(
      `UPDATE platform_admins SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
         password_hash = COALESCE($5, password_hash),
         agent_id = CASE WHEN COALESCE($3, role) = 'agent' THEN COALESCE($6, agent_id) ELSE NULL END,
         totp_enabled = CASE WHEN $7 THEN false ELSE totp_enabled END
       WHERE id = $1 RETURNING id`,
      [id, b.name ?? null, b.role ?? null, b.active ?? null, hash, b.agentId ?? null, Boolean(b.password)],
    );
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    await platformAudit(app.db, { adminId: me(req), action: "team.edit", data: { id, role: b.role, active: b.active, password: b.password ? "changed" : undefined } });
    return { ok: true };
  });

  // ---- Audit log ----
  app.get("/platform/audit", g("audit"), async (req) => {
    const q = z.object({
      action: z.string().max(60).optional(),
      adminId: z.string().uuid().optional(),
      tenantId: z.string().uuid().optional(),
      before: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(req.query);
    const r = await app.db.query(
      `SELECT l.id, l.created_at AS at, l.action, l.data, l.tenant_id, t.name AS tenant_name, a.name AS admin_name, a.role AS admin_role
       FROM platform_audit l LEFT JOIN platform_admins a ON a.id = l.admin_id LEFT JOIN tenants t ON t.id = l.tenant_id
       WHERE ($1::text IS NULL OR l.action LIKE $1 || '%') AND ($2::uuid IS NULL OR l.admin_id = $2) AND ($3::uuid IS NULL OR l.tenant_id = $3)
         AND ($4::timestamptz IS NULL OR l.created_at < $4)
       ORDER BY l.created_at DESC LIMIT $5`,
      [q.action ?? null, q.adminId ?? null, q.tenantId ?? null, q.before ?? null, q.limit],
    );
    return r.rows.map((x) => ({ ...x, id: String(x.id) }));
  });

  // ---- Revenue ----
  app.get("/platform/revenue", g("revenue"), async (req) => {
    const { months } = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }).parse(req.query);
    const r = await app.db.query(
      `WITH m AS (SELECT generate_series(date_trunc('month', now()) - make_interval(months => $1 - 1), date_trunc('month', now()), interval '1 month') AS month)
       SELECT to_char(m.month, 'YYYY-MM') AS month,
         (SELECT COALESCE(sum(amount_minor), 0) FROM subscription_payments sp WHERE date_trunc('month', sp.created_at) = m.month)::bigint AS collected,
         (SELECT COALESCE(sum(discount_minor), 0) FROM subscription_payments sp WHERE date_trunc('month', sp.created_at) = m.month)::bigint AS discounts,
         (SELECT count(*) FROM subscription_payments sp WHERE date_trunc('month', sp.created_at) = m.month)::int AS payments,
         (SELECT count(*) FROM tenants t WHERE date_trunc('month', t.created_at) = m.month)::int AS signups,
         (SELECT count(DISTINCT sp.tenant_id) FROM subscription_payments sp WHERE date_trunc('month', sp.created_at) = m.month
            AND EXISTS (SELECT 1 FROM subscription_payments o WHERE o.tenant_id = sp.tenant_id AND o.created_at < sp.created_at))::int AS renewals
       FROM m ORDER BY m.month`,
      [months],
    );
    // Paying shops, the grace days included, as the overview counts them.
    const grace = await graceDays(app.db);
    const byPlan = (await app.db.query(
      `SELECT p.code, p.name, count(t.id)::int AS shops,
              (count(t.id) FILTER (WHERE t.status = 'active' AND t.paid_until > now() - make_interval(days => $1)) * p.price_minor)::bigint AS mrr
       FROM plans p LEFT JOIN tenants t ON t.plan_code = p.code GROUP BY p.code, p.name, p.price_minor, p.sort ORDER BY p.sort`,
      [grace],
    )).rows.map((x) => ({ ...x, mrr: Number(x.mrr) }));
    const due = (await app.db.query(
      `SELECT count(*)::int AS n, COALESCE(sum(p.price_minor), 0)::bigint AS minor FROM tenants t JOIN plans p ON p.code = t.plan_code
       WHERE t.status IN ('trial', 'active') AND t.paid_until BETWEEN now() AND now() + interval '30 days'`,
    )).rows[0];
    return {
      months: r.rows.map((x) => ({ ...x, collected: Number(x.collected), discounts: Number(x.discounts) })),
      byPlan,
      mrr: byPlan.reduce((s, p) => s + p.mrr, 0),
      due30: { shops: due.n, minor: Number(due.minor) },
    };
  });

  // ---- Reminders ----
  app.get("/platform/reminders", g("reminders"), async () => {
    const r = await app.db.query(
      `SELECT r.id, r.kind, r.period_end, r.message, r.sent_at, r.channel, r.error, r.created_at, t.id AS tenant_id, t.name AS tenant_name, t.phone
       FROM subscription_reminders r JOIN tenants t ON t.id = r.tenant_id
       WHERE r.sent_at IS NULL OR r.created_at > now() - interval '30 days'
       ORDER BY (r.sent_at IS NULL) DESC, r.created_at DESC LIMIT 200`,
    );
    return r.rows.map((x) => ({ ...x, wa: intlPhone(x.phone) }));
  });
  app.post("/platform/reminders/run", g("reminders"), async (req) => {
    const out = await runReminders(app.db);
    await platformAudit(app.db, { adminId: me(req), action: "reminders.run", data: out });
    return out;
  });
  app.post("/platform/reminders/:id/sent", g("reminders"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { channel } = z.object({ channel: z.enum(["whatsapp", "sms", "skipped"]) }).parse(req.body);
    const r = await app.db.query(`UPDATE subscription_reminders SET sent_at = now(), channel = $2, sent_by = $3 WHERE id = $1 RETURNING tenant_id`, [id, channel, me(req)]);
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    await platformAudit(app.db, { adminId: me(req), tenantId: r.rows[0].tenant_id, action: "reminder.sent", data: { channel } });
    return { ok: true };
  });

  // ---- Invoices ----
  app.get("/platform/payments/:id/invoice", g("payments"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return subscriptionInvoice(app, id);
  });
  app.get("/platform/payments", g("revenue"), async (req) => {
    const q = z.object({ from: z.string().date().optional(), to: z.string().date().optional() }).parse(req.query);
    const r = await app.db.query(
      `SELECT sp.id, sp.invoice_no, sp.created_at, sp.months, sp.bonus_months, sp.amount_minor, sp.discount_minor, sp.coupon_code, sp.method, sp.reference,
              sp.period_from, sp.period_to, sp.plan_code, t.name AS tenant_name, a.name AS agent_name
       FROM subscription_payments sp JOIN tenants t ON t.id = sp.tenant_id LEFT JOIN agents a ON a.id = t.agent_id
       WHERE ($1::date IS NULL OR sp.created_at >= $1) AND ($2::date IS NULL OR sp.created_at < $2::date + 1)
       ORDER BY sp.created_at DESC LIMIT 2000`,
      [q.from ?? null, q.to ?? null],
    );
    return r.rows.map((x) => ({ ...x, invoice_no: Number(x.invoice_no), amount_minor: Number(x.amount_minor), discount_minor: Number(x.discount_minor) }));
  });

  // ---- Coupons ----
  const coupon = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "الكود: حروف إنجليزية وأرقام، 3 إلى 30"),
    kind: z.enum(["percent", "months"]),
    value: z.number().int().min(1).max(100),
    planCode: z.string().nullable().default(null),
    minMonths: z.number().int().min(1).max(36).default(1),
    maxUses: z.number().int().min(1).nullable().default(null),
    validUntil: z.string().datetime().nullable().default(null),
    active: z.boolean().default(true),
    note: z.string().max(200).nullable().default(null),
  });
  app.get("/platform/coupons", g("coupons"), async () => {
    const r = await app.db.query(
      `SELECT c.*, (SELECT COALESCE(sum(discount_minor), 0) FROM subscription_payments sp WHERE sp.coupon_code = c.code)::bigint AS discount_total
       FROM coupons c ORDER BY c.active DESC, c.created_at DESC`,
    );
    return r.rows.map((x) => ({ ...x, discount_total: Number(x.discount_total) }));
  });
  app.post("/platform/coupons", g("coupons"), async (req) => {
    const b = coupon.parse(req.body);
    if (b.kind === "months" && b.value > 12) throw new HttpError(400, "أقصى حد 12 شهر مجاناً");
    const r = await app.db.query(
      `INSERT INTO coupons (code, kind, value, plan_code, min_months, max_uses, valid_until, active, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (code) DO NOTHING RETURNING id`,
      [b.code, b.kind, b.value, b.planCode, b.minMonths, b.maxUses, b.validUntil, b.active, b.note],
    );
    if (!r.rowCount) throw new HttpError(409, "الكود مستعمل");
    await platformAudit(app.db, { adminId: me(req), action: "coupon.add", data: b });
    return { id: r.rows[0].id };
  });
  app.patch("/platform/coupons/:id", g("coupons"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ active: z.boolean().optional(), maxUses: z.number().int().min(1).nullable().optional(), validUntil: z.string().datetime().nullable().optional(), note: z.string().max(200).nullable().optional() }).parse(req.body);
    const r = await app.db.query(
      `UPDATE coupons SET active = COALESCE($2, active),
         max_uses = CASE WHEN $3 THEN $4 ELSE max_uses END,
         valid_until = CASE WHEN $5 THEN $6::timestamptz ELSE valid_until END,
         note = CASE WHEN $7 THEN $8 ELSE note END
       WHERE id = $1 RETURNING code`,
      [id, b.active ?? null, b.maxUses !== undefined, b.maxUses ?? null, b.validUntil !== undefined, b.validUntil ?? null, b.note !== undefined, b.note ?? null],
    );
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    await platformAudit(app.db, { adminId: me(req), action: "coupon.edit", data: { code: r.rows[0].code, ...b } });
    return { ok: true };
  });

  // ---- Agents ----
  const agentStats = `
    SELECT a.*,
      (SELECT count(*) FROM tenants t WHERE t.agent_id = a.id)::int AS shops,
      (SELECT count(*) FROM tenants t WHERE t.agent_id = a.id AND t.status = 'active' AND t.paid_until > now())::int AS paying,
      (SELECT COALESCE(sum(sp.amount_minor), 0) FROM subscription_payments sp JOIN tenants t ON t.id = sp.tenant_id WHERE t.agent_id = a.id)::bigint AS collected,
      (SELECT COALESCE(sum(amount_minor), 0) FROM agent_payouts p WHERE p.agent_id = a.id)::bigint AS paid
    FROM agents a`;
  const withMoney = (x: Record<string, unknown>) => {
    const collected = Number(x.collected);
    const earned = Math.round((collected * Number(x.commission_bp)) / 10000);
    return { ...x, collected, paid: Number(x.paid), earned, balance: earned - Number(x.paid) };
  };
  app.get("/platform/agents", g("agents"), async () => {
    const r = await app.db.query(`${agentStats} ORDER BY a.active DESC, a.name`);
    return r.rows.map(withMoney);
  });
  const agentBody = z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().max(40).nullable().default(null),
    city: z.string().max(60).nullable().default(null),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,12}$/, "الكود: حروف إنجليزية وأرقام، 3 إلى 12"),
    commissionPct: z.number().min(0).max(100),
    active: z.boolean().default(true),
  });
  app.post("/platform/agents", g("agents"), async (req) => {
    const b = agentBody.parse(req.body);
    const r = await app.db.query(
      `INSERT INTO agents (name, phone, city, code, commission_bp, active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING id`,
      [b.name, b.phone, b.city, b.code, Math.round(b.commissionPct * 100), b.active],
    );
    if (!r.rowCount) throw new HttpError(409, "الكود مستعمل");
    await platformAudit(app.db, { adminId: me(req), action: "agent.add", data: b });
    return { id: r.rows[0].id };
  });
  app.put("/platform/agents/:id", g("agents"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = agentBody.parse(req.body);
    const r = await app.db.query(
      `UPDATE agents SET name = $2, phone = $3, city = $4, code = $5, commission_bp = $6, active = $7 WHERE id = $1 RETURNING id`,
      [id, b.name, b.phone, b.city, b.code, Math.round(b.commissionPct * 100), b.active],
    ).catch((e) => {
      if (String(e.message).includes("unique") || e.code === "23505") throw new HttpError(409, "الكود مستعمل");
      throw e;
    });
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    await platformAudit(app.db, { adminId: me(req), action: "agent.edit", data: { id, ...b } });
    return { ok: true };
  });
  app.post("/platform/agents/:id/payouts", g("agents"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ amountMinor: z.number().int().positive(), note: z.string().max(200).optional() }).parse(req.body);
    await app.db.query(`INSERT INTO agent_payouts (agent_id, amount_minor, note, paid_by) VALUES ($1,$2,$3,$4)`, [id, b.amountMinor, b.note ?? null, me(req)]);
    await platformAudit(app.db, { adminId: me(req), action: "agent.payout", data: { id, ...b } });
    return { ok: true };
  });
  app.get("/platform/agents/:id", g("agents"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return agentDetail(id);
  });
  /** An agent signed in sees their own page: shops, what they paid, what is owed to them. */
  app.get("/platform/agent/me", g(), async (req) => {
    if (!req.platform!.agentId) throw new HttpError(404, "هذا الحساب مش مربوط بوكيل");
    return agentDetail(req.platform!.agentId);
  });
  async function agentDetail(id: string) {
    const a = (await app.db.query(`${agentStats} WHERE a.id = $1`, [id])).rows[0];
    if (!a) throw new HttpError(404, "غير موجود");
    const shops = (await app.db.query(
      `SELECT t.id, t.name, t.status, t.paid_until, t.created_at, t.plan_code,
              (SELECT COALESCE(sum(amount_minor), 0) FROM subscription_payments sp WHERE sp.tenant_id = t.id)::bigint AS paid
       FROM tenants t WHERE t.agent_id = $1 ORDER BY t.created_at DESC`, [id],
    )).rows.map((x) => ({ ...x, paid: Number(x.paid), commission: Math.round((Number(x.paid) * a.commission_bp) / 10000) }));
    const payouts = (await app.db.query(`SELECT id, amount_minor, note, created_at FROM agent_payouts WHERE agent_id = $1 ORDER BY created_at DESC`, [id])).rows
      .map((x) => ({ ...x, amount_minor: Number(x.amount_minor) }));
    return { agent: withMoney(a), shops, payouts };
  }

  // ---- Announcements ----
  const ann = z.object({
    title: z.string().trim().min(2).max(120),
    body: z.string().max(2000).default(""),
    level: z.enum(["info", "warn", "promo"]).default("info"),
    plans: z.array(z.string()).nullable().default(null),
    tenantIds: z.array(z.string().uuid()).nullable().default(null),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime().nullable().default(null),
    active: z.boolean().default(true),
    alert: z.boolean().default(false),
  });
  app.get("/platform/announcements", g("announce"), async () => {
    const r = await app.db.query(
      `SELECT n.*, (SELECT count(*) FROM announcement_dismissals d WHERE d.announcement_id = n.id)::int AS seen FROM announcements n ORDER BY n.created_at DESC LIMIT 100`,
    );
    return r.rows;
  });
  app.post("/platform/announcements", g("announce"), async (req) => {
    const b = ann.parse(req.body);
    const id = await inTx(app.db, async (tx) => {
      const id = (await tx.query(
        `INSERT INTO announcements (title, body, level, plans, tenant_ids, starts_at, ends_at, active, created_by) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),$7,$8,$9) RETURNING id`,
        [b.title, b.body, b.level, b.plans?.length ? b.plans : null, b.tenantIds?.length ? b.tenantIds : null, b.startsAt, b.endsAt, b.active, me(req)],
      )).rows[0].id as string;
      if (b.alert && b.active) {
        // Also as an alert, so it reaches the owners' phones.
        const shops = (await tx.query(
          `SELECT id FROM tenants WHERE status IN ('trial', 'active') AND ($1::text[] IS NULL OR plan_code = ANY($1)) AND ($2::uuid[] IS NULL OR id = ANY($2))`,
          [b.plans?.length ? b.plans : null, b.tenantIds?.length ? b.tenantIds : null],
        )).rows;
        for (const s of shops) await raiseAlert(tx, { tenantId: s.id, kind: "announcement", title: b.title, body: b.body.slice(0, 300), data: { id } });
      }
      return id;
    });
    if (b.alert && b.active) {
      const shops = (await app.db.query(`SELECT DISTINCT tenant_id FROM alerts WHERE kind = 'announcement' AND data->>'id' = $1`, [id])).rows;
      for (const s of shops) await flushPushes(app.db, s.tenant_id).catch(() => undefined);
    }
    await platformAudit(app.db, { adminId: me(req), action: "announcement.add", data: { id, title: b.title } });
    return { id };
  });
  app.put("/platform/announcements/:id", g("announce"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = ann.parse(req.body);
    const r = await app.db.query(
      `UPDATE announcements SET title = $2, body = $3, level = $4, plans = $5, tenant_ids = $6, starts_at = COALESCE($7::timestamptz, starts_at), ends_at = $8, active = $9 WHERE id = $1`,
      [id, b.title, b.body, b.level, b.plans?.length ? b.plans : null, b.tenantIds?.length ? b.tenantIds : null, b.startsAt, b.endsAt, b.active],
    );
    if (!r.rowCount) throw new HttpError(404, "غير موجود");
    await platformAudit(app.db, { adminId: me(req), action: "announcement.edit", data: { id, active: b.active } });
    return { ok: true };
  });
  app.delete("/platform/announcements/:id", g("announce"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`DELETE FROM announcements WHERE id = $1`, [id]);
    await platformAudit(app.db, { adminId: me(req), action: "announcement.delete", data: { id } });
    return { ok: true };
  });

  // ---- Support tickets ----
  app.get("/platform/tickets", g("tickets"), async (req) => {
    const { status } = z.object({ status: z.enum(["open", "answered", "closed", "all"]).default("open") }).parse(req.query);
    const r = await app.db.query(
      `SELECT k.id, k.number, k.subject, k.status, k.created_at, k.updated_at, t.id AS tenant_id, t.name AS tenant_name, t.phone,
              a.name AS assigned_name, (SELECT count(*) FROM support_messages m WHERE m.ticket_id = k.id)::int AS messages
       FROM support_tickets k JOIN tenants t ON t.id = k.tenant_id LEFT JOIN platform_admins a ON a.id = k.assigned_to
       WHERE $1 = 'all' OR k.status = $1 ORDER BY k.updated_at DESC LIMIT 200`,
      [status],
    );
    const counts = (await app.db.query(`SELECT status, count(*)::int AS n FROM support_tickets GROUP BY status`)).rows;
    return { rows: r.rows.map((x) => ({ ...x, number: Number(x.number) })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });
  app.get("/platform/tickets/:id", g("tickets"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return ticketView(app.db, id, null);
  });
  app.post("/platform/tickets/:id/reply", g("tickets"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body, close } = z.object({ body: z.string().trim().min(1).max(5000), close: z.boolean().default(false) }).parse(req.body);
    const k = (await app.db.query(`SELECT tenant_id, number, subject FROM support_tickets WHERE id = $1`, [id])).rows[0];
    if (!k) throw new HttpError(404, "غير موجود");
    await inTx(app.db, async (tx) => {
      await tx.query(`INSERT INTO support_messages (ticket_id, author, admin_id, body) VALUES ($1, 'platform', $2, $3)`, [id, me(req), body]);
      await tx.query(`UPDATE support_tickets SET status = $2, updated_at = now(), assigned_to = COALESCE(assigned_to, $3) WHERE id = $1`, [id, close ? "closed" : "answered", me(req)]);
      await raiseAlert(tx, { tenantId: k.tenant_id, kind: "support_reply", title: `رد على طلب الدعم #${k.number}`, body: `${k.subject}: ${body.slice(0, 200)}`, data: { ticket: id } });
    });
    await flushPushes(app.db, k.tenant_id).catch(() => undefined);
    await platformAudit(app.db, { adminId: me(req), tenantId: k.tenant_id, action: "ticket.reply", data: { number: Number(k.number), close } });
    return { ok: true };
  });
  app.patch("/platform/tickets/:id", g("tickets"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(["open", "answered", "closed"]).optional(), assignedTo: z.string().uuid().nullable().optional() }).parse(req.body);
    await app.db.query(
      `UPDATE support_tickets SET status = COALESCE($2, status), assigned_to = CASE WHEN $3 THEN $4::uuid ELSE assigned_to END, updated_at = now() WHERE id = $1`,
      [id, b.status ?? null, b.assignedTo !== undefined, b.assignedTo ?? null],
    );
    return { ok: true };
  });

  // ---- Support access: look at a shop, read only, while its owner allows it ----
  app.post("/platform/tenants/:id/support-login", g("support"), async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = (await app.db.query(`SELECT support_until FROM tenants WHERE id = $1`, [id])).rows[0];
    if (!t) throw new HttpError(404, "غير موجود");
    if (!t.support_until || new Date(t.support_until).getTime() < Date.now()) throw new HttpError(403, "صاحب المحل ما سمحش بالدعم. يفعّلها من «الدعم الفني» في حسابه");
    const owner = (await app.db.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND active ORDER BY created_at LIMIT 1`, [id])).rows[0];
    if (!owner) throw new HttpError(404, "المحل بدون مالك");
    const left = Math.max(60, Math.min(3600, Math.floor((new Date(t.support_until).getTime() - Date.now()) / 1000)));
    const token = app.jwt.sign({ sub: owner.id, tid: id, role: "owner", ro: true, imp: me(req) }, { expiresIn: left });
    await platformAudit(app.db, { adminId: me(req), tenantId: id, action: "support.login" });
    // The shop sees it in its own log too.
    await audit(app.db, { tenantId: id, userId: owner.id, action: "support.login", entity: "tenant", data: { by: req.platform!.name, minutes: Math.round(left / 60) } });
    return { token, expiresIn: left };
  });
}

/** One ticket and its messages; `tenantId` limits it to that shop. */
export async function ticketView(db: Db, id: string, tenantId: string | null) {
  const k = (await db.query(
    `SELECT k.id, k.number, k.subject, k.status, k.created_at, k.updated_at, k.tenant_id, t.name AS tenant_name, t.phone, t.support_until
     FROM support_tickets k JOIN tenants t ON t.id = k.tenant_id WHERE k.id = $1 AND ($2::uuid IS NULL OR k.tenant_id = $2)`,
    [id, tenantId],
  )).rows[0];
  if (!k) throw new HttpError(404, "غير موجود");
  const msgs = (await db.query(
    `SELECT m.id, m.author, m.body, m.created_at, COALESCE(u.name, a.name) AS name
     FROM support_messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN platform_admins a ON a.id = m.admin_id
     WHERE m.ticket_id = $1 ORDER BY m.created_at`, [id],
  )).rows;
  return { ...k, number: Number(k.number), messages: msgs };
}
