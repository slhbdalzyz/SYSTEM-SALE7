import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { computeLine, installmentSchedule } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, authenticate, requirePerm } from "../auth";

const quoteLine = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  name: z.string().min(1).max(200),
  qtyMilli: z.number().int().positive().max(1e10),
  priceMinor: z.number().int().nonnegative().max(1e12),
  discountMinor: z.number().int().nonnegative().max(1e12).default(0),
  taxBp: z.number().int().min(0).max(10000).default(0),
});
const quoteSchema = z.object({
  storeId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  customerName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  project: z.string().trim().max(80).nullable().optional(),
  lines: z.array(quoteLine).min(1).max(300),
  validDays: z.number().int().min(1).max(365).default(7),
  note: z.string().trim().max(500).nullable().optional(),
});
const kitSchema = z.object({
  name: z.string().trim().min(2).max(80),
  lines: z.array(z.object({ productId: z.string().uuid(), unitId: z.string().uuid(), qtyMilli: z.number().int().positive().max(1e9) })).min(1).max(100),
  active: z.boolean().default(true),
});
const planSchema = z.object({
  customerId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  saleNumber: z.string().trim().max(40).nullable().optional(),
  totalMinor: z.number().int().positive().max(1e12),
  downMinor: z.number().int().nonnegative().max(1e12).default(0),
  count: z.number().int().min(1).max(120),
  firstDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(300).nullable().optional(),
});

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());

function quoteOut(q: Record<string, unknown>) {
  return {
    id: q.id, number: q.number, storeId: q.store_id, customerId: q.customer_id, customerName: q.customer_name ?? q.c_name ?? null, phone: q.phone ?? q.c_phone ?? null,
    project: q.project, lines: q.lines, totalMinor: Number(q.total_minor), validUntil: q.valid_until, note: q.note, status: q.status,
    saleNumber: q.sale_number ?? null, createdAt: q.created_at,
  };
}

/**
 * What many kinds of shop share: price quotes, ready-made lists, instalments and deliveries.
 */
