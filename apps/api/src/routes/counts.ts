import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requirePerm, requireRole } from "../auth";

/**
 * Stock counts: walk the shelves with a phone, scan and type what is there; when done, every
 * difference becomes one correction, so the books match the shelves.
 */
export async function countRoutes(app: FastifyInstance) {
  const managers = { preHandler: requirePerm("products", "purchasing") };
  const own = async (id: string, tid: string) => {
    const c = (await app.db.query(`SELECT * FROM stock_counts WHERE id = $1 AND tenant_id = $2`, [id, tid])).rows[0];
    if (!c) throw new HttpError(404, "الجرد غير موجود");
    return c;
  };
  const open = async (id: string, tid: string) => {
    const c = await own(id, tid);
    if (c.status !== "open") throw new HttpError(400, "الجرد هذا مقفول");
    return c;
  };

  app.get("/counts", managers, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
    return (await app.db.query(
      `SELECT c.id, c.status, c.note, c.created_at, c.applied_at, u.name AS created_by_name,
              (SELECT count(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS items
         FROM stock_counts c LEFT JOIN users u ON u.id = c.created_by
        WHERE c.tenant_id = $1 AND c.store_id = $2 ORDER BY c.created_at DESC LIMIT 50`,
      [req.user.tid, storeId],
    )).rows;
  });

  app.post("/counts", managers, async (req) => {
    const b = z.object({ storeId: z.string().uuid(), note: z.string().trim().max(200).optional() }).parse(req.body);
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
    const r = await app.db.query(`INSERT INTO stock_counts (tenant_id, store_id, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [req.user.tid, b.storeId, b.note || null, req.user.sub]);
    return { id: r.rows[0].id as string };
  });

  /** The count with each item's counted quantity next to what the books say now. */
  app.get("/counts/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await own(id, req.user.tid);
    const lines = (await app.db.query(
      `SELECT l.product_id, p.name, p.is_weighted, l.counted_milli, l.counted_at,
              COALESCE(l.system_milli, (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = l.product_id AND m.store_id = $2))::bigint AS system_milli,
              p.cost_minor
         FROM stock_count_lines l JOIN products p ON p.id = l.product_id
        WHERE l.count_id = $1 ORDER BY l.counted_at DESC`,
      [id, c.store_id],
    )).rows.map((l) => ({ ...l, counted_milli: Number(l.counted_milli), system_milli: Number(l.system_milli), cost_minor: Number(l.cost_minor), diff_milli: Number(l.counted_milli) - Number(l.system_milli) }));
    return { id: c.id, status: c.status, note: c.note, storeId: c.store_id, created_at: c.created_at, applied_at: c.applied_at, lines };
  });

  /** Counts one item: a new figure, or (add) more of it found on another shelf. */
  app.put("/counts/:id/lines", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ productId: z.string().uuid(), countedMilli: z.number().int().min(0), add: z.boolean().default(false) }).parse(req.body);
    await open(id, req.user.tid);
    if (!(await app.db.query(`SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2`, [b.productId, req.user.tid])).rowCount) throw new HttpError(404, "الصنف غير موجود");
    const r = await app.db.query(
      `INSERT INTO stock_count_lines (count_id, product_id, counted_milli) VALUES ($1,$2,$3)
       ON CONFLICT (count_id, product_id) DO UPDATE SET counted_milli = CASE WHEN $4 THEN stock_count_lines.counted_milli + EXCLUDED.counted_milli ELSE EXCLUDED.counted_milli END, counted_at = now()
       RETURNING counted_milli`,
      [id, b.productId, b.countedMilli, b.add],
    );
    return { countedMilli: Number(r.rows[0].counted_milli) };
  });

  app.post("/counts/:id/lines/:productId/delete", managers, async (req) => {
    const p = z.object({ id: z.string().uuid(), productId: z.string().uuid() }).parse(req.params);
    await open(p.id, req.user.tid);
    await app.db.query(`DELETE FROM stock_count_lines WHERE count_id = $1 AND product_id = $2`, [p.id, p.productId]);
    return { ok: true };
  });

  /** Turns every difference into a stock correction and closes the count. Owner or manager only. */
  app.post("/counts/:id/apply", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const out = await inTx(app.db, async (tx) => {
      const c = (await tx.query(`SELECT * FROM stock_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, req.user.tid])).rows[0];
      if (!c) throw new HttpError(404, "الجرد غير موجود");
      if (c.status !== "open") throw new HttpError(400, "الجرد هذا مقفول");
      const lines = (await tx.query(
        `SELECT l.product_id, l.counted_milli, (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = l.product_id AND m.store_id = $2)::bigint AS system_milli
           FROM stock_count_lines l WHERE l.count_id = $1`,
        [id, c.store_id],
      )).rows;
      if (!lines.length) throw new HttpError(400, "ما فيش أصناف معدودة");
      let changed = 0;
      for (const l of lines) {
        const diff = Number(l.counted_milli) - Number(l.system_milli);
        await tx.query(`UPDATE stock_count_lines SET system_milli = $3 WHERE count_id = $1 AND product_id = $2`, [id, l.product_id, l.system_milli]);
        if (!diff) continue;
        changed++;
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,'جرد',$6)`,
          [req.user.tid, c.store_id, l.product_id, diff, id, req.user.sub],
        );
      }
      await tx.query(`UPDATE stock_counts SET status = 'applied', applied_at = now(), applied_by = $2 WHERE id = $1`, [id, req.user.sub]);
      return { items: lines.length, changed };
    });
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "stock.count", entity: "stock_count", entityId: id, data: out });
    return out;
  });

  app.post("/counts/:id/cancel", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await open(id, req.user.tid);
    await app.db.query(`UPDATE stock_counts SET status = 'cancelled' WHERE id = $1`, [id]);
    return { ok: true };
  });

  /** Who did what and when: sign-ins, price changes, returns, stock corrections, settings… Owner only. */
  app.get("/audit/log", { preHandler: requireRole("owner") }, async (req) => {
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      userId: z.string().uuid().optional(), action: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const rows = (await app.db.query(
      `SELECT a.id, a.created_at, a.action, a.entity, a.entity_id, a.data, u.name AS user_name, d.name AS device_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN devices d ON d.id = a.device_id
        WHERE a.tenant_id = $1 AND (a.created_at AT TIME ZONE 'Africa/Tripoli')::date BETWEEN $2::date AND $3::date
          AND ($4::uuid IS NULL OR a.user_id = $4) AND ($5::text IS NULL OR a.action LIKE $5 || '%')
        ORDER BY a.created_at DESC, a.id DESC LIMIT $6`,
      [req.user.tid, q.from, q.to, q.userId ?? null, q.action || null, q.limit],
    )).rows;
    const users = (await app.db.query(`SELECT id, name FROM users WHERE tenant_id = $1 ORDER BY name`, [req.user.tid])).rows;
    return { rows: rows.map((r) => ({ ...r, id: Number(r.id) })), users };
  });
}
