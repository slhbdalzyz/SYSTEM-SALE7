import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readShopSettings, shopSettingsSchema } from "@pos/shared";
import { audit } from "../db";
import { HttpError, authenticate, requirePerm } from "../auth";

/** The shop's settings page: its name, contact details, bank account, receipt and till options. */
export async function settingsRoutes(app: FastifyInstance) {
  /** Everyone signed in reads them: the till prints them on receipts and follows the till options. */
  app.get("/settings", { preHandler: authenticate }, async (req) => {
    const t = (await app.db.query(`SELECT name, settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    if (!t) throw new HttpError(404, "المحل غير موجود");
    return { name: t.name as string, settings: readShopSettings(t.settings) };
  });

  /** The new shop's first steps, ticked off as they get done. */
  app.get("/onboarding", { preHandler: authenticate }, async (req) => {
    const tid = req.user.tid;
    const r = (await app.db.query(
      `SELECT t.settings, t.business_type,
              (SELECT count(*)::int FROM products WHERE tenant_id = $1) AS products,
              (SELECT count(*)::int FROM purchase_invoices WHERE tenant_id = $1) AS purchases,
              (SELECT count(*)::int FROM devices WHERE tenant_id = $1 AND kind = 'pos' AND active) AS devices,
              (SELECT count(*)::int FROM users WHERE tenant_id = $1 AND active) AS users,
              (SELECT count(*)::int FROM sales WHERE tenant_id = $1) AS sales
         FROM tenants t WHERE t.id = $1`,
      [tid],
    )).rows[0];
    const s = readShopSettings(r.settings);
    return {
      businessType: r.business_type as string,
      steps: { settings: !!(s.phone && s.address), products: r.products > 0, purchases: r.purchases > 0, devices: r.devices > 0, staff: r.users > 1, sales: r.sales > 0 },
    };
  });

  app.put("/settings", { preHandler: requirePerm("settings") }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), settings: shopSettingsSchema }).parse(req.body);
    await app.db.query(`UPDATE tenants SET name = $2, settings = $3 WHERE id = $1`, [req.user.tid, b.name, JSON.stringify(b.settings)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { name: b.name } });
    return { name: b.name, settings: b.settings };
  });
}
