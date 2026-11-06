import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requirePerm } from "../auth";
import { saveProduct } from "./catalog";

/**
 * Moving a shop from paper: its items with what is on the shelves, its customers with what they
 * already owe, its suppliers with what the shop owes them. Rows come from a spreadsheet the
 * owner filled in; a row that can't go in is reported back and the rest still go in.
 */
const text = (max: number) => z.string().trim().max(max);
const money = z.number().int().min(-1e12).max(1e12);

const productRow = z.object({
  name: text(200).min(1),
  barcode: text(64).optional(),
  category: text(80).optional(),
  unit: text(40).optional(),
  priceMinor: z.number().int().min(0).max(1e12).default(0),
  costMinor: z.number().int().min(0).max(1e12).default(0),
  qtyMilli: z.number().int().min(0).max(1e12).default(0),
  minStockMilli: z.number().int().min(0).max(1e12).default(0),
  weighted: z.boolean().default(false),
});
const customerRow = z.object({ name: text(120).min(1), phone: text(40).optional(), balanceMinor: money.default(0), creditLimitMinor: z.number().int().min(0).max(1e12).nullable().optional() });
const supplierRow = z.object({ name: text(120).min(1), phone: text(40).optional(), balanceMinor: money.default(0) });

type Skip = { row: number; reason: string };

