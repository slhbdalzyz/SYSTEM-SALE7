import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth";
import { audit, inTx } from "../db";
import { daysLeft, graceDays, planLimits, recordSubscriptionPayment, subState, usage } from "../billing";
import { GatewayError, PAY_METHODS, getGateway, lyd } from "../payments/gateway";

const startSchema = z.object({
  planCode: z.string().min(1),
  months: z.number().int().min(1).max(12),
  method: z.enum(PAY_METHODS),
  mobile: z.string().regex(/^09\d{8}$/).optional(),
  birthYear: z.string().regex(/^(19|20)\d{2}$/).optional(),
});

/** Where the card gateway sends the customer back: PUBLIC_URL when set, else this request's own host. */
function publicBase(req: FastifyRequest) {
  const env = typeof process !== "undefined" ? process.env.PUBLIC_URL : undefined;
  if (env) return env.replace(/\/$/, "");
  return `${req.protocol}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

const asGatewayError = (e: unknown) => (e instanceof GatewayError ? new HttpError(402, e.message) : e);

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

  const owners = { preHandler: requireRole("owner") };

  /** Which online methods this server offers, and the plans to pick from. */
  app.get("/subscription/pay/options", owners, async () => {
    const g = getGateway();
    const plans = await app.db.query(`SELECT code, name, price_minor FROM plans WHERE active ORDER BY sort, price_minor`);
    return { methods: g?.methods ?? [], test: g?.test ?? false, plans: plans.rows };
  });

  /**
   * Starts an online payment. Cards go to the gateway's page and come back to /billing/plutu/return;
   * Sadad and Edfali text a code to the customer, who sends it to /subscription/pay/:id/confirm.
   */
  app.post("/subscription/pay/start", owners, async (req) => {
    const g = getGateway();
    const b = startSchema.parse(req.body);
    if (!g || !g.methods.includes(b.method)) throw new HttpError(400, "طريقة الدفع هذي مش متاحة");
    const t = (await app.db.query(`SELECT status FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    if (t.status === "suspended" || t.status === "cancelled") throw new HttpError(403, "الحساب موقوف. تواصل معانا باش نرجعوه");
    const plan = (await app.db.query(`SELECT price_minor FROM plans WHERE code = $1 AND active`, [b.planCode])).rows[0];
    if (!plan) throw new HttpError(400, "الباقة غير موجودة");
    const amountMinor = Number(plan.price_minor) * b.months;
    const amount = lyd(amountMinor);
    const invoiceNo = `S7${Date.now().toString(36).toUpperCase()}${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    if (b.method !== "localbankcards" && !b.mobile) throw new HttpError(400, "اكتب رقم الهاتف");
    if (b.method === "sadad" && !b.birthYear) throw new HttpError(400, "اكتب سنة الميلاد");
    const id = (await app.db.query(
      `INSERT INTO payment_intents (tenant_id, plan_code, months, amount_minor, provider, method, invoice_no, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.tid, b.planCode, b.months, amountMinor, g.name, b.method, invoiceNo, req.user.sub],
    )).rows[0].id as string;
    try {
      if (b.method === "localbankcards") {
        const r = await g.checkout(b.method, amount, invoiceNo, `${publicBase(req)}/api/billing/plutu/return`);
        return { id, amountMinor, redirectUrl: r.redirectUrl };
      }
      const r = await g.sendOtp(b.method, amount, b.mobile!, b.birthYear);
      await app.db.query(`UPDATE payment_intents SET process_id = $2, updated_at = now() WHERE id = $1`, [id, r.processId]);
      return { id, amountMinor, needsCode: true };
    } catch (e) {
      await app.db.query(`UPDATE payment_intents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [id, (e as Error).message]);
      throw asGatewayError(e);
    }
  });

  /** The code the customer got by SMS completes a Sadad or Edfali payment. */
  app.post("/subscription/pay/:id/confirm", owners, async (req) => {
    const g = getGateway();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { code } = z.object({ code: z.string().regex(/^\d{4,8}$/) }).parse(req.body);
    const intent = (await app.db.query(`SELECT * FROM payment_intents WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!intent) throw new HttpError(404, "العملية غير موجودة");
    if (intent.status !== "pending" || !intent.process_id) throw new HttpError(409, intent.status === "paid" ? "العملية مدفوعة من قبل" : "العملية انتهت، ابدا من جديد");
    if (!g) throw new HttpError(400, "الدفع الإلكتروني مش متاح");
    let tx: { transactionId: string };
    try {
      tx = await g.confirmOtp(intent.method, intent.process_id, code, lyd(Number(intent.amount_minor)), intent.invoice_no);
    } catch (e) {
      await app.db.query(`UPDATE payment_intents SET error = $2, updated_at = now() WHERE id = $1`, [id, (e as Error).message]);
      throw asGatewayError(e);
    }
    return settle(app, id, tx.transactionId);
  });

  app.get("/subscription/pay/:id", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = (await app.db.query(`SELECT id, status, method, amount_minor, months, plan_code, error, created_at FROM payment_intents WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!r) throw new HttpError(404, "العملية غير موجودة");
    return r;
  });

  /**
   * The card gateway sends the customer's browser here when they pay or cancel. The query is
   * signed; only a valid signature for a pending intent of the same amount marks it paid.
   */
  app.get("/billing/plutu/return", async (req, reply) => {
    const g = getGateway();
    const raw = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    const back = (result: string) => reply.redirect(`${publicBase(req)}/?app=admin&payment=${result}`);
    const r = g?.verifyReturn(raw);
    if (!r) {
      req.log?.warn?.({ raw }, "payment return with a bad signature");
      return back("invalid");
    }
    const intent = (await app.db.query(`SELECT id, status, amount_minor FROM payment_intents WHERE invoice_no = $1`, [r.invoiceNo])).rows[0];
    if (!intent) return back("invalid");
    if (intent.status === "paid") return back("ok");
    if (intent.status !== "pending") return back("failed");
    if (r.canceled || !r.approved) {
      await app.db.query(`UPDATE payment_intents SET status = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`, [intent.id, r.canceled ? "canceled" : "failed"]);
      return back(r.canceled ? "canceled" : "failed");
    }
    if (r.amount === null || Math.round(Number(r.amount) * 1000) !== Number(intent.amount_minor)) {
      await app.db.query(`UPDATE payment_intents SET status = 'failed', error = 'amount mismatch', updated_at = now() WHERE id = $1`, [intent.id]);
      return back("failed");
    }
    await settle(app, intent.id, r.transactionId ?? "");
    return back("ok");
  });
}

/** Turns a confirmed intent into a subscription payment, once, however many times the gateway calls back. */
async function settle(app: FastifyInstance, intentId: string, transactionId: string) {
  return inTx(app.db, async (tx) => {
    const i = (await tx.query(`SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE`, [intentId])).rows[0];
    if (i.status === "paid") return { ok: true, already: true };
    const p = await recordSubscriptionPayment(tx, i.tenant_id, {
      planCode: i.plan_code, months: i.months, amountMinor: Number(i.amount_minor), method: "online",
      reference: `${i.provider}:${i.method}:${transactionId}`, recordedBy: null,
    });
    await tx.query(`UPDATE payment_intents SET status = 'paid', transaction_id = $2, payment_id = $3, error = NULL, updated_at = now() WHERE id = $1`, [intentId, transactionId, p.id]);
    await audit(tx, { tenantId: i.tenant_id, userId: i.user_id, action: "subscription.paid_online", entity: "payment", entityId: p.id, data: { method: i.method, amountMinor: Number(i.amount_minor), months: i.months } });
    return { ok: true, paidUntil: p.paidUntil.toISOString() };
  });
}
