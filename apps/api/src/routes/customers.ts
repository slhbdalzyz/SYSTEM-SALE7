import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { customerInputSchema, type CatalogCustomer } from "@pos/shared";
import { audit } from "../db";
import { HttpError, authenticate, requireDevice, requireRole } from "../auth";

function conflict(e: unknown): never {
  const err = e as { code?: string };
  if (err.code === "23505") throw new HttpError(409, "رقم الهاتف مسجل لعميل ثاني");
  throw e;
}

export async function customerRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };

  async function list(tenantId: string, q?: string, id?: string): Promise<CatalogCustomer[]> {
    const r = await app.db.query(
      `SELECT c.id, c.name, c.phone, c.credit_limit_minor, c.active, b.balance_minor
       FROM customers c JOIN customer_balances b ON b.customer_id = c.id
       WHERE c.tenant_id = $1 AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.phone LIKE '%' || $2 || '%')
         AND ($3::uuid IS NULL OR c.id = $3)
       ORDER BY c.name LIMIT 1000`,
      [tenantId, q ?? null, id ?? null],
    );
    return r.rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, creditLimitMinor: c.credit_limit_minor, balanceMinor: c.balance_minor, active: c.active }));
  }

  /** Devices keep this list for picking a customer and checking credit while offline. */
  app.get("/customers", { preHandler: authenticate }, async (req) => {
    const { q } = z.object({ q: z.string().max(60).optional() }).parse(req.query);
    return list(req.user.tid, q);
  });

  /** Cashiers can add a customer at the counter; only managers set or change credit limits. */
  app.post("/customers", { preHandler: authenticate }, async (req) => {
    const b = customerInputSchema.parse(req.body);
    const limit = req.user.role === "cashier" ? 0 : (b.creditLimitMinor ?? null);
    try {
      const r = await app.db.query(
        `INSERT INTO customers (tenant_id, name, phone, note, credit_limit_minor) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.user.tid, b.name, b.phone ?? null, b.note ?? null, limit],
      );
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: "customer.create", entity: "customer", entityId: r.rows[0].id, data: { name: b.name, creditLimit: limit } });
      return (await list(req.user.tid, undefined, r.rows[0].id))[0];
    } catch (e) {
      conflict(e);
    }
  });

  app.patch("/customers/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = customerInputSchema.partial().parse(req.body);
    const before = (await list(req.user.tid, undefined, id))[0];
    if (!before) throw new HttpError(404, "العميل غير موجود");
    try {
      await app.db.query(
        `UPDATE customers SET name = COALESCE($3, name), phone = CASE WHEN $4 THEN $5 ELSE phone END, note = COALESCE($6, note),
           credit_limit_minor = CASE WHEN $7 THEN $8 ELSE credit_limit_minor END, active = COALESCE($9, active), updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [id, req.user.tid, b.name ?? null, "phone" in b, b.phone ?? null, b.note ?? null, "creditLimitMinor" in b, b.creditLimitMinor ?? null, b.active ?? null],
      );
    } catch (e) {
      conflict(e);
    }
    if ("creditLimitMinor" in b && b.creditLimitMinor !== before.creditLimitMinor) {
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "customer.credit_limit", entity: "customer", entityId: id, data: { from: before.creditLimitMinor, to: b.creditLimitMinor } });
    }
    return (await list(req.user.tid, undefined, id))[0];
  });

  /** A customer pays down their balance at the counter. The id comes from the device so a retry is safe. */
  app.post("/customers/:id/payments", { preHandler: requireDevice }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ id: z.string().uuid(), method: z.enum(["cash", "card"]), amountMinor: z.number().int().positive(), shiftId: z.string().uuid().nullable().optional(), note: z.string().max(200).optional() })
      .parse(req.body);
    const c = (await list(req.user.tid, undefined, id))[0];
    if (!c) throw new HttpError(404, "العميل غير موجود");
    if (b.shiftId) {
      const sh = await app.db.query(`SELECT 1 FROM shifts WHERE id = $1 AND tenant_id = $2 AND device_id = $3`, [b.shiftId, req.user.tid, req.user.did]);
      if (!sh.rowCount) throw new HttpError(400, "الوردية غير موجودة على هذا الجهاز");
    }
    const r = await app.db.query(
      `INSERT INTO customer_payments (id, tenant_id, customer_id, store_id, device_id, shift_id, user_id, method, amount_minor, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [b.id, req.user.tid, id, req.user.sid, req.user.did, b.shiftId ?? null, req.user.sub, b.method, b.amountMinor, b.note ?? null],
    );
    if (r.rowCount) {
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: "customer.payment", entity: "customer", entityId: id, data: { amount: b.amountMinor, method: b.method } });
    }
    return (await list(req.user.tid, undefined, id))[0];
  });

  /** Every credit sale, credit refund and payment, oldest first, with a running balance. */
  app.get("/customers/:id/statement", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = (await list(req.user.tid, undefined, id))[0];
    if (!c) throw new HttpError(404, "العميل غير موجود");
    const r = await app.db.query(
      `SELECT * FROM (
         SELECT s.created_at AS at, s.kind AS type, s.number AS ref, p.amount_minor AS amount_minor
         FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.customer_id = $1 AND p.method = 'credit'
         UNION ALL
         SELECT cp.created_at, 'payment', cp.method, -cp.amount_minor FROM customer_payments cp WHERE cp.customer_id = $1
       ) t ORDER BY at`,
      [id],
    );
    let running = 0;
    const entries = r.rows.map((e) => ({ ...e, balance_minor: (running += e.amount_minor) }));
    return { customer: c, entries };
  });
}
