import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { allocateCost, breakdownYield } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, requirePerm } from "../auth";

const breakdownSchema = z.object({
  storeId: z.string().uuid(),
  sourceProductId: z.string().uuid(),
  sourceQtyMilli: z.number().int().positive().max(10_000_000),
  /** What the carcass cost; left out, it is the item's cost per kilo times the weight. */
  costMinor: z.number().int().nonnegative().optional(),
  lines: z.array(z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive() })).min(1).max(40),
  note: z.string().trim().max(300).optional(),
});

export async function butcherRoutes(app: FastifyInstance) {
  const managers = { preHandler: requirePerm("products") };

  /**
   * Cuts a carcass into pieces: the carcass leaves the stock, each cut comes in, and the cost is
   * shared among the cuts by what they sell for. Each cut's cost per kilo becomes the average of
   * what was on the shelf and what just came in.
   */
  app.post("/butcher/breakdowns", managers, async (req) => {
    const b = breakdownSchema.parse(req.body);
    const tid = req.user.tid;
    if (new Set(b.lines.map((l) => l.productId)).size !== b.lines.length) throw new HttpError(400, "نفس القطعة مكررة");
    if (b.lines.some((l) => l.productId === b.sourceProductId)) throw new HttpError(400, "الذبيحة ما تطلعش منها نفسها");
    const y = breakdownYield(b.sourceQtyMilli, b.lines.map((l) => l.qtyMilli));
    if (y.outMilli > b.sourceQtyMilli) throw new HttpError(400, "وزن القطع أكبر من وزن الذبيحة");
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
    const ids = [b.sourceProductId, ...b.lines.map((l) => l.productId)];
    const items = new Map((await app.db.query(
      `SELECT p.id, p.name, p.cost_minor, u.price_minor,
              COALESCE((SELECT sum(m.qty_milli) FROM stock_movements m WHERE m.product_id = p.id AND m.store_id = $3), 0)::bigint AS stock_milli
       FROM products p JOIN product_units u ON u.product_id = p.id AND u.is_base WHERE p.tenant_id = $1 AND p.id = ANY($2)`,
      [tid, ids, b.storeId],
    )).rows.map((r) => [r.id as string, r]));
    if (ids.some((id) => !items.has(id))) throw new HttpError(400, "صنف غير موجود");
    const src = items.get(b.sourceProductId)!;
    const cost = b.costMinor ?? Math.round((Number(src.cost_minor) * b.sourceQtyMilli) / 1000);
    const shares = allocateCost(cost, b.lines.map((l) => ({ qtyMilli: l.qtyMilli, priceMinor: Number(items.get(l.productId)!.price_minor) })));

    const id = await inTx(app.db, async (tx) => {
      const id = (await tx.query(
        `INSERT INTO breakdowns (tenant_id, store_id, source_product_id, source_qty_milli, cost_minor, note, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tid, b.storeId, b.sourceProductId, b.sourceQtyMilli, cost, b.note || null, req.user.sub],
      )).rows[0].id as string;
      await tx.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'breakdown',$5,'تقطيع',$6)`,
        [tid, b.storeId, b.sourceProductId, -b.sourceQtyMilli, id, req.user.sub]);
      for (const [i, l] of b.lines.entries()) {
        const it = items.get(l.productId)!;
        await tx.query(`INSERT INTO breakdown_lines (breakdown_id, product_id, qty_milli, cost_minor) VALUES ($1,$2,$3,$4)`, [id, l.productId, l.qtyMilli, shares[i]]);
        await tx.query(`INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'breakdown',$5,'من التقطيع',$6)`,
          [tid, b.storeId, l.productId, l.qtyMilli, id, req.user.sub]);
        const have = Math.max(0, Number(it.stock_milli));
        const perKg = Math.round(((have * Number(it.cost_minor)) / 1000 + shares[i]) * 1000 / (have + l.qtyMilli));
        await tx.query(`UPDATE products SET cost_minor = $2, updated_at = now() WHERE id = $1`, [l.productId, perKg]);
      }
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: "stock.breakdown", entity: "product", entityId: b.sourceProductId,
        data: { source: src.name, qtyMilli: b.sourceQtyMilli, cost, cuts: b.lines.length, wasteMilli: y.wasteMilli } });
      return id;
    });
    return { id, costMinor: cost, ...y, lines: b.lines.map((l, i) => ({ ...l, name: items.get(l.productId)!.name, costMinor: shares[i] })) };
  });

  /** Past breakdowns of a branch, newest first, with what each carcass gave. */
  app.get("/butcher/breakdowns", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), sourceProductId: z.string().uuid().optional() }).parse(req.query);
    const rows = (await app.db.query(
      `SELECT b.id, b.created_at, b.source_product_id, p.name AS source_name, b.source_qty_milli, b.cost_minor, b.note, u.name AS by_name,
              json_agg(json_build_object('productId', l.product_id, 'name', lp.name, 'qtyMilli', l.qty_milli, 'costMinor', l.cost_minor) ORDER BY l.qty_milli DESC) AS lines
       FROM breakdowns b JOIN products p ON p.id = b.source_product_id LEFT JOIN users u ON u.id = b.user_id
       JOIN breakdown_lines l ON l.breakdown_id = b.id JOIN products lp ON lp.id = l.product_id
       WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.store_id = $2) AND ($3::uuid IS NULL OR b.source_product_id = $3)
       GROUP BY b.id, p.name, u.name ORDER BY b.created_at DESC LIMIT 100`,
      [req.user.tid, q.storeId ?? null, q.sourceProductId ?? null],
    )).rows;
    return rows.map((r) => {
      const lines = r.lines.map((l: { qtyMilli: number; costMinor: number }) => ({ ...l, qtyMilli: Number(l.qtyMilli), costMinor: Number(l.costMinor) }));
      return { ...r, source_qty_milli: Number(r.source_qty_milli), cost_minor: Number(r.cost_minor), lines, ...breakdownYield(Number(r.source_qty_milli), lines.map((l: { qtyMilli: number }) => l.qtyMilli)) };
    });
  });

  /**
   * What a carcass of this kind usually gives: each cut's average share of the weight over the last
   * breakdowns, to fill in the next one and to see when a carcass gave less than usual.
   */
  app.get("/butcher/usual/:productId", managers, async (req) => {
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params);
    const r = (await app.db.query(
      `WITH last AS (SELECT id, source_qty_milli FROM breakdowns WHERE tenant_id = $1 AND source_product_id = $2 ORDER BY created_at DESC LIMIT 10)
       SELECT l.product_id, p.name, round(avg(l.qty_milli::numeric * 10000 / last.source_qty_milli))::int AS share_bp, count(*)::int AS times
       FROM last JOIN breakdown_lines l ON l.breakdown_id = last.id JOIN products p ON p.id = l.product_id
       GROUP BY l.product_id, p.name ORDER BY share_bp DESC`,
      [req.user.tid, productId],
    )).rows;
    const n = Number((await app.db.query(`SELECT count(*) AS n FROM (SELECT 1 FROM breakdowns WHERE tenant_id = $1 AND source_product_id = $2 LIMIT 10) x`, [req.user.tid, productId])).rows[0].n);
    return { breakdowns: n, cuts: r.map((x) => ({ productId: x.product_id, name: x.name, shareBp: x.share_bp, times: x.times })) };
  });

  /**
   * Today's prices: the price per kilo (or per piece) of many items in one go, as a butcher or a
   * greengrocer changes them each morning. Each change is logged like an edit on the item card.
   */
  app.post("/prices/bulk", managers, async (req) => {
    const b = z.object({ items: z.array(z.object({ unitId: z.string().uuid(), priceMinor: z.number().int().nonnegative() })).min(1).max(500) }).parse(req.body);
    const tid = req.user.tid;
    const changed = await inTx(app.db, async (tx) => {
      const out: { product: string; unit: string; from: number; to: number }[] = [];
      for (const it of b.items) {
        const u = (await tx.query(
          `SELECT u.id, u.name, u.price_minor, p.id AS product_id, p.name AS product FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.id = $1 AND u.tenant_id = $2`,
          [it.unitId, tid],
        )).rows[0];
        if (!u) throw new HttpError(400, "وحدة غير موجودة");
        if (Number(u.price_minor) === it.priceMinor) continue;
        await tx.query(`UPDATE product_units SET price_minor = $2 WHERE id = $1`, [it.unitId, it.priceMinor]);
        await tx.query(`UPDATE products SET updated_at = now() WHERE id = $1`, [u.product_id]);
        await audit(tx, { tenantId: tid, userId: req.user.sub, action: "product.price_change", entity: "product", entityId: u.product_id,
          data: { priceChanges: [{ unit: u.name, from: Number(u.price_minor), to: it.priceMinor }], bulk: true } });
        out.push({ product: u.product, unit: u.name, from: Number(u.price_minor), to: it.priceMinor });
      }
      return out;
    });
    return { changed: changed.length, items: changed };
  });
}
