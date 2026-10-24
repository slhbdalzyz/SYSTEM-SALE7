import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { productInputSchema, type CatalogProduct } from "@pos/shared";
import { audit, inTx, type Db, type Tx } from "../db";
import { HttpError, authenticate, requireRole } from "../auth";

export async function loadProducts(q: Db | Tx, tenantId: string, opts: { since?: Date; ids?: string[] } = {}): Promise<CatalogProduct[]> {
  const where = ["p.tenant_id = $1"];
  const args: unknown[] = [tenantId];
  if (opts.since) {
    args.push(opts.since);
    where.push(`p.updated_at > $${args.length}`);
  }
  if (opts.ids) {
    args.push(opts.ids);
    where.push(`p.id = ANY($${args.length})`);
  }
  const r = await q.query(
    `SELECT p.id, p.name, p.sku, p.category_id, p.is_weighted, p.scale_code, p.tax_bp, p.cost_minor, p.min_stock_milli, p.active, p.updated_at,
       COALESCE(json_agg(json_build_object(
         'id', u.id, 'name', u.name, 'factorMilli', u.factor_milli, 'priceMinor', u.price_minor, 'isBase', u.is_base,
         'barcodes', COALESCE((SELECT json_agg(b.code ORDER BY b.code) FROM barcodes b WHERE b.unit_id = u.id), '[]'::json)
       ) ORDER BY u.is_base DESC, u.factor_milli) FILTER (WHERE u.id IS NOT NULL), '[]') AS units
     FROM products p LEFT JOIN product_units u ON u.product_id = p.id
     WHERE ${where.join(" AND ")}
     GROUP BY p.id ORDER BY p.name`,
    args,
  );
  return r.rows.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    categoryId: p.category_id,
    isWeighted: p.is_weighted,
    scaleCode: p.scale_code,
    taxBp: p.tax_bp,
    costMinor: p.cost_minor,
    minStockMilli: p.min_stock_milli,
    active: p.active,
    updatedAt: p.updated_at.toISOString(),
    units: p.units.map((u: CatalogProduct["units"][number]) => ({ ...u, factorMilli: Number(u.factorMilli), priceMinor: Number(u.priceMinor) })),
  }));
}

