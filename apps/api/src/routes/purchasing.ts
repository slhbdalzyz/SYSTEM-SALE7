import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requirePerm } from "../auth";

const supplierSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().max(40).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

/** How a supplier is paid. */
const METHODS = ["cash", "card", "transfer", "cheque", "other"] as const;
/** How a supply invoice is settled: on credit (all owed), or paid now by one of these. */
const INVOICE_METHODS = ["credit", "cash", "card", "transfer", "cheque"] as const;

export const purchaseSchema = z.object({
  storeId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  supplierRef: z.string().max(60).optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(300).optional(),
  updateCost: z.boolean().default(true),
  /**
   * credit: nothing paid now, the whole invoice is owed to the supplier. Otherwise paidMinor is
   * paid now by that method (all of it when left out) and the rest is owed.
   * Without a supplier the whole invoice counts as paid.
   */
  paidMinor: z.number().int().nonnegative().optional(),
  paymentMethod: z.enum(INVOICE_METHODS).default("cash"),
  lines: z.array(z.object({
    unitId: z.string().uuid(),
    qtyMilli: z.number().int().positive(),
    unitCostMinor: z.number().int().nonnegative(),
    /** The new selling price, set as the goods come in: of this unit, or of sellUnitId (a box bought, a piece priced). */
    sellPriceMinor: z.number().int().nonnegative().optional(),
    sellUnitId: z.string().uuid().optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1).max(500),
});

export async function purchasingRoutes(app: FastifyInstance) {
  const managers = { preHandler: requirePerm("purchasing") };

  app.get("/suppliers", managers, async (req) => {
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    const r = await app.db.query(
      `SELECT s.id, s.name, s.phone, s.note, s.active, b.balance_minor,
              (SELECT max(created_at) FROM purchase_invoices i WHERE i.supplier_id = s.id) AS last_purchase_at
       FROM suppliers s JOIN supplier_balances b ON b.supplier_id = s.id
       WHERE s.tenant_id = $1 AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%' OR s.phone ILIKE '%' || $2 || '%')
       ORDER BY s.active DESC, s.name`,
      [req.user.tid, q || null],
    );
    return r.rows;
  });

  app.post("/suppliers", managers, async (req) => {
    const b = supplierSchema.parse(req.body);
    const r = await app.db.query(`INSERT INTO suppliers (tenant_id, name, phone, note) VALUES ($1,$2,$3,$4) RETURNING id`, [req.user.tid, b.name, b.phone ?? null, b.note ?? null]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "supplier.create", entity: "supplier", entityId: r.rows[0].id, data: { name: b.name } });
    return { id: r.rows[0].id };
  });

  app.patch("/suppliers/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = supplierSchema.partial().parse(req.body);
    const r = await app.db.query(
      `UPDATE suppliers SET name = COALESCE($3, name), phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
         note = CASE WHEN $6::boolean THEN $7 ELSE note END, active = COALESCE($8, active)
       WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, b.name ?? null, b.phone !== undefined, b.phone ?? null, b.note !== undefined, b.note ?? null, b.active ?? null],
    );
    if (!r.rowCount) throw new HttpError(404, "المورد غير موجود");
    return { ok: true };
  });

  /** Every invoice and payment with a running balance, oldest first. */
  app.get("/suppliers/:id/statement", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const s = (await app.db.query(
      `SELECT s.id, s.name, s.phone, b.balance_minor FROM suppliers s JOIN supplier_balances b ON b.supplier_id = s.id WHERE s.id = $1 AND s.tenant_id = $2`,
      [id, req.user.tid],
    )).rows[0];
    if (!s) throw new HttpError(404, "المورد غير موجود");
    const r = await app.db.query(
      `SELECT * FROM (
         SELECT created_at AS at, 'invoice' AS type, id AS ref_id, COALESCE(supplier_ref, '') AS ref, total_minor AS amount_minor FROM purchase_invoices WHERE supplier_id = $1
         UNION ALL
         SELECT created_at, 'payment', invoice_id, method, -amount_minor FROM supplier_payments WHERE supplier_id = $1
       ) t ORDER BY at, type`, // an invoice and its payment share a timestamp: invoice first
      [id],
    );
    let running = 0;
    return { supplier: s, entries: r.rows.map((e) => ({ ...e, balance_minor: (running += e.amount_minor) })) };
  });

  app.post("/suppliers/:id/payments", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ amountMinor: z.number().int().positive(), method: z.enum(METHODS), note: z.string().max(200).optional() }).parse(req.body);
    const s = await app.db.query(`SELECT 1 FROM suppliers WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid]);
    if (!s.rowCount) throw new HttpError(404, "المورد غير موجود");
    const r = await app.db.query(
      `INSERT INTO supplier_payments (tenant_id, supplier_id, amount_minor, method, note, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.tid, id, b.amountMinor, b.method, b.note ?? null, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "supplier.payment", entity: "supplier", entityId: id, data: { amountMinor: b.amountMinor, method: b.method } });
    const bal = (await app.db.query(`SELECT balance_minor FROM supplier_balances WHERE supplier_id = $1`, [id])).rows[0].balance_minor;
    return { id: r.rows[0].id, balanceMinor: bal };
  });

  /**
   * Receiving goods on a purchase invoice. Quantities are in the unit bought; stock is kept
   * in the base unit, and the product's cost becomes this invoice's cost per base unit.
   */
  app.post("/purchases", managers, async (req) => {
    const b = purchaseSchema.parse(req.body);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid]);
    if (!store.rowCount) throw new HttpError(404, "الفرع غير موجود");
    if (b.supplierId && !(await app.db.query(`SELECT 1 FROM suppliers WHERE id = $1 AND tenant_id = $2`, [b.supplierId, req.user.tid])).rowCount) {
      throw new HttpError(404, "المورد غير موجود");
    }
    const out = await inTx(app.db, async (tx) => {
      const units = [];
      for (const l of b.lines) {
        const u = (await tx.query(
          `SELECT u.product_id, u.factor_milli, u.name AS unit_name, p.name, p.track_expiry FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = $1 AND u.tenant_id = $2`,
          [l.unitId, req.user.tid],
        )).rows[0];
        if (!u) throw new HttpError(400, "وحدة غير موجودة");
        if (u.track_expiry && !l.expiryDate) throw new HttpError(400, `«${u.name}» خاضع للصلاحية، اكتب تاريخ الصلاحية`);
        let sellUnit = { id: l.unitId, name: u.unit_name as string };
        if (l.sellUnitId && l.sellUnitId !== l.unitId) {
          const s = (await tx.query(`SELECT id, name FROM product_units WHERE id = $1 AND product_id = $2`, [l.sellUnitId, u.product_id])).rows[0];
          if (!s) throw new HttpError(400, "وحدة البيع مش من نفس الصنف");
          sellUnit = s;
        }
        units.push({ ...l, ...u, sellUnit, total: Math.round((l.qtyMilli * l.unitCostMinor) / 1000) });
      }
      const total = units.reduce((a, l) => a + l.total, 0);
      if (!b.supplierId && b.paymentMethod === "credit") throw new HttpError(400, "الآجل يحتاج مورد");
      const paid = !b.supplierId ? total : b.paymentMethod === "credit" ? 0 : (b.paidMinor ?? total);
      if (paid > total) throw new HttpError(400, "المدفوع أكبر من قيمة الفاتورة");
      const inv = (await tx.query(
        `INSERT INTO purchase_invoices (tenant_id, store_id, supplier_id, supplier_ref, invoice_date, total_minor, note, user_id, payment_method)
         VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8,$9) RETURNING id`,
        [req.user.tid, b.storeId, b.supplierId ?? null, b.supplierRef ?? null, b.invoiceDate ?? null, total, b.note ?? null, req.user.sub, paid === 0 && b.supplierId ? "credit" : b.paymentMethod],
      )).rows[0].id as string;
      for (const l of units) {
        await tx.query(
          `INSERT INTO purchase_lines (tenant_id, invoice_id, product_id, unit_id, name, unit_name, qty_milli, unit_cost_minor, total_minor, sell_price_minor, expiry_date, sell_unit_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [req.user.tid, inv, l.product_id, l.unitId, l.name, l.unit_name, l.qtyMilli, l.unitCostMinor, l.total, l.sellPriceMinor ?? null, l.expiryDate ?? null, l.sellPriceMinor === undefined ? null : l.sellUnit.name],
        );
        if (l.sellPriceMinor !== undefined) {
          await tx.query(`UPDATE product_units SET price_minor = $2 WHERE id = $1 AND price_minor <> $2`, [l.sellUnit.id, l.sellPriceMinor]);
          await tx.query(`UPDATE products SET updated_at = now() WHERE id = $1`, [l.product_id]); // tills pick up the new price
        }
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7)`,
          [req.user.tid, b.storeId, l.product_id, Math.round((l.qtyMilli * l.factor_milli) / 1000), inv, b.note ?? null, req.user.sub],
        );
        if (b.updateCost) {
          await tx.query(`UPDATE products SET cost_minor = $2, updated_at = now() WHERE id = $1`, [l.product_id, Math.round((l.unitCostMinor * 1000) / l.factor_milli)]);
        }
      }
      if (b.supplierId && paid > 0) {
        await tx.query(
          `INSERT INTO supplier_payments (tenant_id, supplier_id, invoice_id, amount_minor, method, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.tid, b.supplierId, inv, paid, b.paymentMethod === "credit" ? "cash" : b.paymentMethod, req.user.sub],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "stock.purchase", entity: "purchase", entityId: inv, data: { lines: b.lines.length, totalMinor: total, paidMinor: paid } });
      return { id: inv, totalMinor: total, paidMinor: paid };
    });
    return out;
  });

  app.get("/purchases", managers, async (req) => {
    const q = z.object({ supplierId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    const r = await app.db.query(
      `SELECT i.id, i.supplier_ref, i.invoice_date, i.total_minor, i.payment_method, i.created_at, i.note, s.name AS supplier_name, st.name AS store_name,
              COALESCE((SELECT sum(amount_minor) FROM supplier_payments p WHERE p.invoice_id = i.id), CASE WHEN i.supplier_id IS NULL THEN i.total_minor ELSE 0 END) AS paid_minor,
              (SELECT count(*)::int FROM purchase_lines l WHERE l.invoice_id = i.id) AS lines
       FROM purchase_invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id JOIN stores st ON st.id = i.store_id
       WHERE i.tenant_id = $1 AND ($2::uuid IS NULL OR i.supplier_id = $2)
         AND ($3::date IS NULL OR i.invoice_date >= $3) AND ($4::date IS NULL OR i.invoice_date <= $4)
       ORDER BY i.created_at DESC LIMIT 300`,
      [req.user.tid, q.supplierId ?? null, q.from || null, q.to || null],
    );
    return r.rows;
  });

  app.get("/purchases/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const i = (await app.db.query(
      `SELECT i.*, s.name AS supplier_name, st.name AS store_name FROM purchase_invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id JOIN stores st ON st.id = i.store_id WHERE i.id = $1 AND i.tenant_id = $2`,
      [id, req.user.tid],
    )).rows[0];
    if (!i) throw new HttpError(404, "الفاتورة غير موجودة");
    const lines = (await app.db.query(`SELECT name, unit_name, qty_milli, unit_cost_minor, total_minor, sell_price_minor, sell_unit_name, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date FROM purchase_lines WHERE invoice_id = $1`, [id])).rows;
    const payments = (await app.db.query(`SELECT amount_minor, method, created_at FROM supplier_payments WHERE invoice_id = $1`, [id])).rows;
    return { ...i, lines, payments };
  });

  /**
   * What to order: everything at or under its alert level, with a suggested quantity that
   * brings it back to twice the alert level, and who supplied it last and at what cost.
   */
  app.get("/stock/reorder", managers, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
    const r = await app.db.query(
      `WITH stock AS (
         SELECT p.id, p.name, p.is_weighted, p.min_stock_milli, p.cost_minor, COALESCE(sum(m.qty_milli), 0)::bigint AS stock_milli
         FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.store_id = $2
         WHERE p.tenant_id = $1 AND p.active AND p.min_stock_milli > 0
         GROUP BY p.id HAVING COALESCE(sum(m.qty_milli), 0) <= p.min_stock_milli
       )
       SELECT st.*, GREATEST(st.min_stock_milli * 2 - st.stock_milli, 0) AS suggest_milli,
              bu.id AS base_unit_id, bu.name AS base_unit_name,
              last.unit_id AS last_unit_id, last.unit_name AS last_unit_name, last.factor_milli AS last_factor_milli,
              last.unit_cost_minor AS last_cost_minor, last.supplier_id, last.supplier_name, last.at AS last_at
       FROM stock st
       JOIN product_units bu ON bu.product_id = st.id AND bu.is_base
       LEFT JOIN LATERAL (
         SELECT l.unit_id, l.unit_name, u.factor_milli, l.unit_cost_minor, i.supplier_id, s.name AS supplier_name, i.created_at AS at
         FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id JOIN product_units u ON u.id = l.unit_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         WHERE l.product_id = st.id ORDER BY i.created_at DESC LIMIT 1
       ) last ON true
       ORDER BY last.supplier_name NULLS LAST, st.name`,
      [req.user.tid, storeId],
    );
    return r.rows;
  });

  /**
   * Goods that expire within `days` (or already have), from the expiry dates on supply invoices,
   * for items that are still in stock at this branch. Newest delivery per item and date.
   */
  app.get("/stock/expiring", { preHandler: requirePerm("purchasing", "reports") }, async (req) => {
    const q = z.object({ storeId: z.string().uuid(), days: z.coerce.number().int().min(0).max(365).default(30) }).parse(req.query);
    const r = await app.db.query(
      `SELECT l.product_id, l.name, p.is_weighted, to_char(l.expiry_date, 'YYYY-MM-DD') AS expiry_date, (l.expiry_date - current_date) AS days_left,
              sum(l.qty_milli * u.factor_milli / 1000)::bigint AS received_milli, max(s.name) AS supplier_name,
              (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = l.product_id AND m.store_id = $2)::bigint AS stock_milli
       FROM purchase_lines l JOIN purchase_invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id
       JOIN product_units u ON u.id = l.unit_id LEFT JOIN suppliers s ON s.id = i.supplier_id
       WHERE l.tenant_id = $1 AND i.store_id = $2 AND l.expiry_date IS NOT NULL AND l.expiry_date <= current_date + $3::int
       GROUP BY l.product_id, l.name, p.is_weighted, l.expiry_date
       HAVING (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = l.product_id AND m.store_id = $2) > 0
       ORDER BY l.expiry_date, l.name`,
      [req.user.tid, q.storeId, q.days],
    );
    return r.rows;
  });
}
