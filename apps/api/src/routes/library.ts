import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { libraryFor, readShopSettings } from "@pos/shared";
import { audit, inTx, type Tx } from "../db";
import { authenticate, requirePerm } from "../auth";

/** A real product barcode (EAN-8, UPC, EAN-13, ITF-14), not one the shop or its scale made (those start with 2). */
export const shareable = (code: string) => /^\d{8,14}$/.test(code) && !code.startsWith("2");

/** Puts a product's barcodes (or all the shop's, with no product) in the shared library, when the shop shares. */
export async function shareBarcodes(tx: Tx, tenantId: string, productId?: string) {
  const t = (await tx.query(`SELECT settings FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  if (!readShopSettings(t?.settings).library.share) return;
  const rows = (await tx.query(
    `SELECT b.code, p.name, u.name AS unit FROM barcodes b JOIN product_units u ON u.id = b.unit_id JOIN products p ON p.id = u.product_id
      WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR p.id = $2) AND NOT p.is_service`,
    [tenantId, productId ?? null],
  )).rows as { code: string; name: string; unit: string }[];
  for (const r of rows.filter((x) => shareable(x.code))) {
    await tx.query(
      `INSERT INTO barcode_library (code, tenant_id, name, unit) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code, tenant_id) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit, updated_at = now()`,
      [r.code, tenantId, r.name.slice(0, 200), r.unit],
    );
  }
}

/** The ready item list for the shop's kind, and the shared barcode library. */
export async function libraryRoutes(app: FastifyInstance) {
  /** The library's items for this kind of shop; the ones the shop already has are marked. */
  app.get("/library/items", { preHandler: requirePerm("products") }, async (req) => {
    const t = (await app.db.query(`SELECT business_type FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const mine = new Set((await app.db.query(`SELECT lower(name) AS n FROM products WHERE tenant_id = $1`, [req.user.tid])).rows.map((r) => r.n as string));
    return libraryFor(t?.business_type).map((i) => ({ ...i, have: mine.has(i.name.toLowerCase()) }));
  });

  /** The names other shops gave a barcode, most shops first. */
  app.get("/library/barcode/:code", { preHandler: authenticate, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{8,14}$/) }).parse(req.params);
    if (!shareable(code)) return [];
    return (await app.db.query(
      `SELECT name, unit, count(*)::int AS shops FROM barcode_library WHERE code = $1 GROUP BY name, unit ORDER BY count(*) DESC, max(updated_at) DESC LIMIT 3`,
      [code],
    )).rows;
  });

  /** Sharing on puts the shop's barcodes in the library; off takes them all out. */
  app.patch("/settings/library", { preHandler: requirePerm("settings") }, async (req) => {
    const { share } = z.object({ share: z.boolean() }).parse(req.body);
    const shared = await inTx(app.db, async (tx) => {
      const t = (await tx.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
      const s = readShopSettings(t?.settings);
      s.library = { ...s.library, share };
      await tx.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
      if (share) await shareBarcodes(tx, req.user.tid);
      else await tx.query(`DELETE FROM barcode_library WHERE tenant_id = $1`, [req.user.tid]);
      return (await tx.query(`SELECT count(*)::int AS n FROM barcode_library WHERE tenant_id = $1`, [req.user.tid])).rows[0].n as number;
    });
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { library: { share } } });
    return { share, shared };
  });
}
