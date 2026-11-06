import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { quickGroupInputSchema, quickKeyInputSchema, type QuickKeyInput } from "@pos/shared";
import { audit, inTx, type Db, type Tx } from "../db";
import { HttpError, authenticate, requirePerm } from "../auth";

const KEY_COLS = `k.id, k.group_id, k.product_id, k.unit_id, k.qty_milli, k.open_price, k.label, k.color, k.image, k.store_id, k.user_id, k.sort`;

function row(k: Record<string, unknown>) {
  return {
    id: k.id, groupId: k.group_id, productId: k.product_id, unitId: k.unit_id, qtyMilli: Number(k.qty_milli), openPrice: k.open_price,
    label: k.label, color: k.color, image: k.image, storeId: k.store_id, userId: k.user_id, sort: k.sort,
    ...(k.product_name !== undefined ? { productName: k.product_name, unitName: k.unit_name ?? null, priceMinor: k.price_minor ?? null } : {}),
  };
}

/** The products ticked as quick keys in the item card follow the keys. */
async function syncFlag(q: Db | Tx, productId: string) {
  await q.query(`UPDATE products SET quick = EXISTS (SELECT 1 FROM quick_keys WHERE product_id = $1), updated_at = now() WHERE id = $1`, [productId]);
}

async function check(q: Db | Tx, tid: string, b: QuickKeyInput) {
  const p = (await q.query(`SELECT id FROM products WHERE id = $1 AND tenant_id = $2`, [b.productId, tid])).rows[0];
  if (!p) throw new HttpError(400, "الصنف غير موجود");
  if (b.unitId && !(await q.query(`SELECT 1 FROM product_units WHERE id = $1 AND product_id = $2`, [b.unitId, b.productId])).rowCount) throw new HttpError(400, "الوحدة مش لهذا الصنف");
  if (b.groupId && !(await q.query(`SELECT 1 FROM quick_groups WHERE id = $1 AND tenant_id = $2`, [b.groupId, tid])).rowCount) throw new HttpError(400, "المجموعة غير موجودة");
  if (b.storeId && !(await q.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, tid])).rowCount) throw new HttpError(400, "الفرع غير موجود");
  if (b.userId && !(await q.query(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2`, [b.userId, tid])).rowCount) throw new HttpError(400, "الموظف غير موجود");
}

/** Products that a key lets the cashier sell at a price typed each time (not a price override). */
export async function openPriceProducts(q: Db | Tx, tid: string): Promise<Set<string>> {
  const r = await q.query(`SELECT DISTINCT product_id FROM quick_keys WHERE tenant_id = $1 AND open_price`, [tid]);
  return new Set(r.rows.map((x) => x.product_id as string));
}

export async function quickRoutes(app: FastifyInstance) {
  const edit = { preHandler: requirePerm("products") };

  /** Everything, for the admin page: groups, and keys with what they sell. */
  app.get("/quick-keys", edit, async (req) => {
    const tid = req.user.tid;
    const groups = await app.db.query(`SELECT id, name, color, sort FROM quick_groups WHERE tenant_id = $1 ORDER BY sort, created_at`, [tid]);
    const keys = await app.db.query(
      `SELECT ${KEY_COLS}, p.name AS product_name, u.name AS unit_name,
         COALESCE(u.price_minor, (SELECT b.price_minor FROM product_units b WHERE b.product_id = p.id AND b.is_base LIMIT 1)) AS price_minor
       FROM quick_keys k JOIN products p ON p.id = k.product_id LEFT JOIN product_units u ON u.id = k.unit_id
       WHERE k.tenant_id = $1 ORDER BY k.sort, k.created_at`,
      [tid],
    );
    return { groups: groups.rows, keys: keys.rows.map(row) };
  });

  /** The keys this till shows: for every branch or this one, for everyone or this cashier. */
  app.get("/quick-keys/till", { preHandler: authenticate }, async (req) => {
    const { tid, sid, sub } = req.user;
    const keys = await app.db.query(
      `SELECT ${KEY_COLS} FROM quick_keys k JOIN products p ON p.id = k.product_id
       WHERE k.tenant_id = $1 AND p.active AND (k.store_id IS NULL OR k.store_id = $2) AND (k.user_id IS NULL OR k.user_id = $3)
       ORDER BY k.sort, k.created_at`,
      [tid, sid ?? null, sub],
    );
    const used = new Set(keys.rows.map((k) => k.group_id).filter(Boolean));
    const groups = (await app.db.query(`SELECT id, name, color, sort FROM quick_groups WHERE tenant_id = $1 ORDER BY sort, created_at`, [tid])).rows.filter((g) => used.has(g.id));
    return { groups, keys: keys.rows.map(row) };
  });

  /** Items without a barcode that sold the most lately and have no key yet: bread, bags, loose vegetables. */
  app.get("/quick-keys/suggest", edit, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const r = await app.db.query(
      `SELECT p.id, p.name, p.is_weighted, count(DISTINCT l.sale_id)::int AS sales
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
       WHERE s.tenant_id = $1 AND s.kind = 'sale' AND s.created_at > now() - make_interval(days => $2) AND p.active
         AND NOT EXISTS (SELECT 1 FROM barcodes b JOIN product_units u ON u.id = b.unit_id WHERE u.product_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM quick_keys k WHERE k.product_id = p.id)
       GROUP BY p.id ORDER BY sales DESC, p.name LIMIT 12`,
      [req.user.tid, days],
    );
    return r.rows.map((x) => ({ productId: x.id, name: x.name, isWeighted: x.is_weighted, sales: x.sales }));
  });

  app.post("/quick-groups", edit, async (req) => {
    const b = quickGroupInputSchema.parse(req.body);
    const r = await app.db.query(
      `INSERT INTO quick_groups (tenant_id, name, color, sort) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort), 0) + 1 FROM quick_groups WHERE tenant_id = $1)) RETURNING id, name, color, sort`,
      [req.user.tid, b.name, b.color ?? null],
    );
    return r.rows[0];
  });

  app.patch("/quick-groups/:id", edit, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = quickGroupInputSchema.parse(req.body);
    const r = await app.db.query(`UPDATE quick_groups SET name = $3, color = $4 WHERE id = $1 AND tenant_id = $2 RETURNING id, name, color, sort`, [id, req.user.tid, b.name, b.color ?? null]);
    if (!r.rowCount) throw new HttpError(404, "المجموعة غير موجودة");
    return r.rows[0];
  });

  /** Deleting a group keeps its keys: they move to the main page. */
  app.post("/quick-groups/:id/delete", edit, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await app.db.query(`DELETE FROM quick_groups WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid]);
    if (!r.rowCount) throw new HttpError(404, "المجموعة غير موجودة");
    return { ok: true };
  });

  app.post("/quick-keys", edit, async (req) => {
    const b = quickKeyInputSchema.parse(req.body);
    return inTx(app.db, async (tx) => {
      await check(tx, req.user.tid, b);
      const r = await tx.query(
        `INSERT INTO quick_keys AS k (tenant_id, group_id, product_id, unit_id, qty_milli, open_price, label, color, image, store_id, user_id, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT COALESCE(max(sort), 0) + 1 FROM quick_keys WHERE tenant_id = $1)) RETURNING ${KEY_COLS}`,
        [req.user.tid, b.groupId ?? null, b.productId, b.unitId ?? null, b.qtyMilli, b.openPrice, b.label || null, b.color ?? null, b.image ?? null, b.storeId ?? null, b.userId ?? null],
      );
      await syncFlag(tx, b.productId);
      await audit(tx, { tenantId: req.user.tid, userId: req.user.sub, action: "quick_key.add", entity: "product", entityId: b.productId, data: { ...b, image: b.image ? "…" : null } });
      return row(r.rows[0]);
    });
  });

  app.patch("/quick-keys/:id", edit, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = quickKeyInputSchema.parse(req.body);
    return inTx(app.db, async (tx) => {
      const old = (await tx.query(`SELECT product_id FROM quick_keys WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
      if (!old) throw new HttpError(404, "الزر غير موجود");
      await check(tx, req.user.tid, b);
      const r = await tx.query(
        `UPDATE quick_keys AS k SET group_id=$3, product_id=$4, unit_id=$5, qty_milli=$6, open_price=$7, label=$8, color=$9, image=$10, store_id=$11, user_id=$12
         WHERE id = $1 AND tenant_id = $2 RETURNING ${KEY_COLS}`,
        [id, req.user.tid, b.groupId ?? null, b.productId, b.unitId ?? null, b.qtyMilli, b.openPrice, b.label || null, b.color ?? null, b.image ?? null, b.storeId ?? null, b.userId ?? null],
      );
      await syncFlag(tx, old.product_id);
      if (old.product_id !== b.productId) await syncFlag(tx, b.productId);
      return row(r.rows[0]);
    });
  });

  app.post("/quick-keys/:id/delete", edit, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return inTx(app.db, async (tx) => {
      const r = await tx.query(`DELETE FROM quick_keys WHERE id = $1 AND tenant_id = $2 RETURNING product_id`, [id, req.user.tid]);
      if (!r.rowCount) throw new HttpError(404, "الزر غير موجود");
      await syncFlag(tx, r.rows[0].product_id);
      return { ok: true };
    });
  });

  /** New order after a drag: the ids in the order they now stand. Moving between groups is in the same call. */
  app.post("/quick-keys/order", edit, async (req) => {
    const b = z.object({ groupId: z.string().uuid().nullable(), ids: z.array(z.string().uuid()).max(500) }).parse(req.body);
    await inTx(app.db, async (tx) => {
      if (b.groupId && !(await tx.query(`SELECT 1 FROM quick_groups WHERE id = $1 AND tenant_id = $2`, [b.groupId, req.user.tid])).rowCount) throw new HttpError(400, "المجموعة غير موجودة");
      for (const [i, id] of b.ids.entries()) {
        await tx.query(`UPDATE quick_keys SET sort = $3, group_id = $4 WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid, i + 1, b.groupId]);
      }
    });
    return { ok: true };
  });

  app.post("/quick-groups/order", edit, async (req) => {
    const b = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(req.body);
    await inTx(app.db, async (tx) => {
      for (const [i, id] of b.ids.entries()) await tx.query(`UPDATE quick_groups SET sort = $3 WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid, i + 1]);
    });
    return { ok: true };
  });
}
