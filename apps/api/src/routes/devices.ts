import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db";
import { HttpError, hashToken, requireDevice } from "../auth";
import { loadProducts } from "./catalog";
import { assertNotLocked } from "../billing";

export async function deviceRoutes(app: FastifyInstance) {
  /**
   * A price checker has no one signed in: its device token alone gets the shop's active
   * products with their prices and barcodes, and nothing else.
   */
  app.post("/price-checker/catalog", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { deviceToken } = z.object({ deviceToken: z.string().length(64) }).parse(req.body);
    const d = (await app.db.query(
      `SELECT d.id, d.tenant_id, d.name, s.name AS store_name FROM devices d JOIN stores s ON s.id = d.store_id
       WHERE d.token_hash = $1 AND d.active AND d.kind = 'price_checker'`,
      [hashToken(deviceToken)],
    )).rows[0];
    if (!d) throw new HttpError(401, "الجهاز غير معتمد كقارئ أسعار");
    await assertNotLocked(app.db, d.tenant_id);
    await app.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [d.id]);
    const products = (await loadProducts(app.db, d.tenant_id)).filter((p) => p.active);
    // Cost is the shop's business, not the shop floor's.
    return { device: { name: d.name, storeName: d.store_name }, products: products.map((p) => ({ ...p, costMinor: 0 })) };
  });

  /** Things a till does that leave no sale behind but the owner should see, like opening the drawer. */
  app.post("/devices/events", { preHandler: requireDevice }, async (req) => {
    const b = z.object({ action: z.enum(["drawer.open"]), reason: z.string().max(200).optional() }).parse(req.body);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, deviceId: req.user.did, action: b.action, data: b.reason ? { reason: b.reason } : undefined });
    return { ok: true };
  });
}
