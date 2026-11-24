import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MODULES, OTHER_METHODS, readShopSettings, shiftSettingsSchema, shopSettingsSchema, tillLayoutSchema, displayAdsSchema, structureSchema, normalizeStructure, STRUCTURES, type ModuleKey } from "@pos/shared";
import { audit } from "../db";
import { HttpError, authenticate, platformGuard, requirePerm } from "../auth";

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

  /** The cashier screen («🖥 واجهة الكاشير»): layouts for the shop, each till and each cashier, buttons and keys. */
  app.patch("/settings/till-layout", { preHandler: requirePerm("settings") }, async (req) => {
    const b = tillLayoutSchema.parse(req.body);
    const tid = req.user.tid;
    // Only this shop's tills and staff.
    const devices = (await app.db.query(`SELECT id FROM devices WHERE tenant_id = $1`, [tid])).rows.map((r) => r.id as string);
    const users = (await app.db.query(`SELECT id FROM users WHERE tenant_id = $1`, [tid])).rows.map((r) => r.id as string);
    b.devices = Object.fromEntries(Object.entries(b.devices).filter(([k]) => devices.includes(k)));
    b.users = Object.fromEntries(Object.entries(b.users).filter(([k]) => users.includes(k)));
    b.frame.devices = Object.fromEntries(Object.entries(b.frame.devices).filter(([k]) => devices.includes(k)));
    b.frame.users = Object.fromEntries(Object.entries(b.frame.users).filter(([k]) => users.includes(k)));
    // The shop's own frames can't take a ready one's name, and each is checked whole.
    const ready = new Set(STRUCTURES.map((x) => x.id));
    if (b.structures.some((x) => ready.has(x.id))) throw new HttpError(400, "اسم الهيكل محجوز");
    if (new Set(b.structures.map((x) => x.id)).size !== b.structures.length) throw new HttpError(400, "فيه هيكلين بنفس الرمز");
    b.structures = b.structures.map(normalizeStructure);
    const t = (await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [tid])).rows[0];
    const s = readShopSettings(t?.settings);
    s.tillLayout = b;
    await app.db.query(`UPDATE tenants SET settings = $2 WHERE id = $1`, [tid, JSON.stringify(s)]);
    await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: tid, data: { tillLayout: b } });
    return { tillLayout: s.tillLayout };
  });

  /** The customer screen's slides: every till reads them, the owner sets them. */
  app.get("/settings/display-ads", { preHandler: authenticate }, async (req) => {
    const r = (await app.db.query(`SELECT display_ads FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    return displayAdsSchema.parse(r?.display_ads ?? {});
  });
  app.put("/settings/display-ads", { preHandler: requirePerm("settings"), bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = displayAdsSchema.parse(req.body);
    await app.db.query(`UPDATE tenants SET display_ads = $2 WHERE id = $1`, [req.user.tid, JSON.stringify(b)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { displayAds: b.slides.length } });
    return b;
  });

  /** Frames the platform offers every shop, to copy into its own. */
  app.get("/till-structures/library", { preHandler: requirePerm("settings") }, async () => ({ structures: await platformStructures(app) }));
  app.get("/platform/till-structures", { preHandler: platformGuard("settings") }, async () => ({ structures: await platformStructures(app) }));
  app.put("/platform/till-structures", { preHandler: platformGuard("settings") }, async (req) => {
    const b = z.object({ structures: z.array(structureSchema).max(30) }).parse(req.body);
    const ready = new Set(STRUCTURES.map((x) => x.id));
    if (b.structures.some((x) => ready.has(x.id))) throw new HttpError(400, "اسم الهيكل محجوز");
    if (new Set(b.structures.map((x) => x.id)).size !== b.structures.length) throw new HttpError(400, "فيه هيكلين بنفس الرمز");
    const structures = b.structures.map(normalizeStructure);
    await app.db.query(
      `INSERT INTO platform_settings (key, value) VALUES ('till_structures', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ structures })],
    );
    return { structures };
  });

  app.put("/settings", { preHandler: requirePerm("settings") }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), settings: shopSettingsSchema }).parse(req.body);
    // The shop's features have their own page; saving the settings page never resets them.
    const old = readShopSettings((await app.db.query(`SELECT settings FROM tenants WHERE id = $1`, [req.user.tid])).rows[0]?.settings);
    b.settings.modules = old.modules;
    b.settings.payMethods = old.payMethods;
    b.settings.hiddenMethods = old.hiddenMethods;
    b.settings.shift = old.shift;
    b.settings.tillLayout = old.tillLayout;
    await app.db.query(`UPDATE tenants SET name = $2, settings = $3 WHERE id = $1`, [req.user.tid, b.name, JSON.stringify(b.settings)]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "settings.update", entity: "tenant", entityId: req.user.tid, data: { name: b.name } });
    return { name: b.name, settings: b.settings };
  });
}

async function platformStructures(app: FastifyInstance) {
  const v = (await app.db.query(`SELECT value FROM platform_settings WHERE key = 'till_structures'`)).rows[0]?.value as { structures?: unknown[] } | undefined;
  return (v?.structures ?? []).flatMap((x) => {
    const r = structureSchema.safeParse(x);
    return r.success ? [normalizeStructure(r.data)] : [];
  });
}
