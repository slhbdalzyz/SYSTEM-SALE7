import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, requireRole } from "../auth";
import { assertWithinPlan } from "../billing";

const storeSchema = z.object({
  name: z.string().min(2).max(120),
  address: z.string().max(300).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  receiptFooter: z.string().max(300).nullable().optional(),
});

const transferSchema = z.object({
  fromStoreId: z.string().uuid(),
  toStoreId: z.string().uuid(),
  note: z.string().max(300).optional(),
  lines: z.array(z.object({ productId: z.string().uuid(), qtyMilli: z.number().int().positive() })).min(1).max(500),
});

const stockSql = `SELECT COALESCE(sum(qty_milli), 0)::bigint AS s FROM stock_movements WHERE tenant_id = $1 AND store_id = $2 AND product_id = $3`;

export async function branchRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };
  const owners = { preHandler: requireRole("owner") };

  app.get("/stores", managers, async (req) => {
    const r = await app.db.query(
      `SELECT s.id, s.name, s.address, s.phone, s.receipt_footer, s.active, s.created_at,
              (SELECT count(*)::int FROM devices d WHERE d.store_id = s.id AND d.active) AS devices,
              (SELECT COALESCE(sum(m.qty_milli * p.cost_minor / 1000), 0)::bigint FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE m.store_id = s.id) AS stock_value_minor
       FROM stores s WHERE s.tenant_id = $1 ORDER BY s.created_at`,
      [req.user.tid],
    );
    return r.rows;
  });

  app.post("/stores", owners, async (req) => {
    const b = storeSchema.parse(req.body);
    await assertWithinPlan(app.db, req.user.tid, "stores");
    const r = await app.db.query(
      `INSERT INTO stores (tenant_id, name, address, phone, receipt_footer) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.tid, b.name, b.address ?? null, b.phone ?? null, b.receiptFooter ?? null],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "store.create", entity: "store", entityId: r.rows[0].id, data: { name: b.name } });
    return { id: r.rows[0].id };
  });

  /** One product's stock in every branch, for deciding what to move where. */
  app.get("/stock/by-store", managers, async (req) => {
    const r = await app.db.query(
      `SELECT p.id, p.name, p.is_weighted, p.min_stock_milli, s.id AS store_id, COALESCE(sum(m.qty_milli), 0)::bigint AS stock_milli
       FROM products p CROSS JOIN stores s
       LEFT JOIN stock_movements m ON m.product_id = p.id AND m.store_id = s.id
       WHERE p.tenant_id = $1 AND s.tenant_id = $1 AND p.active AND s.active
       GROUP BY p.id, s.id ORDER BY p.name`,
      [req.user.tid],
    );
    const out = new Map<string, { id: string; name: string; is_weighted: boolean; min_stock_milli: number; stock: Record<string, number> }>();
    for (const row of r.rows) {
      if (!out.has(row.id)) out.set(row.id, { id: row.id, name: row.name, is_weighted: row.is_weighted, min_stock_milli: Number(row.min_stock_milli), stock: {} });
      out.get(row.id)!.stock[row.store_id] = Number(row.stock_milli);
    }
    return [...out.values()];
  });

  /** Sales side by side for every branch over a date range (store-local days). */
  app.get("/reports/branches", managers, async (req) => {
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tz: z.string().default("Africa/Tripoli") }).parse(req.query);
    const r = await app.db.query(
      `SELECT st.id, st.name,
              count(s.id) FILTER (WHERE s.kind = 'sale')::int AS sales_count,
              COALESCE(sum(s.total_minor), 0)::bigint AS total_minor,
              COALESCE(-sum(s.total_minor) FILTER (WHERE s.kind = 'return'), 0)::bigint AS returns_minor,
              COALESCE((SELECT sum(l.total_minor - l.cost_minor) FROM sale_lines l JOIN sales x ON x.id = l.sale_id
                        WHERE x.store_id = st.id AND (x.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date), 0)::bigint AS gross_profit_minor
       FROM stores st
       LEFT JOIN sales s ON s.store_id = st.id AND (s.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
       WHERE st.tenant_id = $1 GROUP BY st.id ORDER BY st.created_at`,
      [req.user.tid, q.from, q.to, q.tz],
    );
    return r.rows;
  });

  app.get("/transfers", managers, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), status: z.enum(["sent", "received", "cancelled"]).optional() }).parse(req.query);
    const r = await app.db.query(
      `SELECT t.id, t.number, t.status, t.note, t.sent_at, t.done_at, t.from_store_id, t.to_store_id,
              f.name AS from_name, d.name AS to_name, us.name AS sent_by_name, ud.name AS done_by_name,
              (SELECT count(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS lines,
              (SELECT COALESCE(sum(l.qty_milli - l.received_milli), 0)::bigint FROM stock_transfer_lines l WHERE l.transfer_id = t.id AND l.received_milli IS NOT NULL) AS short_milli
       FROM stock_transfers t JOIN stores f ON f.id = t.from_store_id JOIN stores d ON d.id = t.to_store_id
       LEFT JOIN users us ON us.id = t.sent_by LEFT JOIN users ud ON ud.id = t.done_by
       WHERE t.tenant_id = $1 AND ($2::uuid IS NULL OR $2 IN (t.from_store_id, t.to_store_id)) AND ($3::text IS NULL OR t.status = $3)
       ORDER BY t.sent_at DESC LIMIT 200`,
      [req.user.tid, q.storeId ?? null, q.status ?? null],
    );
    return r.rows;
  });

  app.get("/transfers/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = (await app.db.query(
      `SELECT t.*, f.name AS from_name, d.name AS to_name FROM stock_transfers t JOIN stores f ON f.id = t.from_store_id JOIN stores d ON d.id = t.to_store_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [id, req.user.tid],
    )).rows[0];
    if (!t) throw new HttpError(404, "التحويل غير موجود");
    const lines = await app.db.query(
      `SELECT l.id, l.product_id, l.name, l.qty_milli, l.received_milli, p.is_weighted FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id WHERE l.transfer_id = $1 ORDER BY l.name`,
      [id],
    );
    return { ...t, lines: lines.rows };
  });

  /** Sending takes the goods out of the sending branch straight away. */
  app.post("/transfers", managers, async (req) => {
    const b = transferSchema.parse(req.body);
    if (b.fromStoreId === b.toStoreId) throw new HttpError(400, "اختار فرعين مختلفين");
    const stores = await app.db.query(`SELECT id, active FROM stores WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [req.user.tid, [b.fromStoreId, b.toStoreId]]);
    if (stores.rowCount !== 2) throw new HttpError(404, "الفرع غير موجود");
    if (stores.rows.some((s) => !s.active)) throw new HttpError(400, "الفرع موقوف");
    return inTx(app.db, async (tx) => {
      // One transfer at a time per tenant so numbers are sequential and stock checks don't race.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`transfer:${req.user.tid}`]);
      const merged = new Map<string, number>();
      for (const l of b.lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qtyMilli);
      const lines = [];
      for (const [productId, qty] of merged) {
        const p = (await tx.query(`SELECT name FROM products WHERE id = $1 AND tenant_id = $2`, [productId, req.user.tid])).rows[0];
        if (!p) throw new HttpError(400, "صنف غير موجود");
        const have = Number((await tx.query(stockSql, [req.user.tid, b.fromStoreId, productId])).rows[0].s);
        if (have < qty) throw new HttpError(400, `الموجود من «${p.name}» في الفرع أقل من الكمية المحولة`);
        lines.push({ productId, qty, name: p.name as string });
      }
      const number = Number((await tx.query(`SELECT COALESCE(max(number), 0) + 1 AS n FROM stock_transfers WHERE tenant_id = $1`, [req.user.tid])).rows[0].n);
      const id = (await tx.query(
        `INSERT INTO stock_transfers (tenant_id, number, from_store_id, to_store_id, note, sent_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.tid, number, b.fromStoreId, b.toStoreId, b.note ?? null, req.user.sub],
      )).rows[0].id as string;
      for (const l of lines) {
        await tx.query(`INSERT INTO stock_transfer_lines (tenant_id, transfer_id, product_id, name, qty_milli) VALUES ($1,$2,$3,$4,$5)`, [req.user.tid, id, l.productId, l.name, l.qty]);
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'transfer',$5,$6,$7)`,
          [req.user.tid, b.fromStoreId, l.productId, -l.qty, id, `تحويل ${number} (إرسال)`, req.user.sub],
        );
      }
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "transfer.send", entity: "transfer", entityId: id, data: { number, lines: lines.length } });
      return { id, number };
    });
  });

  /**
   * The receiving branch confirms what arrived. Anything missing stays out of both branches
   * and shows as a shortage on the transfer.
   */
  app.post("/transfers/:id/receive", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ lines: z.array(z.object({ id: z.string().uuid(), receivedMilli: z.number().int().min(0) })).optional() }).parse(req.body ?? {});
    return inTx(app.db, async (tx) => {
      const t = (await tx.query(`SELECT * FROM stock_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, req.user.tid])).rows[0];
      if (!t) throw new HttpError(404, "التحويل غير موجود");
      if (t.status !== "sent") throw new HttpError(409, "التحويل مقفل");
      const given = new Map((b.lines ?? []).map((l) => [l.id, l.receivedMilli]));
      const lines = (await tx.query(`SELECT id, product_id, qty_milli FROM stock_transfer_lines WHERE transfer_id = $1`, [id])).rows;
      let short = 0;
      for (const l of lines) {
        const got = given.get(l.id) ?? Number(l.qty_milli);
        if (got > Number(l.qty_milli)) throw new HttpError(400, "المستلم أكثر من المرسل");
        short += Number(l.qty_milli) - got;
        await tx.query(`UPDATE stock_transfer_lines SET received_milli = $2 WHERE id = $1`, [l.id, got]);
        if (got > 0) {
          await tx.query(
            `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id) VALUES ($1,$2,$3,$4,'transfer',$5,$6,$7)`,
            [req.user.tid, t.to_store_id, l.product_id, got, id, `تحويل ${t.number} (استلام)`, req.user.sub],
          );
        }
      }
      await tx.query(`UPDATE stock_transfers SET status = 'received', done_by = $2, done_at = now() WHERE id = $1`, [id, req.user.sub]);
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "transfer.receive", entity: "transfer", entityId: id, data: { shortMilli: short } });
      return { ok: true, shortMilli: short };
    });
  });

  /** Cancelling a transfer that hasn't arrived puts the goods back in the sending branch. */
  app.post("/transfers/:id/cancel", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inTx(app.db, async (tx) => {
      const t = (await tx.query(`SELECT * FROM stock_transfers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, req.user.tid])).rows[0];
      if (!t) throw new HttpError(404, "التحويل غير موجود");
      if (t.status !== "sent") throw new HttpError(409, "التحويل مقفل");
      await tx.query(
        `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, ref_id, note, user_id)
         SELECT $1, $2, product_id, qty_milli, 'transfer', $3, $4, $5 FROM stock_transfer_lines WHERE transfer_id = $3`,
        [req.user.tid, t.from_store_id, id, `تحويل ${t.number} (إلغاء)`, req.user.sub],
      );
      await tx.query(`UPDATE stock_transfers SET status = 'cancelled', done_by = $2, done_at = now() WHERE id = $1`, [id, req.user.sub]);
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "transfer.cancel", entity: "transfer", entityId: id });
      return { ok: true };
    });
  });
}