async function saveProduct(tx: Tx, tenantId: string, id: string | null, input: unknown) {
  const b = productInputSchema.parse(input);
  if (b.units.filter((u) => u.isBase).length !== 1) throw new HttpError(400, "لازم وحدة أساسية وحدة بالضبط");
  if (b.isWeighted && !b.scaleCode) throw new HttpError(400, "الصنف الموزون يحتاج كود ميزان");
  const base = b.units.find((u) => u.isBase)!;
  if (base.factorMilli !== 1000) throw new HttpError(400, "معامل الوحدة الأساسية لازم يكون 1");
  if (b.categoryId) {
    const c = await tx.query(`SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`, [b.categoryId, tenantId]);
    if (!c.rowCount) throw new HttpError(400, "التصنيف غير موجود");
  }

  const cols = [b.name, b.sku ?? null, b.categoryId ?? null, b.isWeighted, b.scaleCode ?? null, b.taxBp, b.costMinor, b.minStockMilli, b.active];
  let pid: string;
  if (id) {
    const r = await tx.query(
      `UPDATE products SET name=$3, sku=$4, category_id=$5, is_weighted=$6, scale_code=$7, tax_bp=$8, cost_minor=$9, min_stock_milli=$10, active=$11, updated_at=now()
       WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [id, tenantId, ...cols],
    );
    if (!r.rowCount) throw new HttpError(404, "الصنف غير موجود");
    pid = id;
  } else {
    const r = await tx.query(
      `INSERT INTO products (tenant_id, name, sku, category_id, is_weighted, scale_code, tax_bp, cost_minor, min_stock_milli, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [tenantId, ...cols],
    );
    pid = r.rows[0].id;
  }

  // Units are kept by id so past sale lines still point at them; units left out are removed only if never sold.
  const existing = (await tx.query(`SELECT id FROM product_units WHERE product_id = $1`, [pid])).rows.map((r) => r.id as string);
  const keep = new Set<string>();
  for (const u of b.units) {
    let uid = u.id && existing.includes(u.id) ? u.id : null;
    if (uid) {
      await tx.query(`UPDATE product_units SET name=$2, factor_milli=$3, price_minor=$4, is_base=$5 WHERE id=$1`, [uid, u.name, u.factorMilli, u.priceMinor, u.isBase]);
    } else {
      uid = (await tx.query(
        `INSERT INTO product_units (tenant_id, product_id, name, factor_milli, price_minor, is_base) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, pid, u.name, u.factorMilli, u.priceMinor, u.isBase],
      )).rows[0].id as string;
    }
    keep.add(uid);
    await tx.query(`DELETE FROM barcodes WHERE unit_id = $1`, [uid]);
    for (const code of new Set(u.barcodes.map((c) => c.trim()).filter(Boolean))) {
      await tx.query(`INSERT INTO barcodes (tenant_id, unit_id, code) VALUES ($1,$2,$3)`, [tenantId, uid, code]);
    }
  }
  for (const old of existing.filter((e) => !keep.has(e))) {
    const used = await tx.query(`SELECT 1 FROM sale_lines WHERE unit_id = $1 LIMIT 1`, [old]);
    if (used.rowCount) throw new HttpError(400, "ما تقدرش تحذف وحدة عليها مبيعات، وقّف الصنف بدلها");
    await tx.query(`DELETE FROM product_units WHERE id = $1`, [old]);
  }
  return pid;
}

function pgConflict(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err.code === "23505") {
    if (err.constraint?.includes("barcodes")) throw new HttpError(409, "الباركود مستعمل لصنف ثاني");
    if (err.constraint?.includes("scale_code")) throw new HttpError(409, "كود الميزان مستعمل لصنف ثاني");
  }
  throw e;
}

export async function catalogRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };

  app.get("/categories", { preHandler: authenticate }, async (req) => {
    return (await app.db.query(`SELECT id, name FROM categories WHERE tenant_id = $1 ORDER BY name`, [req.user.tid])).rows;
  });

  app.post("/categories", managers, async (req) => {
    const b = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const r = await app.db.query(`INSERT INTO categories (tenant_id, name) VALUES ($1,$2) RETURNING id`, [req.user.tid, b.name]);
    return { id: r.rows[0].id };
  });

  app.get("/products", { preHandler: authenticate }, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid().optional() }).parse(req.query);
    const products = await loadProducts(app.db, req.user.tid);
    const sid = storeId ?? req.user.sid;
    if (!sid) return products.map((p) => ({ ...p, stockMilli: null }));
    const stock = await app.db.query(
      `SELECT product_id, sum(qty_milli)::bigint AS q FROM stock_movements WHERE tenant_id = $1 AND store_id = $2 GROUP BY product_id`,
      [req.user.tid, sid],
    );
    const by = new Map(stock.rows.map((r) => [r.product_id as string, r.q as number]));
    return products.map((p) => ({ ...p, stockMilli: by.get(p.id) ?? 0 }));
  });

  app.post("/products", managers, async (req) => {
    try {
      const id = await inTx(app.db, (tx) => saveProduct(tx, req.user.tid, null, req.body));
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "product.create", entity: "product", entityId: id });
      return (await loadProducts(app.db, req.user.tid, { ids: [id] }))[0];
    } catch (e) {
      pgConflict(e);
    }
  });

  app.put("/products/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const before = (await loadProducts(app.db, req.user.tid, { ids: [id] }))[0];
    if (!before) throw new HttpError(404, "الصنف غير موجود");
    try {
      await inTx(app.db, (tx) => saveProduct(tx, req.user.tid, id, req.body));
    } catch (e) {
      pgConflict(e);
    }
    const after = (await loadProducts(app.db, req.user.tid, { ids: [id] }))[0];
    const priceChanges = after.units
      .map((u) => ({ unit: u.name, from: before.units.find((x) => x.id === u.id)?.priceMinor ?? null, to: u.priceMinor }))
      .filter((c) => c.from !== c.to);
    await audit(app.db, {
      tenantId: req.user.tid,
      userId: req.user.sub,
      action: priceChanges.length ? "product.price_change" : "product.update",
      entity: "product",
      entityId: id,
      data: priceChanges.length ? { priceChanges } : undefined,
    });
    return after;
  });

  /** Devices pull the catalog changes since their last sync and keep a local copy for offline selling. */
  app.get("/sync/catalog", { preHandler: authenticate }, async (req) => {
    const { since } = z.object({ since: z.string().datetime().optional() }).parse(req.query);
    const serverTime = (await app.db.query(`SELECT now() AS t`)).rows[0].t as Date;
    const products = await loadProducts(app.db, req.user.tid, { since: since ? new Date(since) : undefined });
    if (req.user.did) await app.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [req.user.did]);
    return { serverTime: serverTime.toISOString(), products, full: !since };
  });
}
