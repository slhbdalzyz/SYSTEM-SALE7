import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError, requireRole } from "../auth";

export async function stockRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };

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