export async function importRoutes(app: FastifyInstance) {
  const heavy = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, bodyLimit: 4 * 1024 * 1024 };

  app.post("/import/products", { ...heavy, preHandler: requirePerm("products") }, async (req) => {
    const b = z.object({ storeId: z.string().uuid(), rows: z.array(productRow).min(1).max(3000) }).parse(req.body);
    const tid = req.user.tid;
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
    const out = await inTx(app.db, async (tx) => {
      const skipped: Skip[] = [];
      const codes = new Set((await tx.query(`SELECT code FROM barcodes WHERE tenant_id = $1`, [tid])).rows.map((r) => r.code as string));
      const names = new Set((await tx.query(`SELECT lower(name) AS n FROM products WHERE tenant_id = $1`, [tid])).rows.map((r) => r.n as string));
      const cats = new Map((await tx.query(`SELECT id, name FROM categories WHERE tenant_id = $1`, [tid])).rows.map((r) => [String(r.name).trim(), r.id as string]));
      let created = 0, newCats = 0, stocked = 0;
      for (const [i, r] of b.rows.entries()) {
        const code = r.barcode?.replace(/\s/g, "") || "";
        if (code && codes.has(code)) { skipped.push({ row: i + 1, reason: `الباركود ${code} موجود` }); continue; }
        if (!code && names.has(r.name.toLowerCase())) { skipped.push({ row: i + 1, reason: "صنف بنفس الاسم موجود" }); continue; }
        let categoryId: string | null = null;
        if (r.category) {
          categoryId = cats.get(r.category) ?? null;
          if (!categoryId) {
            categoryId = (await tx.query(`INSERT INTO categories (tenant_id, name, sort) VALUES ($1,$2,(SELECT COALESCE(max(sort),0)+1 FROM categories WHERE tenant_id = $1)) RETURNING id`, [tid, r.category])).rows[0].id as string;
            cats.set(r.category, categoryId);
            newCats++;
          }
        }
        const pid = await saveProduct(tx, tid, null, {
          name: r.name, categoryId, isWeighted: r.weighted, autoCode: true, costMinor: r.costMinor, minStockMilli: r.minStockMilli,
          units: [{ name: r.unit || (r.weighted ? "كيلو" : "حبة"), factorMilli: 1000, priceMinor: r.priceMinor, isBase: true, barcodes: code && !r.weighted ? [code] : [] }],
        });
        if (code) codes.add(code);
        names.add(r.name.toLowerCase());
        created++;
        if (r.qtyMilli > 0) {
          await tx.query(
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note, user_id) VALUES ($1,$2,$3,$4,'adjust','رصيد أول المدة',$5)`,
            [tid, b.storeId, pid, r.qtyMilli, req.user.sub],
          );
          stocked++;
        }
      }
      return { created, stocked, newCategories: newCats, skipped };
    });
    await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "import.products", data: { created: out.created, stocked: out.stocked, skipped: out.skipped.length } });
    return out;
  });

  app.post("/import/customers", { ...heavy, preHandler: requirePerm("customers") }, async (req) => {
    const b = z.object({ rows: z.array(customerRow).min(1).max(5000) }).parse(req.body);
    const tid = req.user.tid;
    const out = await inTx(app.db, async (tx) => {
      const skipped: Skip[] = [];
      const phones = new Set((await tx.query(`SELECT phone FROM customers WHERE tenant_id = $1 AND phone IS NOT NULL`, [tid])).rows.map((r) => r.phone as string));
      let created = 0, owed = 0;
      for (const [i, r] of b.rows.entries()) {
        const phone = r.phone?.replace(/[\s-]/g, "") || null;
        if (phone && phones.has(phone)) { skipped.push({ row: i + 1, reason: `الرقم ${phone} مسجل لعميل` }); continue; }
        await tx.query(
          `INSERT INTO customers (tenant_id, name, phone, credit_limit_minor, opening_balance_minor) VALUES ($1,$2,$3,$4,$5)`,
          [tid, r.name, phone, r.creditLimitMinor ?? null, r.balanceMinor],
        );
        if (phone) phones.add(phone);
        created++;
        owed += r.balanceMinor;
      }
      return { created, totalMinor: owed, skipped };
    });
    await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "import.customers", data: { created: out.created, totalMinor: out.totalMinor, skipped: out.skipped.length } });
    return out;
  });

  app.post("/import/suppliers", { ...heavy, preHandler: requirePerm("purchasing") }, async (req) => {
    const b = z.object({ rows: z.array(supplierRow).min(1).max(2000) }).parse(req.body);
    const tid = req.user.tid;
    const out = await inTx(app.db, async (tx) => {
      const skipped: Skip[] = [];
      const names = new Set((await tx.query(`SELECT lower(name) AS n FROM suppliers WHERE tenant_id = $1`, [tid])).rows.map((r) => r.n as string));
      let created = 0, owed = 0;
      for (const [i, r] of b.rows.entries()) {
        if (names.has(r.name.toLowerCase())) { skipped.push({ row: i + 1, reason: "مورد بنفس الاسم موجود" }); continue; }
        await tx.query(`INSERT INTO suppliers (tenant_id, name, phone, opening_balance_minor) VALUES ($1,$2,$3,$4)`, [tid, r.name, r.phone?.replace(/[\s-]/g, "") || null, r.balanceMinor]);
        names.add(r.name.toLowerCase());
        created++;
        owed += r.balanceMinor;
      }
      return { created, totalMinor: owed, skipped };
    });
    await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "import.suppliers", data: { created: out.created, totalMinor: out.totalMinor, skipped: out.skipped.length } });
    return out;
  });

  /** Sets what one customer or supplier owed before the system (typed in by hand, not imported). */
  app.put("/customers/:id/opening", { preHandler: requirePerm("customers") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { balanceMinor } = z.object({ balanceMinor: money }).parse(req.body);
    const r = await app.db.query(`UPDATE customers SET opening_balance_minor = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, req.user.tid, balanceMinor]);
    if (!r.rowCount) throw new HttpError(404, "العميل غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "customer.opening", entity: "customer", entityId: id, data: { balanceMinor } });
    return { ok: true };
  });
  app.put("/suppliers/:id/opening", { preHandler: requirePerm("purchasing") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { balanceMinor } = z.object({ balanceMinor: money }).parse(req.body);
    const r = await app.db.query(`UPDATE suppliers SET opening_balance_minor = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, req.user.tid, balanceMinor]);
    if (!r.rowCount) throw new HttpError(404, "المورد غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "supplier.opening", entity: "supplier", entityId: id, data: { balanceMinor } });
    return { ok: true };
  });

  /** Where a shop moving from paper has got to: one tick per step. */
  app.get("/import/status", { preHandler: requirePerm("products", "customers", "purchasing") }, async (req) => {
    const tid = req.user.tid;
    const r = (await app.db.query(
      `SELECT (SELECT count(*)::int FROM products WHERE tenant_id = $1) AS products,
              (SELECT count(DISTINCT product_id)::int FROM stock_movements WHERE tenant_id = $1) AS stocked,
              (SELECT count(*)::int FROM customers WHERE tenant_id = $1) AS customers,
              (SELECT COALESCE(sum(opening_balance_minor), 0)::bigint FROM customers WHERE tenant_id = $1) AS customers_owe,
              (SELECT count(*)::int FROM suppliers WHERE tenant_id = $1) AS suppliers,
              (SELECT COALESCE(sum(opening_balance_minor), 0)::bigint FROM suppliers WHERE tenant_id = $1) AS suppliers_owed,
              (SELECT count(*)::int FROM money_movements WHERE tenant_id = $1 AND kind = 'opening') AS cash_opening,
              (SELECT count(*)::int FROM sales WHERE tenant_id = $1) AS sales`,
      [tid],
    )).rows[0];
    return { ...r, customers_owe: Number(r.customers_owe), suppliers_owed: Number(r.suppliers_owed) };
  });
}
