import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth";
import { daysLeft, graceDays, planLimits, subState, usage } from "../billing";

/** What the shop owner sees about their own subscription. */
export async function subscriptionRoutes(app: FastifyInstance) {
  app.get("/subscription", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const tid = req.user.tid;
    const t = (await app.db.query(`SELECT status, status_reason, paid_until FROM tenants WHERE id = $1`, [tid])).rows[0];
    const [plan, used, payments, info, grace] = await Promise.all([
      planLimits(app.db, tid),
      usage(app.db, tid),
      app.db.query(`SELECT months, amount_minor, method, period_from, period_to, created_at, plan_code FROM subscription_payments WHERE tenant_id = $1 ORDER BY created_at DESC`, [tid]),
      app.db.query(`SELECT value FROM platform_settings WHERE key = 'payment_instructions'`),
      graceDays(app.db),
    ]);
    const price = (await app.db.query(`SELECT price_minor FROM plans WHERE code = $1`, [plan.code])).rows[0].price_minor as number;
    return {
      state: subState(t, grace),
      reason: t.status_reason,
      paidUntil: t.paid_until,
      daysLeft: daysLeft(t.paid_until),
      graceDays: grace,
      plan: { ...plan, price_minor: price },
      usage: used,
      payments: payments.rows,
      paymentInstructions: info.rows[0]?.value ?? "",
    };
  });
}
