import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODULES, OTHER_METHODS, readShopSettings, shiftSettingsSchema, shopSettingsSchema, type ModuleKey } from "@pos/shared";
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

  /** Puts a side-menu page away (or brings it back) without touching the rest of the settings. */
  app.patch("/settings/menu", { preHandler: requirePerm("settings") }, async (req) => {
    const b = z.object({ hidePaper: z.boolean() }).parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.menu = { ...s.menu, ...b };
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { menu: b } });
    return { menu: s.menu };
  });

  /** Turns the shop's features on or off (sizes and colours, recipes, quotes…). Nothing is deleted when one is off. */
  app.patch("/settings/modules", { preHandler: requirePerm("settings") }, async (req) => {
    const keys = MODULES.map((m) => m.key) as [ModuleKey, ...ModuleKey[]];
    const b = z.record(z.enum(keys), z.boolean()).parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.modules = { ...s.modules, ...b };
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { modules: b } });
    return { modules: s.modules };
  });

  /** The shop's own ways of paying, and which built-in ones its till leaves out. */
  app.patch("/settings/pay-methods", { preHandler: requirePerm("settings") }, async (req) => {
    const b = shopSettingsSchema.pick({ payMethods: true, hiddenMethods: true }).parse(req.body);
    const ids = b.payMethods.map((m) => m.id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "في طريقتين بنفس الرمز");
    const names = b.payMethods.map((m) => m.name);
    if (new Set(names).size !== names.length) throw new HttpError(400, "في طريقتين بنفس الاسم");
    b.hiddenMethods = b.hiddenMethods.filter((m) => (OTHER_METHODS as readonly string[]).includes(m));
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.payMethods = b.payMethods;
    s.hiddenMethods = b.hiddenMethods;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: b });
    return { payMethods: s.payMethods, hiddenMethods: s.hiddenMethods };
  });

  /** How shifts close («🧾 قفل الوردية»): each option on or off, saved on its own. */
  app.patch("/settings/shift", { preHandler: requirePerm("settings") }, async (req) => {
    const b = shiftSettingsSchema.parse(req.body);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.shift = b;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { shift: b } });
    return { shift: s.shift };
  });

  app.put("/settings", { preHandler: requirePerm("settings") }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), settings: shopSettingsSchema }).parse(req.body);
    // The shop's features have their own page; saving the settings page never resets them.
    const old = readShopSettings((await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0]?.settings);
    b.settings.modules = old.modules;
    b.settings.payMethods = old.payMethods;
    b.settings.hiddenMethods = old.hiddenMethods;
    b.settings.shift = old.shift;
    await app.db.query(`UPDATE tenants SET name = $2, settings = $3 WHERE id = $1`, [req.user.tid, b.name, JSON.stringify(b.settings)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { name: b.name } });
    return { name: b.name, settings: b.settings };
  });
}
