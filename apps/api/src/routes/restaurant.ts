import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KITCHEN_STATUSES, ORDER_TYPES, recipeCost } from "@pos/shared";
import { audit, inTx } from "../db";
import { HttpError, hashToken, requireDevice, requirePerm } from "../auth";
import { assertNotLocked } from "../billing";

const tableSchema = z.object({
  name: z.string().trim().min(1).max(40),
  area: z.string().trim().max(40).nullable().optional(),
  seats: z.number().int().min(1).max(50).default(4),
  sort: z.number().int().default(0),
  active: z.boolean().default(true),
});

const kitchenLine = z.object({ name: z.string().min(1).max(200), qtyMilli: z.number().int().positive(), note: z.string().max(200).nullable().optional(), cancelled: z.boolean().optional() });
const ticketSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
  orderType: z.enum(ORDER_TYPES).default("takeaway"),
  tableName: z.string().trim().max(60).nullable().optional(),
  lines: z.array(kitchenLine).min(1).max(200),
  createdAt: z.string().datetime(),
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function restaurantRoutes(app: FastifyInstance) {
  const settings = { preHandler: requirePerm("settings", "products") };
  const products = { preHandler: requirePerm("products") };

  const ownStore = async (tid: string, storeId: string) => {
    if (!(await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [storeId, tid])).rowCount) throw new HttpError(404, "الفرع غير موجود");
  };
  const tables = (tid: string, storeId: string, all = true) =>
    app.db.query(
      `SELECT id, name, area, seats, sort, active FROM dining_tables WHERE tenant_id = $1 AND store_id = $2 ${all ? "" : "AND active"} ORDER BY sort, area NULLS FIRST, length(name), name`,
      [tid, storeId],
    ).then((r) => r.rows);

  // ---- Tables ----
  app.get("/restaurant/tables", settings, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.query);
    await ownStore(req.user.tid, storeId);
    return tables(req.user.tid, storeId);
  });

  /** The till's copy: this branch's tables in use. */
  app.get("/sync/tables", { preHandler: requireDevice }, async (req) => tables(req.user.tid, req.user.sid!, false));

  app.post("/restaurant/tables", settings, async (req) => {
    const b = tableSchema.extend({ storeId: z.string().uuid() }).parse(req.body);
    await ownStore(req.user.tid, b.storeId);
    try {
      const r = await app.db.query(
        `INSERT INTO dining_tables (tenant_id, store_id, name, area, seats, sort, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.tid, b.storeId, b.name, b.area || null, b.seats, b.sort, b.active],
      );
      return { id: r.rows[0].id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "فيه طاولة بنفس الاسم");
      throw e;
    }
  });

  /** Many at once: «طاولة 1» to «طاولة 12», in a hall or on the terrace. */
  app.post("/restaurant/tables/bulk", settings, async (req) => {
    const b = z.object({ storeId: z.string().uuid(), prefix: z.string().trim().min(1).max(30).default("طاولة"), from: z.number().int().min(1).max(999).default(1), count: z.number().int().min(1).max(100), area: z.string().trim().max(40).nullable().optional(), seats: z.number().int().min(1).max(50).default(4) }).parse(req.body);
    await ownStore(req.user.tid, b.storeId);
    let added = 0;
    for (let i = 0; i < b.count; i++) {
      const r = await app.db.query(
        `INSERT INTO dining_tables (tenant_id, store_id, name, area, seats, sort) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (store_id, name) DO NOTHING`,
        [req.user.tid, b.storeId, `${b.prefix} ${b.from + i}`, b.area || null, b.seats, b.from + i],
      );
      added += r.rowCount ?? 0;
    }
    return { added };
  });

  app.put("/restaurant/tables/:id", settings, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = tableSchema.parse(req.body);
    try {
      const r = await app.db.query(
        `UPDATE dining_tables SET name = $3, area = $4, seats = $5, sort = $6, active = $7 WHERE id = $1 AND tenant_id = $2`,
        [id, req.user.tid, b.name, b.area || null, b.seats, b.sort, b.active],
      );
      if (!r.rowCount) throw new HttpError(404, "الطاولة غير موجودة");
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "فيه طاولة بنفس الاسم");
      throw e;
    }
    return { ok: true };
  });

  app.delete("/restaurant/tables/:id", settings, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await app.db.query(`DELETE FROM dining_tables WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid]);
    return { ok: true };
  });

  // ---- Kitchen ----
  /** Tickets from the till's outbox. Sending the same ticket twice keeps one. */
  app.post("/kitchen/tickets", { preHandler: requireDevice }, async (req) => {
    const { tickets } = z.object({ tickets: z.array(ticketSchema).min(1).max(100) }).parse(req.body);
    for (const t of tickets) {
      await app.db.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, store_id, device_id, user_id, label, order_type, table_name, lines, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, LEAST($10::timestamptz, now())) ON CONFLICT (id) DO NOTHING`,
        [t.id, req.user.tid, req.user.sid, req.user.did, req.user.sub, t.label, t.orderType, t.tableName || null, JSON.stringify(t.lines), t.createdAt],
      );
    }
    return { ok: true, count: tickets.length };
  });

  /** The kitchen screen has no one signed in: its device token alone shows this branch's orders. */
  const kitchenDevice = async (deviceToken: string) => {
    const d = (await app.db.query(
      `SELECT d.id, d.tenant_id, d.store_id, d.name, s.name AS store_name FROM devices d JOIN stores s ON s.id = d.store_id
       WHERE d.token_hash = $1 AND d.active AND d.kind = 'kitchen'`,
      [hashToken(deviceToken)],
    )).rows[0];
    if (!d) throw new HttpError(401, "الجهاز غير معتمد كشاشة مطبخ");
    await assertNotLocked(app.db, d.tenant_id);
    return d as { id: string; tenant_id: string; store_id: string; name: string; store_name: string };
  };
  const rate = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.post("/kitchen/screen", rate, async (req) => {
    const { deviceToken } = z.object({ deviceToken: z.string().length(64) }).parse(req.body);
    const d = await kitchenDevice(deviceToken);
    await app.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [d.id]);
    // Open orders oldest first, and the last few handed over in case one was tapped by mistake.
    const r = await app.db.query(
      `(SELECT id, label, order_type, table_name, lines, status, created_at, ready_at FROM kitchen_tickets
         WHERE store_id = $1 AND status <> 'served' AND created_at > now() - interval '1 day' ORDER BY created_at)
       UNION ALL
       (SELECT id, label, order_type, table_name, lines, status, created_at, ready_at FROM kitchen_tickets
         WHERE store_id = $1 AND status = 'served' ORDER BY updated_at DESC LIMIT 6)`,
      [d.store_id],
    );
    return { device: { name: d.name, storeName: d.store_name }, serverTime: new Date().toISOString(), tickets: r.rows };
  });

  app.post("/kitchen/screen/status", rate, async (req) => {
    const b = z.object({ deviceToken: z.string().length(64), id: z.string().uuid(), status: z.enum(KITCHEN_STATUSES) }).parse(req.body);
    const d = await kitchenDevice(b.deviceToken);
    const r = await app.db.query(
      `UPDATE kitchen_tickets SET status = $3, updated_at = now(),
         ready_at = CASE WHEN $3 IN ('ready', 'served') THEN COALESCE(ready_at, now()) ELSE NULL END
       WHERE id = $1 AND store_id = $2`,
      [b.id, d.store_id, b.status],
    );
    if (!r.rowCount) throw new HttpError(404, "الطلب غير موجود");
    return { ok: true };
  });

  /** What the kitchen made ready, for the till to call the customer. */
  app.get("/kitchen/ready", { preHandler: requireDevice }, async (req) =>
    (await app.db.query(
      `SELECT id, label, table_name, ready_at FROM kitchen_tickets WHERE store_id = $1 AND status = 'ready' ORDER BY ready_at`,
      [req.user.sid],
    )).rows,
  );

  // ---- Recipes ----
  const costs = async (tid: string, ids: string[]) =>
    new Map((await app.db.query(`SELECT id, cost_minor FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, ids])).rows.map((r) => [r.id as string, Number(r.cost_minor)]));

  app.get("/recipes", products, async (req) => {
    const r = await app.db.query(
      `SELECT r.product_id, p.name, json_agg(json_build_object('ingredientId', r.ingredient_id, 'qtyMilli', r.qty_milli)) AS lines,
              (SELECT price_minor FROM product_units u WHERE u.product_id = p.id AND u.is_base) AS price_minor
       FROM recipe_lines r JOIN products p ON p.id = r.product_id WHERE r.tenant_id = $1 GROUP BY r.product_id, p.id ORDER BY p.name`,
      [req.user.tid],
    );
    const all = await costs(req.user.tid, [...new Set(r.rows.flatMap((x) => x.lines.map((l: { ingredientId: string }) => l.ingredientId)))]);
    return r.rows.map((x) => {
      const lines = x.lines.map((l: { ingredientId: string; qtyMilli: number }) => ({ ingredientId: l.ingredientId, qtyMilli: Number(l.qtyMilli) }));
      return { productId: x.product_id, name: x.name, priceMinor: Number(x.price_minor ?? 0), costMinor: recipeCost(lines, all), ingredients: lines.length };
    });
  });

  app.get("/recipes/:productId", products, async (req) => {
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(
      `SELECT r.ingredient_id, r.qty_milli, p.name, p.cost_minor, (SELECT name FROM product_units u WHERE u.product_id = p.id AND u.is_base) AS unit_name
       FROM recipe_lines r JOIN products p ON p.id = r.ingredient_id WHERE r.tenant_id = $1 AND r.product_id = $2 ORDER BY p.name`,
      [req.user.tid, productId],
    );
    const lines = r.rows.map((x) => ({ ingredientId: x.ingredient_id, name: x.name, unitName: x.unit_name, qtyMilli: Number(x.qty_milli), costMinor: Math.round((Number(x.cost_minor) * Number(x.qty_milli)) / 1000) }));
    return { lines, costMinor: lines.reduce((a, l) => a + l.costMinor, 0) };
  });

  /** Sets what goes into one of the dish; an empty list takes the recipe away. */
  app.put("/recipes/:productId", products, async (req) => {
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params);
    const { lines } = z.object({ lines: z.array(z.object({ ingredientId: z.string().uuid(), qtyMilli: z.number().int().positive().max(1_000_000_000) })).max(60) }).parse(req.body);
    const tid = req.user.tid;
    if (lines.some((l) => l.ingredientId === productId)) throw new HttpError(400, "الصنف ما يدخلش في وصفته");
    if (new Set(lines.map((l) => l.ingredientId)).size !== lines.length) throw new HttpError(400, "نفس المادة مكررة");
    const ids = [productId, ...lines.map((l) => l.ingredientId)];
    const known = (await app.db.query(`SELECT id, name FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tid, ids])).rows;
    if (known.length !== ids.length) throw new HttpError(400, "صنف غير موجود");
    // An ingredient that has its own recipe would need a recipe inside a recipe: kept to one level.
    if (lines.length && (await app.db.query(`SELECT 1 FROM recipe_lines WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])`, [tid, lines.map((l) => l.ingredientId)])).rowCount)
      throw new HttpError(400, "مادة من المواد عندها وصفة بروحها، اختار المواد الخام");
    if (lines.length && (await app.db.query(`SELECT 1 FROM recipe_lines WHERE tenant_id = $1 AND ingredient_id = $2`, [tid, productId])).rowCount)
      throw new HttpError(400, "الصنف هذا داخل كمادة في وصفة صنف ثاني");
    await inTx(app.db, async (tx) => {
      await tx.query(`DELETE FROM recipe_lines WHERE tenant_id = $1 AND product_id = $2`, [tid, productId]);
      for (const l of lines) await tx.query(`INSERT INTO recipe_lines (tenant_id, product_id, ingredient_id, qty_milli) VALUES ($1,$2,$3,$4)`, [tid, productId, l.ingredientId, l.qtyMilli]);
      // The dish costs what goes into it, so the profit in the reports is right.
      if (lines.length) {
        const cost = recipeCost(lines, await costs(tid, lines.map((l) => l.ingredientId)));
        await tx.query(`UPDATE products SET cost_minor = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`, [productId, tid, cost]);
      }
      await audit(tx, { tenantId: tid, userId: req.user.sub, action: "product.recipe", entity: "product", entityId: productId, data: { name: known.find((k) => k.id === productId)?.name, ingredients: lines.length } });
    });
    return { ok: true };
  });

  // ---- Report ----
  app.get("/reports/restaurant", { preHandler: requirePerm("reports") }, async (req) => {
    const q = z.object({ storeId: z.string().uuid().optional(), from: dateStr, to: dateStr, tz: z.string().default("Africa/Tripoli") }).parse(req.query);
    if (q.from > q.to) throw new HttpError(400, "بداية الفترة بعد نهايتها");
    if (q.storeId) await ownStore(req.user.tid, q.storeId);
    const args = [req.user.tid, q.storeId ?? null, q.from, q.to, q.tz];
    const where = `s.tenant_id = $1 AND ($2::uuid IS NULL OR s.store_id = $2) AND s.kind = 'sale' AND (s.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`;
    const [types, tablesTop, kitchen] = await Promise.all([
      app.db.query(`SELECT COALESCE(s.order_type, 'takeaway') AS order_type, count(*)::int AS count, sum(s.total_minor)::bigint AS total_minor FROM sales s WHERE ${where} GROUP BY 1 ORDER BY 3 DESC`, args),
      app.db.query(`SELECT s.table_name, count(*)::int AS count, sum(s.total_minor)::bigint AS total_minor FROM sales s WHERE ${where} AND s.table_name IS NOT NULL GROUP BY 1 ORDER BY 3 DESC LIMIT 20`, args),
      app.db.query(
        `SELECT count(*)::int AS tickets, round(avg(extract(epoch FROM k.ready_at - k.created_at)) / 60)::int AS avg_minutes,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM k.ready_at - k.created_at)) / 60)::int AS slow_minutes
         FROM kitchen_tickets k WHERE k.tenant_id = $1 AND ($2::uuid IS NULL OR k.store_id = $2) AND k.ready_at IS NOT NULL
           AND (k.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`,
        args,
      ),
    ]);
    return {
      byType: types.rows.map((r) => ({ orderType: r.order_type, count: r.count, totalMinor: Number(r.total_minor) })),
      byTable: tablesTop.rows.map((r) => ({ table: r.table_name, count: r.count, totalMinor: Number(r.total_minor) })),
      kitchen: { tickets: kitchen.rows[0]?.tickets ?? 0, avgMinutes: kitchen.rows[0]?.avg_minutes ?? null, slowMinutes: kitchen.rows[0]?.slow_minutes ?? null },
    };
  });
}
