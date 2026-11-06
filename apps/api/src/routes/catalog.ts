import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ean13CheckDigit, productInputSchema, type CatalogProduct } from "@pos/shared";
import { audit, inTx, type Db, type Tx } from "../db";
import { HttpError, authenticate, requirePerm } from "../auth";

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
    `SELECT p.id, p.name, p.sku, p.category_id, p.is_weighted, p.scale_code, p.tax_bp, p.cost_minor, p.min_stock_milli, p.active, p.track_expiry, p.quick, p.group_id, p.attrs, p.updated_at,
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
    trackExpiry: p.track_expiry,
    quick: p.quick,
    groupId: p.group_id,
    attrs: p.attrs,
    updatedAt: p.updated_at.toISOString(),
    units: p.units.map((u: CatalogProduct["units"][number]) => ({ ...u, factorMilli: Number(u.factorMilli), priceMinor: Number(u.priceMinor) })),
  }));
}

/**
 * The shop's next in-store barcode: EAN-13 starting 299 (the in-store range), numbered per shop.
 * The exact match is looked up before scale labels on the till, so they never read as a weight.
 */
async function nextInStoreCode(tx: Tx, tenantId: string): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`barcode:${tenantId}`]);
  const last = (await tx.query(
    `SELECT max(substring(code, 4, 9)::bigint) AS n FROM barcodes WHERE tenant_id = $1 AND code ~ '^299[0-9]{10}$'`,
    [tenantId],
  )).rows[0].n;
  for (let n = Number(last ?? 0) + 1; ; n++) {
    const body = `299${String(n).padStart(9, "0")}`;
    const code = body + ean13CheckDigit(body);
    if (!(await tx.query(`SELECT 1 FROM barcodes WHERE tenant_id = $1 AND code = $2`, [tenantId, code])).rowCount) return code;
  }
}

/** The next free scale code for a weighed item. */
async function nextScaleCode(tx: Tx, tenantId: string): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`scale:${tenantId}`]);
  const r = (await tx.query(`SELECT COALESCE(max(scale_code::int), 0) + 1 AS n FROM products WHERE tenant_id = $1 AND scale_code ~ '^[0-9]{1,6}$'`, [tenantId])).rows[0];
  return String(r.n);
}

async function saveProduct(tx: Tx, tenantId: string, id: string | null, input: unknown) {
  const b = productInputSchema.parse(input);
  if (b.units.filter((u) => u.isBase).length !== 1) throw new HttpError(400, "لازم وحدة أساسية وحدة بالضبط");
  if (b.autoCode && b.isWeighted && !b.scaleCode) b.scaleCode = await nextScaleCode(tx, tenantId);
  const autoBase = b.autoCode && !b.isWeighted && !b.units.some((u) => u.isBase && u.barcodes.some((c) => c.trim()));
  if (b.isWeighted && !b.scaleCode) throw new HttpError(400, "الصنف الموزون يحتاج كود ميزان");
  const base = b.units.find((u) => u.isBase)!;
  if (base.factorMilli !== 1000) throw new HttpError(400, "معامل الوحدة الأساسية لازم يكون 1");
  if (b.categoryId) {
    const c = await tx.query(`SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2`, [b.categoryId, tenantId]);
    if (!c.rowCount) throw new HttpError(400, "التصنيف غير موجود");
  }

  const cols = [b.name, b.sku ?? null, b.categoryId ?? null, b.isWeighted, b.scaleCode ?? null, b.taxBp, b.costMinor, b.minStockMilli, b.active, b.trackExpiry, b.quick];
  let pid: string;
  if (id) {
    const r = await tx.query(
      `UPDATE products SET name=$3, sku=$4, category_id=$5, is_weighted=$6, scale_code=$7, tax_bp=$8, cost_minor=$9, min_stock_milli=$10, active=$11, track_expiry=$12, quick=$13, updated_at=now()
       WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [id, tenantId, ...cols],
    );
    if (!r.rowCount) throw new HttpError(404, "الصنف غير موجود");
    pid = id;
  } else {
    const r = await tx.query(
      `INSERT INTO products (tenant_id, name, sku, category_id, is_weighted, scale_code, tax_bp, cost_minor, min_stock_milli, active, track_expiry, quick)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
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
    const codes = u.barcodes.map((c) => c.trim()).filter(Boolean);
    if (autoBase && u.isBase) codes.push(await nextInStoreCode(tx, tenantId));
    for (const code of new Set(codes)) {
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
  const managers = { preHandler: requirePerm("products") };

  /** Departments (meat, vegetables, dairy…), in the shop's own order, with how many items each holds. */
  app.get("/categories", { preHandler: authenticate }, async (req) => {
    return (await app.db.query(
      `SELECT c.id, c.name, c.icon, c.sort, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.active) AS products
       FROM categories c WHERE c.tenant_id = $1 ORDER BY c.sort, c.name`,
      [req.user.tid],
    )).rows;
  });

  const categorySchema = z.object({ name: z.string().trim().min(1).max(80), icon: z.string().max(8).nullable().optional(), sort: z.number().int().min(0).max(9999).optional() });
  const nameTaken = (e: unknown) => {
    if ((e as { code?: string }).code === "23505") throw new HttpError(409, "فيه قسم بنفس الاسم");
    throw e;
  };

  app.post("/categories", managers, async (req) => {
    const b = categorySchema.parse(req.body);
    const r = await app.db.query(
      `INSERT INTO categories (tenant_id, name, icon, sort)
       VALUES ($1,$2,$3, COALESCE($4, (SELECT COALESCE(max(sort), 0) + 1 FROM categories WHERE tenant_id = $1))) RETURNING id`,
      [req.user.tid, b.name, b.icon ?? null, b.sort ?? null],
    ).catch(nameTaken);
    return { id: r.rows[0].id };
  });

  app.patch("/categories/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = categorySchema.partial().parse(req.body);
    const r = await app.db.query(
      `UPDATE categories SET name = COALESCE($3, name), icon = CASE WHEN $4::boolean THEN $5 ELSE icon END, sort = COALESCE($6, sort), updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, b.name ?? null, b.icon !== undefined, b.icon ?? null, b.sort ?? null],
    ).catch(nameTaken);
    if (!r.rowCount) throw new HttpError(404, "القسم غير موجود");
    return { ok: true };
  });

  /** Removing a department keeps its items; they just have no department until moved. */
  app.post("/categories/:id/delete", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await inTx(app.db, async (tx) => {
      await tx.query(`UPDATE products SET category_id = NULL, updated_at = now() WHERE category_id = $1 AND tenant_id = $2`, [id, req.user.tid]);
      return tx.query(`DELETE FROM categories WHERE id = $1 AND tenant_id = $2 RETURNING name`, [id, req.user.tid]);
    });
    if (!r.rowCount) throw new HttpError(404, "القسم غير موجود");
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "category.delete", entity: "category", entityId: id, data: { name: r.rows[0].name } });
    return { ok: true };
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

  /**
   * One item in several sizes and colours (clothes, shoes): a card for each combination, each with
   * its own barcode and stock, grouped so they show together.
   */
  app.post("/products/variants", managers, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(160),
      categoryId: z.string().uuid().nullable().optional(),
      sizes: z.array(z.string().trim().min(1).max(20)).max(20).default([]),
      colors: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
      unitName: z.string().trim().min(1).max(40).default("حبة"),
      minStockMilli: z.number().int().nonnegative().default(0),
      priceMinor: z.number().int().nonnegative().default(0),
      costMinor: z.number().int().nonnegative().default(0),
    }).parse(req.body);
    const sizes = [...new Set(b.sizes)];
    const colors = [...new Set(b.colors)];
    if (!sizes.length && !colors.length) throw new HttpError(400, "حط مقاس أو لون واحد على الأقل");
    const combos: Record<string, string>[] = [];
    for (const color of colors.length ? colors : [null]) for (const size of sizes.length ? sizes : [null]) combos.push({ ...(color ? { color } : {}), ...(size ? { size } : {}) });
    if (combos.length > 100) throw new HttpError(400, "أكثر من 100 نوع، قسّمهم");
    const ids = await inTx(app.db, async (tx) => {
      const group = (await tx.query(`SELECT gen_random_uuid() AS g`)).rows[0].g as string;
      const out: string[] = [];
      for (const a of combos) {
        const name = [b.name, a.color, a.size].filter(Boolean).join(" - ");
        const id = await saveProduct(tx, req.user.tid, null, {
          name, categoryId: b.categoryId ?? null, autoCode: true, minStockMilli: b.minStockMilli, costMinor: b.costMinor,
          units: [{ name: b.unitName, factorMilli: 1000, priceMinor: b.priceMinor, isBase: true, barcodes: [] }],
        });
        await tx.query(`UPDATE products SET group_id = $2, attrs = $3 WHERE id = $1`, [id, group, JSON.stringify(a)]);
        out.push(id);
      }
      return out;
    });
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "product.variants", entity: "product", entityId: ids[0], data: { name: b.name, count: ids.length } });
    const made = await loadProducts(app.db, req.user.tid, { ids });
    return made.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); // colour by colour, sizes in the order given
  });

  /** Gives a unit its own in-store barcode when it came without one (loose bread, local products…). */
  app.post("/barcodes/generate", managers, async (req) => {
    const { unitId } = z.object({ unitId: z.string().uuid() }).parse(req.body);
    return inTx(app.db, async (tx) => {
      const u = (await tx.query(`SELECT product_id FROM product_units WHERE id = $1 AND tenant_id = $2`, [unitId, req.user.tid])).rows[0];
      if (!u) throw new HttpError(404, "الوحدة غير موجودة");
      const code = await nextInStoreCode(tx, req.user.tid);
      await tx.query(`INSERT INTO barcodes (tenant_id, unit_id, code) VALUES ($1,$2,$3)`, [req.user.tid, unitId, code]);
      await tx.query(`UPDATE products SET updated_at = now() WHERE id = $1`, [u.product_id]);
      return { code };
    });
  });

  /** Devices pull the catalog changes since their last sync and keep a local copy for offline selling. */
  app.get("/sync/catalog", { preHandler: authenticate }, async (req) => {
    const { since } = z.object({ since: z.string().datetime().optional() }).parse(req.query);
    const serverTime = (await app.db.query(`SELECT now() AS t`)).rows[0].t as Date;
    // After a restore, a till that last synced before it reloads everything.
    const restored = (await app.db.query(`SELECT restored_at FROM tenants WHERE id = $1`, [req.user.tid])).rows[0]?.restored_at as Date | null;
    const from = since && !(restored && restored > new Date(since)) ? new Date(since) : undefined;
    const products = await loadProducts(app.db, req.user.tid, { since: from });
    if (req.user.did) await app.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [req.user.did]);
    return { serverTime: serverTime.toISOString(), products, full: !from };
  });
}
