// A shop's subscription: what state it is in, what its plan allows, and the lock that
// stops a shop that stopped paying from doing new work. Sales already made at the till
// still sync while locked, so a shop never loses its records.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError, type TokenPayload } from "./auth";
import type { Db, Tx } from "./db";

export type SubState = "trial" | "active" | "grace" | "locked" | "suspended" | "cancelled";

export interface TenantSub {
  id: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  paid_until: Date;
  plan_code: string;
  status_reason: string | null;
}

const DAY = 86_400_000;

export function subState(t: Pick<TenantSub, "status" | "paid_until">, graceDays: number, now = Date.now()): SubState {
  if (t.status === "suspended" || t.status === "cancelled") return t.status;
  const end = new Date(t.paid_until).getTime();
  if (now <= end) return t.status;
  // A trial that ran out locks straight away; a paying shop gets a few days to renew.
  if (t.status === "active" && now <= end + graceDays * DAY) return "grace";
  return "locked";
}

export const isLocked = (s: SubState) => s === "locked" || s === "suspended" || s === "cancelled";

export function daysLeft(paidUntil: Date | string, now = Date.now()) {
  return Math.ceil((new Date(paidUntil).getTime() - now) / DAY);
}

export async function graceDays(q: Db | Tx): Promise<number> {
  const r = await q.query(`SELECT value FROM platform_settings WHERE key = 'grace_days'`);
  return Number(r.rows[0]?.value ?? 7);
}

// Every write checks the shop's state; a short cache keeps that off the database.
const cache = new Map<string, { state: SubState; reason: string | null; at: number }>();
export const forgetTenant = (tid: string) => void cache.delete(tid);

export async function tenantState(db: Db, tid: string): Promise<{ state: SubState; reason: string | null }> {
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < 20_000) return hit;
  const t = (await db.query(`SELECT status, paid_until, status_reason FROM tenants WHERE id = $1`, [tid])).rows[0];
  const v = { state: t ? subState(t, await graceDays(db)) : ("cancelled" as SubState), reason: (t?.status_reason as string | null) ?? null, at: Date.now() };
  cache.set(tid, v);
  return v;
}

export function lockMessage(state: SubState, reason?: string | null) {
  if (state === "suspended") return `الحساب موقوف${reason ? `: ${reason}` : ""}. تواصل معانا.`;
  if (state === "cancelled") return "الحساب ملغي.";
  return "انتهى الاشتراك. جدّد الاشتراك باش يرجع النظام يشتغل.";
}

export async function assertNotLocked(db: Db, tid: string) {
  const s = await tenantState(db, tid);
  if (isLocked(s.state)) throw new HttpError(402, lockMessage(s.state, s.reason));
}

/** Writes that stay open while locked: syncing what the till already did, and signing in to see the bill. */
const OPEN_WHILE_LOCKED = [/^\/auth\//, /^\/sales\/batch$/, /^\/shifts\//, /^\/devices\/events$/, /^\/customers\/[^/]+\/payments$/, /^\/platform\//, /^\/subscription\/pay\//];

/** Rejects a write by a shop that is locked. `verify` reads the caller's token, if there is one. */
export async function checkSubscription(db: Db, method: string, path: string, verify: (() => Promise<TokenPayload>) | null) {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !verify) return;
  if (OPEN_WHILE_LOCKED.some((r) => r.test(path))) return;
  let user: TokenPayload;
  try {
    user = await verify();
  } catch {
    return; // the route's own check answers 401
  }
  if (user.tid) await assertNotLocked(db, user.tid);
}

export function subscriptionGuard(app: FastifyInstance) {
  app.addHook("preHandler", async (req: FastifyRequest) => {
    await checkSubscription(app.db, req.method, req.url.split("?")[0], req.headers.authorization ? () => req.jwtVerify<TokenPayload>() : null);
  });
}

export async function planLimits(q: Db | Tx, tid: string) {
  return (await q.query(
    `SELECT p.code, p.name, p.max_stores, p.max_devices, p.max_users FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1`,
    [tid],
  )).rows[0] as { code: string; name: string; max_stores: number; max_devices: number; max_users: number };
}

export async function usage(q: Db | Tx, tid: string) {
  return (await q.query(
    `SELECT (SELECT count(*)::int FROM stores WHERE tenant_id = $1) AS stores,
            (SELECT count(*)::int FROM devices WHERE tenant_id = $1 AND active) AS devices,
            (SELECT count(*)::int FROM users WHERE tenant_id = $1 AND active) AS users`,
    [tid],
  )).rows[0] as { stores: number; devices: number; users: number };
}

export async function assertWithinPlan(q: Db | Tx, tid: string, what: "devices" | "users" | "stores") {
  const [l, u] = await Promise.all([planLimits(q, tid), usage(q, tid)]);
  const max = { devices: l.max_devices, users: l.max_users, stores: l.max_stores }[what];
  const label = { devices: "الأجهزة", users: "المستخدمين", stores: "الفروع" }[what];
  if (u[what] >= max) throw new HttpError(402, `باقة «${l.name}» تسمح بـ ${max} من ${label} بس. رقّي الباقة باش تزيد.`);
}

/**
 * Records money received for a subscription and moves the paid-up date forward from where it
 * was, or from today for a shop that had already locked. Used by platform staff and by online payments.
 */
export async function recordSubscriptionPayment(
  tx: Tx,
  tenantId: string,
  p: { planCode?: string; months: number; amountMinor?: number; method: "cash" | "bank" | "card" | "other" | "online"; reference?: string | null; recordedBy: string | null },
) {
  const t = (await tx.query(`SELECT id, plan_code, paid_until FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId])).rows[0];
  if (!t) throw new HttpError(404, "المحل غير موجود");
  const planCode = p.planCode ?? t.plan_code;
  const plan = (await tx.query(`SELECT price_minor FROM plans WHERE code = $1`, [planCode])).rows[0];
  if (!plan) throw new HttpError(400, "الباقة غير موجودة");
  // Days used during the grace period are paid for; a shop that was locked starts from today.
  const end = new Date(t.paid_until).getTime();
  const inGrace = Date.now() - end <= (await graceDays(tx)) * 86_400_000;
  const from = new Date(inGrace ? end : Date.now());
  const to = new Date(from);
  to.setMonth(to.getMonth() + p.months);
  const amount = p.amountMinor ?? plan.price_minor * p.months;
  const r = await tx.query(
    `INSERT INTO subscription_payments (tenant_id, plan_code, months, amount_minor, method, reference, period_from, period_to, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, planCode, p.months, amount, p.method, p.reference ?? null, from, to, p.recordedBy],
  );
  await tx.query(`UPDATE tenants SET status = 'active', status_reason = NULL, plan_code = $2, paid_until = $3 WHERE id = $1`, [tenantId, planCode, to]);
  forgetTenant(tenantId);
  return { id: r.rows[0].id as string, paidUntil: to, amountMinor: amount, planCode };
}
