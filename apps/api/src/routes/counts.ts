import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requirePerm, requireRole } from "../auth";

/**
 * Stock counts: walk the shelves with a phone, scan and type what is there; when done, every
 * difference becomes one correction, so the books match the shelves.
 */
/** What the books said for an item in a store at a moment (every movement up to then). */
const BOOKS_AT = `(SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = l.product_id AND m.store_id = $2 AND m.created_at <= l.counted_at)::bigint`;
/** An item's shelf price for one base unit (a piece, a kilo). */
export const BASE_PRICE = `COALESCE((SELECT pu.price_minor FROM product_units pu WHERE pu.product_id = p.id ORDER BY pu.is_base DESC, pu.factor_milli LIMIT 1), 0)`;
/** The items a count covers: the store's active items, or one department's. $1 tenant, $2 category or null. */
const SCOPE = `p.tenant_id = $1 AND p.active AND ($2::uuid IS NULL OR p.category_id = $2)`;

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
  /** The owner and managers see what the books say; on a blind count nobody else does. */
  const seesBooks = (role: string) => role === "owner" || role === "manager";

  app.get("/counts", managers, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
    return (await app.db.query(
      `SELECT c.id, c.status, c.note, c.created_at, c.applied_at, c.blind, c.purpose, cat.name AS category_name, u.name AS created_by_name,
              (SELECT count(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS items
         FROM stock_counts c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN categories cat ON cat.id = c.category_id
        WHERE c.tenant_id = $1 AND c.store_id = $2 ORDER BY c.created_at DESC LIMIT 50`,
      [req.user.tid, storeId],
    )).rows;
  });

  app.post("/counts", managers, async (req) => {
    const b = z.object({
      storeId: z.string().uuid(), note: z.string().trim().max(200).optional(),
      categoryId: z.string().uuid().nullish(), blind: z.boolean().default(false), purpose: z.enum(["normal", "zakat"]).default("normal"),
    }).parse(req.body);
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
    if (b.categoryId && !(await app.db.query(`SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`, [b.categoryId, req.user.tid])).rowCount) throw new HttpError(404, "القسم غير موجود");
    const r = await app.db.query(
      `INSERT INTO stock_counts (tenant_id, store_id, note, created_by, category_id, blind, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.tid, b.storeId, b.note || null, req.user.sub, b.categoryId ?? null, b.blind, b.purpose],
    );
    return { id: r.rows[0].id as string };
  });

  /**
   * The count: each item's counted quantity next to what the books said when it was counted, so
   * sales made while counting do not show up as a shortage; what is left to count; and the
   * difference in money.
   */
  app.get("/counts/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await own(id, req.user.tid);
    const books = seesBooks(req.user.role) || !c.blind;
    const lines = (await app.db.query(
      `SELECT l.product_id, p.name, p.is_weighted, l.counted_milli, l.damaged_milli, l.counted_at, u.name AS counted_by_name,
              COALESCE(l.system_milli, ${BOOKS_AT}) AS system_milli, p.cost_minor, ${BASE_PRICE} AS price_minor
         FROM stock_count_lines l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.counted_by
        WHERE l.count_id = $1 ORDER BY l.counted_at DESC`,
      [id, c.store_id],
    )).rows.map((l) => {
      const counted = Number(l.counted_milli), damaged = Number(l.damaged_milli), system = Number(l.system_milli);
      const base = { product_id: l.product_id, name: l.name, is_weighted: l.is_weighted, counted_milli: counted, damaged_milli: damaged, counted_at: l.counted_at, counted_by_name: l.counted_by_name, cost_minor: Number(l.cost_minor), price_minor: Number(l.price_minor) };
      return books ? { ...base, system_milli: system, diff_milli: counted + damaged - system } : { ...base, system_milli: null, diff_milli: null };
    });
    const left = (await app.db.query(
      `SELECT p.id AS product_id, p.name, p.is_weighted,
              (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.store_id = $3)::bigint AS system_milli, p.cost_minor
         FROM products p
        WHERE ${SCOPE} AND NOT EXISTS (SELECT 1 FROM stock_count_lines l WHERE l.count_id = $4 AND l.product_id = p.id)
        ORDER BY p.name LIMIT 2000`,
      [req.user.tid, c.category_id, c.store_id, id],
    )).rows.map((p) => ({ product_id: p.product_id, name: p.name, is_weighted: p.is_weighted, system_milli: books ? Number(p.system_milli) : null, cost_minor: Number(p.cost_minor) }));
    let totals = null;
    if (books) {
      const v = (l: { diff_milli: number | null; cost_minor: number }) => Math.round(((l.diff_milli ?? 0) * l.cost_minor) / 1000);
      totals = {
        shortMinor: lines.reduce((a, l) => a + Math.min(0, v(l)), 0),
        overMinor: lines.reduce((a, l) => a + Math.max(0, v(l)), 0),
        damagedMinor: lines.reduce((a, l) => a + Math.round((l.damaged_milli * l.cost_minor) / 1000), 0),
        countedCostMinor: lines.reduce((a, l) => a + Math.round((l.counted_milli * l.cost_minor) / 1000), 0),
        countedPriceMinor: lines.reduce((a, l) => a + Math.round((l.counted_milli * l.price_minor) / 1000), 0),
        leftWithStock: left.filter((p) => (p.system_milli ?? 0) > 0).length,
        leftCostMinor: left.reduce((a, p) => a + Math.max(0, Math.round(((p.system_milli ?? 0) * p.cost_minor) / 1000)), 0),
      };
    }
    const cat = c.category_id ? (await app.db.query(`SELECT name FROM categories WHERE id = $1`, [c.category_id])).rows[0]?.name ?? null : null;
    return {
      id: c.id, status: c.status, note: c.note, storeId: c.store_id, created_at: c.created_at, applied_at: c.applied_at,
      blind: c.blind, purpose: c.purpose, categoryId: c.category_id, categoryName: cat, seesBooks: books, lines, left, totals,
    };
  });

  /** Counts one item: a new figure, or (add) more of it found on another shelf; damaged or expired apart. */
  app.put("/counts/:id/lines", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({
      productId: z.string().uuid(), countedMilli: z.number().int().min(0),
      damagedMilli: z.number().int().min(0).default(0), add: z.boolean().default(false),
    }).parse(req.body);
    await open(id, req.user.tid);
    if (!(await app.db.query(`SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2`, [b.productId, req.user.tid])).rowCount) throw new HttpError(404, "الصنف غير موجود");
    const r = await app.db.query(
      `INSERT INTO stock_count_lines (count_id, product_id, counted_milli, damaged_milli, counted_by) VALUES ($1,$2,$3,$5,$6)
       ON CONFLICT (count_id, product_id) DO UPDATE SET
         counted_milli = CASE WHEN $4 THEN stock_count_lines.counted_milli + EXCLUDED.counted_milli ELSE EXCLUDED.counted_milli END,
         damaged_milli = CASE WHEN $4 THEN stock_count_lines.damaged_milli + EXCLUDED.damaged_milli ELSE EXCLUDED.damaged_milli END,
         counted_at = now(), counted_by = EXCLUDED.counted_by
       RETURNING counted_milli, damaged_milli`,
      [id, b.productId, b.countedMilli, b.add, b.damagedMilli, req.user.sub],
    );
    return { countedMilli: Number(r.rows[0].counted_milli), damagedMilli: Number(r.rows[0].damaged_milli) };
  });

  app.post("/counts/:id/lines/:productId/delete", managers, async (req) => {
    const p = z.object({ id: z.string().uuid(), productId: z.string().uuid() }).parse(req.params);
    await open(p.id, req.user.tid);
    await app.db.query(`DELETE FROM stock_count_lines WHERE count_id = $1 AND product_id = $2`, [p.id, p.productId]);
    return { ok: true };
  });

  /**
   * Turns every difference into a stock correction and closes the count. Owner or manager only.
   * Each line is set right as of when it was counted, so what was sold since stays sold. Damaged
   * goods are written off. With zeroMissing, items in the count's range that nobody counted are
   * taken as gone (a full count of the shop or the department).
   */
  app.post("/counts/:id/apply", { preHandler: requireRole("owner", "manager") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { zeroMissing } = z.object({ zeroMissing: z.boolean().default(false) }).parse(req.body ?? {});
    const out = await inTx(app.db, async (tx) => {
      const c = (await tx.query(`SELECT * FROM stock_counts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, req.user.tid])).rows[0];
      if (!c) throw new HttpError(404, "الجرد غير موجود");
      if (c.status !== "open") throw new HttpError(400, "الجرد هذا مقفول");
      if (zeroMissing) {
        await tx.query(
          `INSERT INTO stock_count_lines (count_id, product_id, counted_milli, counted_by)
           SELECT $4, p.id, 0, $5 FROM products p
            WHERE ${SCOPE} AND NOT EXISTS (SELECT 1 FROM stock_count_lines l WHERE l.count_id = $4 AND l.product_id = p.id)
              AND (SELECT COALESCE(sum(m.qty_milli), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.store_id = $3) <> 0`,
          [req.user.tid, c.category_id, c.store_id, id, req.user.sub],
        );
      }
      const lines = (await tx.query(
        `SELECT l.product_id, l.counted_milli, l.damaged_milli, ${BOOKS_AT} AS system_milli FROM stock_count_lines l WHERE l.count_id = $1`,
        [id, c.store_id],
      )).rows;
      if (!lines.length) throw new HttpError(400, "ما فيش أصناف معدودة");
      let changed = 0, damaged = 0;
      for (const l of lines) {
        const dmg = Number(l.damaged_milli);
        const diff = Number(l.counted_milli) + dmg - Number(l.system_milli);
        await tx.query(`UPDATE stock_count_lines SET system_milli = $3 WHERE count_id = $1 AND product_id = $2`, [id, l.product_id, l.system_milli]);
        if (diff) {
          changed++;
          await tx.query(
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,'جرد',$6)`,
            [req.user.tid, c.store_id, l.product_id, diff, id, req.user.sub],
          );
        }
        if (dmg) {
          damaged++;
          await tx.query(
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,'تالف أو منتهي (جرد)',$6)`,
            [req.user.tid, c.store_id, l.product_id, -dmg, id, req.user.sub],
          );
        }
      }
      await tx.query(`UPDATE stock_counts SET status = 'applied', applied_at = now(), applied_by = $2 WHERE id = $1`, [id, req.user.sub]);
      return { items: lines.length, changed, damaged };
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