export async function businessRoutes(app: FastifyInstance) {
  const sellers = { preHandler: requirePerm("sales", "customers") };
  const items = { preHandler: requirePerm("products") };

  // ---- Quotes ----
  const quoteSelect = `SELECT q.*, c.name AS c_name, c.phone AS c_phone, s.number AS sale_number FROM quotes q
    LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN sales s ON s.id = q.sale_id`;

  /** A quote, from the till (its cart) or the back office. Priced as the lines say; the sale prices it again. */
  app.post("/quotes", { preHandler: authenticate }, async (req) => {
    const b = quoteSchema.parse(req.body);
    const tid = req.user.tid;
    if (b.customerId && !(await app.db.query(`SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2`, [b.customerId, tid])).rowCount) throw new HttpError(404, "العميل غير موجود");
    const units = await app.db.query(`SELECT u.id, u.product_id FROM product_units u WHERE u.tenant_id = $1 AND u.id = ANY($2::uuid[])`, [tid, b.lines.map((l) => l.unitId)]);
    const known = new Map(units.rows.map((u) => [u.id as string, u.product_id as string]));
    for (const l of b.lines) if (known.get(l.unitId) !== l.productId) throw new HttpError(400, `الصنف غير موجود: ${l.name}`);
    const total = b.lines.reduce((a, l) => a + computeLine({ ...l, promoMinor: 0 }).total, 0);
    const storeId = b.storeId ?? req.user.sid ?? null;
    return inTx(app.db, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`quote:${tid}`]);
      const n = Number((await tx.query(`SELECT COALESCE(max(number), 0) + 1 AS n FROM quotes WHERE tenant_id = $1`, [tid])).rows[0].n);
      const r = await tx.query(
        `INSERT INTO quotes (tenant_id, store_id, number, customer_id, customer_name, phone, project, lines, total_minor, valid_until, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, (now() AT TIME ZONE 'Africa/Tripoli')::date + $10::int, $11, $12) RETURNING id`,
        [tid, storeId, n, b.customerId ?? null, b.customerName || null, b.phone || null, b.project || null, JSON.stringify(b.lines), total, b.validDays, b.note || null, req.user.sub],
      );
      await audit(tx, { tenantId: tid, userId: req.user.sub, deviceId: req.user.did, action: "quote.create", entity: "quote", entityId: r.rows[0].id, data: { number: n, total } });
      return quoteOut((await tx.query(`${quoteSelect} WHERE q.id = $1`, [r.rows[0].id])).rows[0]);
    });
  });

  app.get("/quotes", sellers, async (req) => {
    const q = z.object({ status: z.enum(["open", "sold", "cancelled", "all"]).default("open") }).parse(req.query);
    const r = await app.db.query(`${quoteSelect} WHERE q.tenant_id = $1 AND ($2 = 'all' OR q.status = $2) ORDER BY q.created_at DESC LIMIT 300`, [req.user.tid, q.status]);
    return r.rows.map(quoteOut);
  });

  /** The till opens a quote by its number to sell it. */
  app.get("/quotes/:number", { preHandler: authenticate }, async (req) => {
    const { number } = z.object({ number: z.coerce.number().int().positive() }).parse(req.params);
    const q = (await app.db.query(`${quoteSelect} WHERE q.tenant_id = $1 AND q.number = $2`, [req.user.tid, number])).rows[0];
    if (!q) throw new HttpError(404, "عرض السعر غير موجود");
    if (q.status === "sold") throw new HttpError(400, `عرض السعر هذا انباع بفاتورة ${q.sale_number ?? ""}`);
    if (q.status === "cancelled") throw new HttpError(400, "عرض السعر هذا ملغي");
    return quoteOut(q);
  });

  app.patch("/quotes/:id", sellers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(["open", "cancelled"]) }).parse(req.body);
    const r = await app.db.query(`UPDATE quotes SET status = $3 WHERE id = $1 AND tenant_id = $2 AND status <> 'sold' RETURNING id`, [id, req.user.tid, b.status]);
    if (!r.rowCount) throw new HttpError(400, "عرض السعر مش موجود أو انباع");
    return quoteOut((await app.db.query(`${quoteSelect} WHERE q.id = $1`, [id])).rows[0]);
  });

  // ---- Ready-made lists ----
  const kitList = async (tid: string, all: boolean) =>
    (await app.db.query(
      `SELECT k.id, k.name, k.active, k.lines,
         COALESCE((SELECT json_agg(json_build_object('productId', p.id, 'unitId', u.id, 'name', p.name, 'unitName', u.name, 'qtyMilli', (l.v->>'qtyMilli')::bigint, 'priceMinor', u.price_minor) ORDER BY l.n)
           FROM jsonb_array_elements(k.lines) WITH ORDINALITY AS l(v, n) JOIN product_units u ON u.id = (l.v->>'unitId')::uuid JOIN products p ON p.id = u.product_id WHERE p.active), '[]') AS items
       FROM kits k WHERE k.tenant_id = $1 ${all ? "" : "AND k.active"} ORDER BY k.name`,
      [tid],
    )).rows.map((k) => ({ id: k.id, name: k.name, active: k.active, items: k.items.map((i: { qtyMilli: string | number; priceMinor: string | number }) => ({ ...i, qtyMilli: Number(i.qtyMilli), priceMinor: Number(i.priceMinor) })) }));

  app.get("/kits", { preHandler: authenticate }, async (req) => kitList(req.user.tid, !req.user.did));

  const checkKit = async (tid: string, b: z.infer<typeof kitSchema>) => {
    const r = await app.db.query(`SELECT id, product_id FROM product_units WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, b.lines.map((l) => l.unitId)]);
    const known = new Map(r.rows.map((u) => [u.id as string, u.product_id as string]));
    if (b.lines.some((l) => known.get(l.unitId) !== l.productId)) throw new HttpError(400, "فيه صنف مش موجود في القائمة");
  };
  const kitConflict = (e: unknown): never => {
    if ((e as { code?: string }).code === "23505") throw new HttpError(409, "فيه قائمة بنفس الاسم");
    throw e;
  };

  app.post("/kits", items, async (req) => {
    const b = kitSchema.parse(req.body);
    await checkKit(req.user.tid, b);
    const r = await app.db.query(`INSERT INTO kits (tenant_id, name, lines, active) VALUES ($1,$2,$3,$4) RETURNING id`, [req.user.tid, b.name, JSON.stringify(b.lines), b.active]).catch(kitConflict);
    return { id: r.rows[0].id };
  });

  app.put("/kits/:id", items, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = kitSchema.parse(req.body);
    await checkKit(req.user.tid, b);
    const r = await app.db.query(`UPDATE kits SET name = $3, lines = $4, active = $5, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid, b.name, JSON.stringify(b.lines), b.active]).catch(kitConflict);
    if (!r.rowCount) throw new HttpError(404, "القائمة غير موجودة");
    return { ok: true };
  });

  app.delete("/kits/:id", items, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`DELETE FROM kits WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid]);
    return { ok: true };
  });

  // ---- Instalments ----
  /**
   * Each plan with its monthly payments. What the customer paid since a plan began covers it, the
   * oldest plan first, so one customer with two plans pays the first off before the second.
   */
  async function plans(tid: string, where: { status?: string; customerId?: string; id?: string }) {
    const r = await app.db.query(
      `SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, b.balance_minor
       FROM installment_plans p JOIN customers c ON c.id = p.customer_id JOIN customer_balances b ON b.customer_id = c.id
       WHERE p.tenant_id = $1 AND ($2::text IS NULL OR p.status = $2) AND ($3::uuid IS NULL OR p.customer_id = $3) AND ($4::uuid IS NULL OR p.id = $4)
       ORDER BY p.created_at`,
      [tid, where.status ?? null, where.customerId ?? null, where.id ?? null],
    );
    const customers = [...new Set(r.rows.map((p) => p.customer_id as string))];
    const pays = customers.length
      ? (await app.db.query(`SELECT customer_id, amount_minor, created_at FROM customer_payments WHERE customer_id = ANY($1::uuid[]) ORDER BY created_at`, [customers])).rows
      : [];
    const all = customers.length
      ? (await app.db.query(`SELECT id, customer_id, created_at, total_minor, down_minor FROM installment_plans WHERE customer_id = ANY($1::uuid[]) AND status <> 'cancelled' ORDER BY created_at`, [customers])).rows
      : [];
    // Hand each customer's payments to their plans in order.
    const paidTo = new Map<string, number>();
    for (const c of customers) {
      let pool = pays.filter((x) => x.customer_id === c).reduce((a, x) => a + Number(x.amount_minor), 0);
      const first = all.find((p) => p.customer_id === c);
      if (first) pool -= pays.filter((x) => x.customer_id === c && x.created_at < first.created_at).reduce((a, x) => a + Number(x.amount_minor), 0);
      for (const p of all.filter((x) => x.customer_id === c)) {
        const owed = Number(p.total_minor) - Number(p.down_minor);
        const take = Math.max(0, Math.min(pool, owed));
        paidTo.set(p.id, take);
        pool -= take;
      }
    }
    const t = today();
    return r.rows.map((p) => {
      const paid = paidTo.get(p.id) ?? 0;
      const s = installmentSchedule({ totalMinor: Number(p.total_minor), downMinor: Number(p.down_minor), count: p.count, firstDue: p.first_due instanceof Date ? p.first_due.toISOString().slice(0, 10) : String(p.first_due).slice(0, 10) }, paid, t);
      return {
        id: p.id, customerId: p.customer_id, customerName: p.customer_name, customerPhone: p.customer_phone, balanceMinor: Number(p.balance_minor),
        title: p.title, saleNumber: p.sale_number, totalMinor: Number(p.total_minor), downMinor: Number(p.down_minor), count: p.count, note: p.note, status: p.status,
        createdAt: p.created_at, paidMinor: paid, ...s,
      };
    });
  }

  app.get("/installments", sellers, async (req) => {
    const q = z.object({ status: z.enum(["active", "done", "cancelled", "all"]).default("active"), customerId: z.string().uuid().optional() }).parse(req.query);
    return plans(req.user.tid, { status: q.status === "all" ? undefined : q.status, customerId: q.customerId });
  });

  app.post("/installments", sellers, async (req) => {
    const b = planSchema.parse(req.body);
    if (b.downMinor >= b.totalMinor) throw new HttpError(400, "المقدم لازم أقل من المبلغ الكامل");
    if (!(await app.db.query(`SELECT 1 FROM customers WHERE id = $1 AND tenant_id = $2`, [b.customerId, req.user.tid])).rowCount) throw new HttpError(404, "العميل غير موجود");
    const r = await app.db.query(
      `INSERT INTO installment_plans (tenant_id, customer_id, title, sale_number, total_minor, down_minor, count, first_due, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.user.tid, b.customerId, b.title, b.saleNumber || null, b.totalMinor, b.downMinor, b.count, b.firstDue, b.note || null, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "installments.create", entity: "customer", entityId: b.customerId, data: { title: b.title, total: b.totalMinor, count: b.count } });
    return (await plans(req.user.tid, { id: r.rows[0].id }))[0];
  });

  app.patch("/installments/:id", sellers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(["active", "done", "cancelled"]) }).parse(req.body);
    const r = await app.db.query(`UPDATE installment_plans SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, req.user.tid, b.status]);
    if (!r.rowCount) throw new HttpError(404, "الخطة غير موجودة");
    return (await plans(req.user.tid, { id }))[0];
  });

  // ---- Deliveries ----
  app.get("/deliveries", sellers, async (req) => {
    const q = z.object({ status: z.enum(["pending", "out", "delivered", "all"]).default("pending") }).parse(req.query);
    const r = await app.db.query(
      `SELECT s.id, s.number, s.total_minor, s.created_at, s.delivery, s.project, c.name AS customer_name, c.phone AS customer_phone, st.name AS store_name,
         (SELECT count(*) FROM sale_lines l WHERE l.sale_id = s.id)::int AS items,
         COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id AND p.method = 'credit'), 0)::bigint AS credit_minor
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN stores st ON st.id = s.store_id
       WHERE s.tenant_id = $1 AND s.delivery IS NOT NULL AND ($2 = 'all' OR s.delivery->>'status' = $2)
       ORDER BY s.created_at DESC LIMIT 300`,
      [req.user.tid, q.status],
    );
    return r.rows.map((s) => ({
      id: s.id, number: s.number, totalMinor: Number(s.total_minor), creditMinor: Number(s.credit_minor), createdAt: s.created_at, delivery: s.delivery, project: s.project,
      customerName: s.customer_name, customerPhone: s.customer_phone, storeName: s.store_name, items: s.items,
    }));
  });

  app.patch("/deliveries/:id", sellers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(["pending", "out", "delivered"]), driver: z.string().trim().max(80).optional() }).parse(req.body);
    const patch: Record<string, unknown> = { status: b.status, [`${b.status}At`]: new Date().toISOString() };
    if (b.driver !== undefined) patch.driver = b.driver;
    const r = await app.db.query(`UPDATE sales SET delivery = delivery || $3::jsonb WHERE id = $1 AND tenant_id = $2 AND delivery IS NOT NULL RETURNING number, delivery`, [id, req.user.tid, JSON.stringify(patch)]);
    if (!r.rowCount) throw new HttpError(404, "الفاتورة ما عليهاش توصيل");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "delivery.status", entity: "sale", entityId: id, data: { sale: r.rows[0].number, status: b.status, driver: b.driver } });
    return { delivery: r.rows[0].delivery };
  });

  // ---- A customer's account by building site ----
  app.get("/customers/:id/projects", sellers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(
      `SELECT COALESCE(s.project, '') AS project, count(*)::int AS sales, sum(s.total_minor)::bigint AS total_minor,
         COALESCE(sum((SELECT sum(p.amount_minor) FROM payments p WHERE p.sale_id = s.id AND p.method = 'credit')), 0)::bigint AS credit_minor,
         max(s.created_at) AS last_at
       FROM sales s WHERE s.tenant_id = $1 AND s.customer_id = $2 GROUP BY COALESCE(s.project, '') ORDER BY max(s.created_at) DESC`,
      [req.user.tid, id],
    );
    return r.rows.map((x) => ({ project: x.project, sales: x.sales, totalMinor: Number(x.total_minor), creditMinor: Number(x.credit_minor), lastAt: x.last_at }));
  });
}
