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

  app.put("/settings", { preHandler: requirePerm("settings") }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), settings: shopSettingsSchema }).parse(req.body);
    await app.db.query(`UPDATE tenants SET name = $2, settings = $3 WHERE id = $1`, [req.user.tid, b.name, JSON.stringify(b.settings)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { name: b.name } });
    return { name: b.name, settings: b.settings };
  });
}
