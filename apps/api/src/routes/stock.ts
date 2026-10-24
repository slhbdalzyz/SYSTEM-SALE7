import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requireRole } from "../auth";

export async function stockRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };

  /** Receiving goods. Quantities are in the chosen unit; stock is kept in the base unit. */
  app.post("/purchases", managers, async (req) => {
    const b = z
      .object({
        storeId: z.string().uuid(),
        note: z.string().max(300).optional(),
        updateCost: z.boolean().default(true),
        lines: z.array(z.object({ unitId: z.string().uuid(), qtyMilli: z.number().int().positive(), unitCostMinor: z.number().int().nonnegative() })).min(1).max(500),
      })
      .parse(req.body);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid]);
    if (!store.rowCount) throw new HttpError(404, "الفرع غير موجود");
    const ref = crypto.randomUUID();
    await inTx(app.db, async (tx) => {
      for (const l of b.lines) {
        const u = (await tx.query(`SELECT product_id, factor_milli FROM product_units WHERE id = $1 AND tenant_id = $2`, [l.unitId, req.user.tid])).rows[0];
        if (!u) throw new HttpError(400, "وحدة غير موجودة");
        const baseQty = Math.round((l.qtyMilli * u.factor_milli) / 1000);
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7)`,
          [req.user.tid, b.storeId, u.product_id, baseQty, ref, b.note ?? null, req.user.sub],
        );
        if (b.updateCost) {
          // Cost per base unit = unit cost ÷ factor.
          const baseCost = Math.round((l.unitCostMinor * 1000) / u.factor_milli);
          await tx.query(`UPDATE products SET cost_minor = $2, updated_at = now() WHERE id = $1`, [u.product_id, baseCost]);
        }
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "stock.purchase", entityId: ref, data: { lines: b.lines.length } });
    });
    return { id: ref };
  });

  /** Count correction, damage or loss. A positive or negative quantity in the base unit. */
  app.post("/stock/adjust", managers, async (req) => {
    const b = z
      .object({ storeId: z.string().uuid(), productId: z.string().uuid(), qtyMilli: z.number().int().refine((n) => n !== 0), reason: z.string().min(2).max(200) })
      .parse(req.body);
    const p = await app.db.query(`SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2`, [b.productId, req.user.tid]);
    const s = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid]);
    if (!p.rowCount || !s.rowCount) throw new HttpError(404, "غير موجود");
    await app.db.query(
      `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,$6)`,
      [req.user.tid, b.storeId, b.productId, b.qtyMilli, b.reason, req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "stock.adjust", entity: "product", entityId: b.productId, data: { qty: b.qtyMilli, reason: b.reason } });
    return { ok: true };
  });

  app.get("/stock/low", managers, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
    const r = await app.db.query(
      `SELECT p.id, p.name, p.min_stock_milli, COALESCE(sum(m.qty_milli), 0)::bigint AS stock_milli
       FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id AND m.store_id = $2
       WHERE p.tenant_id = $1 AND p.active AND p.min_stock_milli > 0
       GROUP BY p.id HAVING COALESCE(sum(m.qty_milli), 0) <= p.min_stock_milli ORDER BY p.name`,
      [req.user.tid, storeId],
    );
    return r.rows;
  });
}
