import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { REPAIR_NEXT, REPAIR_STATUSES, normSerial, type RepairStatus } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, requirePerm } from "../auth";

const money = z.number().int().nonnegative().max(1e12);
const repairSchema = z.object({
  /** A device left for repair, or an order taken ahead (a cake, a suit, a part to bring in). */
  kind: z.enum(["repair", "order"]).default("repair"),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  storeId: z.string().uuid().nullable().optional(),
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).nullable().optional(),
  device: z.string().trim().min(2).max(160),
  serial: z.string().trim().max(40).nullable().optional(),
  problem: z.string().trim().min(2).max(500),
  accessories: z.string().trim().max(200).nullable().optional(),
  estimateMinor: money.default(0),
  depositMinor: money.default(0),
  technician: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const repairPatch = repairSchema.omit({ kind: true }).partial().extend({
  status: z.enum(REPAIR_STATUSES).optional(),
  finalMinor: money.nullable().optional(),
});

const repairCols = `r.id, r.kind, r.due_at, r.number, r.store_id, r.customer_name, r.phone, r.device, r.serial, r.problem, r.accessories, r.estimate_minor, r.deposit_minor, r.final_minor,
  r.status, r.notes, r.technician, r.created_at, r.updated_at, r.ready_at, r.delivered_at, s.name AS store_name`;

function repairOut(r: Record<string, unknown>) {
  return {
    id: r.id, kind: r.kind, dueAt: r.due_at, number: r.number, storeId: r.store_id, storeName: r.store_name, customerName: r.customer_name, phone: r.phone, device: r.device, serial: r.serial,
    problem: r.problem, accessories: r.accessories, estimateMinor: Number(r.estimate_minor), depositMinor: Number(r.deposit_minor),
    finalMinor: r.final_minor === null ? null : Number(r.final_minor), status: r.status, notes: r.notes, technician: r.technician,
    createdAt: r.created_at, updatedAt: r.updated_at, readyAt: r.ready_at, deliveredAt: r.delivered_at,
  };
}

/** Electronics shops: the numbers of the phones in stock and sold, and devices left for repair. */
export async function electronicsRoutes(app: FastifyInstance) {
  const items = { preHandler: requirePerm("products", "purchasing") };
  const repairs = { preHandler: requirePerm("sales", "customers") };

  /** The numbers of one item's pieces, in stock first. */
  app.get("/serials", items, async (req) => {
    const q = z.object({ productId: z.string().uuid() }).parse(req.query);
    const r = await app.db.query(
      `SELECT ps.id, ps.serial, ps.status, ps.note, ps.sold_at, ps.warranty_until, ps.created_at, sa.number AS sale_number, st.name AS store_name
       FROM product_serials ps LEFT JOIN sales sa ON sa.id = ps.sale_id LEFT JOIN stores st ON st.id = ps.store_id
       WHERE ps.tenant_id = $1 AND ps.product_id = $2 ORDER BY ps.status = 'sold', ps.sold_at DESC NULLS LAST, ps.created_at DESC LIMIT 1000`,
      [req.user.tid, q.productId],
    );
    return r.rows.map((x) => ({ id: x.id, serial: x.serial, status: x.status, note: x.note, soldAt: x.sold_at, warrantyUntil: x.warranty_until, createdAt: x.created_at, saleNumber: x.sale_number, storeName: x.store_name }));
  });

  /**
   * New pieces of an item, by their numbers (pasted or scanned one after another). Numbers the shop
   * already has are left out and listed. With addStock, the same number of pieces goes into the branch's stock.
   */
  app.post("/serials", items, async (req) => {
    const b = z.object({
      productId: z.string().uuid(),
      serials: z.array(z.string().trim().min(3).max(40)).min(1).max(1000),
      storeId: z.string().uuid().nullable().optional(),
      addStock: z.boolean().default(false),
    }).parse(req.body);
    const tid = req.user.tid;
    const p = (await app.db.query(`SELECT id, name, serialized FROM products WHERE id = $1 AND tenant_id = $2`, [b.productId, tid])).rows[0];
    if (!p) throw new HttpError(404, "الصنف غير موجود");
    if (b.storeId && !(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
    if (b.addStock && !b.storeId) throw new HttpError(400, "اختار الفرع اللي تنزل فيه الكمية");
    const serials = [...new Set(b.serials.map(normSerial).filter((s) => s.length >= 3))];
    return inTx(app.db, async (tx) => {
      const added: string[] = [];
      const existing: { serial: string; product: string; status: string }[] = [];
      for (const serial of serials) {
        const r = await tx.query(
          `INSERT INTO product_serials (tenant_id, product_id, store_id, serial, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, serial) DO NOTHING RETURNING id`,
          [tid, b.productId, b.storeId ?? null, serial, req.user.sub],
        );
        if (r.rowCount) added.push(serial);
        else {
          const was = (await tx.query(`SELECT ps.status, p.name FROM product_serials ps JOIN products p ON p.id = ps.product_id WHERE ps.tenant_id = $1 AND ps.serial = $2`, [tid, serial])).rows[0];
          existing.push({ serial, product: was?.name ?? "", status: was?.status ?? "" });
        }
      }
      // Turning the numbers on for an item that did not have them, so the till asks for them from now on.
      await tx.query(`UPDATE products SET serialized = true, updated_at = now() WHERE id = $1`, [b.productId]);
      if (b.addStock && added.length) {
        await tx.query(
          `INSERT INTO stock_movements (tenant_id, store_id, product_id, qty_milli, kind, note, user_id) VALUES ($1,$2,$3,$4,'adjust',$5,$6)`,
          [tid, b.storeId, b.productId, added.length * 1000, "إدخال أرقام تسلسلية", req.user.sub],
        );
      }
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: "serials.add", entity: "product", entityId: b.productId, data: { added: added.length, existing: existing.length, addStock: b.addStock } });
      return { added, existing };
    });
  });

  /** A number entered by mistake. Only a piece still in stock can be taken off. */
  app.delete("/serials/:id", items, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(`DELETE FROM product_serials WHERE id = $1 AND tenant_id = $2 AND status = 'in_stock' RETURNING product_id, serial`, [id, req.user.tid]);
    if (!r.rowCount) throw new HttpError(400, "الرقم مش موجود أو انباع");
    await app.db.query(`UPDATE products SET updated_at = now() WHERE id = $1`, [r.rows[0].product_id]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "serials.delete", entity: "product", entityId: r.rows[0].product_id, data: { serial: r.rows[0].serial } });
    return { ok: true };
  });

  /**
   * Everything about one phone by its number (or the end of it): which item, whether it is in
   * stock or when it was sold and to whom, the warranty, and its repairs.
   */
  app.get("/serials/lookup", { preHandler: requirePerm("products", "purchasing", "sales", "customers") }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(3).max(40) }).parse(req.query);
    const tid = req.user.tid;
    const s = normSerial(q);
    const pieces = (await app.db.query(
      `SELECT ps.id, ps.serial, ps.status, ps.note, ps.sold_at, ps.warranty_until, ps.created_at, p.id AS product_id, p.name AS product, p.warranty_months,
         sa.id AS sale_id, sa.number AS sale_number, sa.total_minor, c.name AS customer_name, c.phone AS customer_phone, st.name AS store_name, u.name AS cashier,
         (SELECT l.price_minor FROM sale_lines l WHERE l.sale_id = sa.id AND l.product_id = ps.product_id AND ps.serial = ANY(l.serials) LIMIT 1) AS price_minor,
         (SELECT max(r.created_at) FROM sales r JOIN sale_lines rl ON rl.sale_id = r.id JOIN sale_lines ol ON ol.id = rl.original_line_id
            WHERE r.kind = 'return' AND ps.serial = ANY(ol.serials) AND r.tenant_id = ps.tenant_id) AS returned_at
       FROM product_serials ps JOIN products p ON p.id = ps.product_id
       LEFT JOIN sales sa ON sa.id = ps.sale_id LEFT JOIN customers c ON c.id = sa.customer_id LEFT JOIN stores st ON st.id = ps.store_id LEFT JOIN users u ON u.id = sa.user_id
       WHERE ps.tenant_id = $1 AND (ps.serial = $2 OR ps.serial LIKE '%' || $2)
       ORDER BY ps.serial = $2 DESC, ps.created_at DESC LIMIT 10`,
      [tid, s],
    )).rows;
    const serials = pieces.map((p) => p.serial as string);
    const reps = (await app.db.query(
      `SELECT ${repairCols} FROM repairs r LEFT JOIN stores s ON s.id = r.store_id WHERE r.tenant_id = $1 AND (r.serial = ANY($2::text[]) OR r.serial = $3) ORDER BY r.created_at DESC LIMIT 20`,
      [tid, serials, s],
    )).rows.map(repairOut);
    return {
      pieces: pieces.map((p) => ({
        id: p.id, serial: p.serial, status: p.status, note: p.note, productId: p.product_id, product: p.product, warrantyMonths: p.warranty_months,
        receivedAt: p.created_at, soldAt: p.sold_at, warrantyUntil: p.warranty_until, storeName: p.store_name, returnedAt: p.returned_at,
        sale: p.sale_id ? { id: p.sale_id, number: p.sale_number, priceMinor: p.price_minor === null ? null : Number(p.price_minor), customerName: p.customer_name, customerPhone: p.customer_phone, cashier: p.cashier } : null,
      })),
      repairs: reps,
    };
  });

  /** Items sold by their numbers, with how many numbers are in stock against the stock count. */
  app.get("/serials/summary", items, async (req) => {
    const r = await app.db.query(
      `SELECT p.id, p.name, p.warranty_months,
         (SELECT count(*) FROM product_serials ps WHERE ps.product_id = p.id AND ps.status = 'in_stock')::int AS in_stock,
         (SELECT count(*) FROM product_serials ps WHERE ps.product_id = p.id AND ps.status = 'sold')::int AS sold,
         COALESCE((SELECT sum(m.qty_milli) FROM stock_movements m WHERE m.product_id = p.id), 0)::bigint AS stock_milli
       FROM products p WHERE p.tenant_id = $1 AND p.serialized AND p.active ORDER BY p.name`,
      [req.user.tid],
    );
    return r.rows.map((x) => ({ id: x.id, name: x.name, warrantyMonths: x.warranty_months, inStock: x.in_stock, sold: x.sold, stockMilli: Number(x.stock_milli) }));
  });

  // ---- Repairs ----

  app.get("/repairs", repairs, async (req) => {
    const q = z.object({ kind: z.enum(["repair", "order"]).default("repair"), status: z.enum(["open", "all", ...REPAIR_STATUSES]).default("open"), q: z.string().trim().max(60).optional() }).parse(req.query);
    const tid = req.user.tid;
    const args: unknown[] = [tid, q.kind];
    const where = ["r.tenant_id = $1", "r.kind = $2"];
    if (q.status === "open") where.push(`r.status IN ('received', 'working', 'waiting_parts', 'ready')`);
    else if (q.status !== "all") { args.push(q.status); where.push(`r.status = $${args.length}`); }
    if (q.q) {
      args.push(`%${q.q}%`, normSerial(q.q));
      where.push(`(r.customer_name ILIKE $${args.length - 1} OR r.phone ILIKE $${args.length - 1} OR r.device ILIKE $${args.length - 1} OR r.number::text = $${args.length} OR r.serial LIKE '%' || $${args.length})`);
    }
    const rows = (await app.db.query(
      `SELECT ${repairCols} FROM repairs r LEFT JOIN stores s ON s.id = r.store_id WHERE ${where.join(" AND ")}
       ORDER BY CASE r.status WHEN 'ready' THEN 0 WHEN 'received' THEN 1 WHEN 'working' THEN 2 WHEN 'waiting_parts' THEN 3 ELSE 4 END, r.due_at NULLS LAST, r.created_at DESC LIMIT 300`,
      args,
    )).rows.map(repairOut);
    const st = (await app.db.query(
      `SELECT count(*) FILTER (WHERE status IN ('received', 'working', 'waiting_parts'))::int AS in_shop,
         count(*) FILTER (WHERE status = 'ready')::int AS ready,
         COALESCE(sum(COALESCE(final_minor, estimate_minor)) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('month', now())), 0)::bigint AS month_minor,
         count(*) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('month', now()))::int AS month_count,
         COALESCE(sum(deposit_minor) FILTER (WHERE status IN ('received', 'working', 'waiting_parts', 'ready')), 0)::bigint AS deposits_minor,
         count(*) FILTER (WHERE status IN ('received', 'working', 'waiting_parts') AND due_at < now() + interval '1 day')::int AS due_soon
       FROM repairs WHERE tenant_id = $1 AND kind = $2`,
      [tid, q.kind],
    )).rows[0];
    return { rows, stats: { inShop: st.in_shop, ready: st.ready, monthMinor: Number(st.month_minor), monthCount: st.month_count, depositsMinor: Number(st.deposits_minor), dueSoon: st.due_soon } };
  });

  app.post("/repairs", repairs, async (req) => {
    const b = repairSchema.parse(req.body);
    const tid = req.user.tid;
    if (b.depositMinor > b.estimateMinor && b.estimateMinor > 0) throw new HttpError(400, "العربون أكبر من السعر المتفق عليه");
    return inTx(app.db, async (tx) => {
      if (b.storeId && !(await tx.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`repair:${tid}:${b.kind}`]);
      const n = Number((await tx.query(`SELECT COALESCE(max(number), 0) + 1 AS n FROM repairs WHERE tenant_id = $1 AND kind = $2`, [tid, b.kind])).rows[0].n);
      const r = await tx.query(
        `INSERT INTO repairs (tenant_id, store_id, number, customer_name, phone, device, serial, problem, accessories, estimate_minor, deposit_minor, technician, notes, created_by, kind, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [tid, b.storeId ?? null, n, b.customerName, b.phone || null, b.device, b.serial ? normSerial(b.serial) : null, b.problem, b.accessories || null, b.estimateMinor, b.depositMinor, b.technician || null, b.notes || null, req.user.sub, b.kind, b.dueAt ?? null],
      );
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: `${b.kind}.create`, entity: "repair", entityId: r.rows[0].id, data: { number: n, device: b.device, deposit: b.depositMinor } });
      const row = (await tx.query(`SELECT ${repairCols} FROM repairs r LEFT JOIN stores s ON s.id = r.store_id WHERE r.id = $1`, [r.rows[0].id])).rows[0];
      return repairOut(row);
    });
  });

  app.patch("/repairs/:id", repairs, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = repairPatch.parse(req.body);
    const tid = req.user.tid;
    return inTx(app.db, async (tx) => {
      const was = (await tx.query(`SELECT * FROM repairs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tid])).rows[0];
      if (!was) throw new HttpError(404, "الإيصال غير موجود");
      if (b.status && b.status !== was.status && !REPAIR_NEXT[was.status as RepairStatus].includes(b.status)) throw new HttpError(400, "ما ينفعش ينتقل لهذي الحالة");
      if (["delivered", "cancelled"].includes(was.status) && !b.status && Object.keys(b).some((k) => !["notes"].includes(k))) throw new HttpError(400, "الإيصال مقفول");
      const set: string[] = [];
      const args: unknown[] = [id];
      const put = (col: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); };
      const cols: [keyof typeof b, string][] = [["customerName", "customer_name"], ["phone", "phone"], ["device", "device"], ["problem", "problem"], ["accessories", "accessories"],
        ["estimateMinor", "estimate_minor"], ["depositMinor", "deposit_minor"], ["finalMinor", "final_minor"], ["technician", "technician"], ["notes", "notes"], ["status", "status"], ["dueAt", "due_at"]];
      for (const [k, col] of cols) if (b[k] !== undefined) put(col, b[k] === "" ? null : b[k]);
      if (b.serial !== undefined) put("serial", b.serial ? normSerial(b.serial) : null);
      if (b.status === "ready" && was.status !== "ready") set.push("ready_at = now()");
      if (b.status === "delivered") set.push("delivered_at = now()");
      if (!set.length) throw new HttpError(400, "ما فيش تغيير");
      set.push("updated_at = now()");
      await tx.query(`UPDATE repairs SET ${set.join(", ")} WHERE id = $1`, args);
      if (b.status && b.status !== was.status) {
        await audit(tx, { tenantId: tid, userId: req.user.sub, action: "repair.status", entity: "repair", entityId: id, data: { number: was.number, from: was.status, to: b.status, final: b.finalMinor ?? null } });
      }
      return repairOut((await tx.query(`SELECT ${repairCols} FROM repairs r LEFT JOIN stores s ON s.id = r.store_id WHERE r.id = $1`, [id])).rows[0]);
    });
  });
}
