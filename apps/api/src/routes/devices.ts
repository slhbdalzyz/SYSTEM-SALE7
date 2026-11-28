import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { autoCloseShifts } from "./shifts";
import { checkDigest } from "./insights";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { audit, type Db, type Tx } from "../db";
import { HttpError, hashToken, newDeviceToken, requireDevice, requireRole } from "../auth";
import { loadProducts } from "./catalog";
import { assertNotLocked, assertWithinPlan } from "../billing";
import { flushPushes, raiseAlert } from "../alerts";

type Kind = "pos" | "price_checker" | "kitchen";

/** Adds a device to a shop under a token hash the device already holds. */
export async function createDevice(q: Db | Tx, a: { tenantId: string; storeId: string; name: string; kind: Kind; tokenHash: string }) {
  await assertWithinPlan(q, a.tenantId, "devices", a.kind);
  const n = (await q.query(`SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1`, [a.tenantId])).rows[0].n as number;
  const prefix = `P${n + 1}`;
  const r = await q.query(
    `INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [a.tenantId, a.storeId, a.name, prefix, a.tokenHash, a.kind],
  );
  return { id: r.rows[0].id as string, prefix };
}

/** The shop's 6-digit code, made the first time anyone asks for it. */
async function shopCode(db: Db, tenantId: string, renew = false): Promise<string> {
  if (!renew) {
    const have = (await db.query(`SELECT shop_code FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.shop_code;
    if (have) return have;
  }
  for (let i = 0; i < 20; i++) {
    // From hex so the in-browser demo (which only has randomBytes) makes codes the same way.
    const code = String(100000 + (parseInt(randomBytes(4).toString("hex"), 16) % 900000));
    const r = await db.query(
      `UPDATE tenants SET shop_code = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM tenants WHERE shop_code = $2) RETURNING shop_code`,
      [tenantId, code],
    );
    if (r.rowCount) return code;
  }
  throw new HttpError(500, "ما قدرناش نعملوا كود للمحل، جرب مرة ثانية");
}

const WRONG_PIN_LIMIT = 5;

/** Five wrong PINs for one person in 15 minutes and that person waits before trying again. */
export async function assertPinNotLocked(db: Db, tenantId: string, userId: string) {
  const n = (await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND user_id = $2 AND action IN ('user.pin_failed', 'device_request.pin_failed')
       AND created_at > now() - interval '15 minutes'`,
    [tenantId, userId],
  )).rows[0].n as number;
  if (n >= WRONG_PIN_LIMIT) throw new HttpError(429, "الرقم السري غلط 5 مرات. استنى ربع ساعة وجرب مرة ثانية، أو كلم صاحب المحل");
}

async function deviceInfo(db: Db, deviceId: string) {
  return (await db.query(
    `SELECT d.id, d.name, d.prefix, d.kind, s.name AS "storeName" FROM devices d JOIN stores s ON s.id = d.store_id WHERE d.id = $1`,
    [deviceId],
  )).rows[0] as { id: string; name: string; prefix: string; kind: Kind; storeName: string };
}

const shopCodeSchema = z.string().regex(/^\d{6}$/, "كود المحل 6 أرقام");

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

  /**
   * The till says it is still there, how many sales it holds to send and how many the server
   * turned down. Sent with its regular sync, so the owner sees in «الأجهزة» which tills are
   * connected and which have sales waiting.
   */
  app.post("/devices/heartbeat", { preHandler: requireDevice }, async (req) => {
    const b = z.object({ pending: z.number().int().min(0).max(1_000_000), failed: z.number().int().min(0).max(1_000_000).default(0) }).parse(req.body);
    const ip = (req.ip ?? "").replace(/^::ffff:/, "") || null;
    await autoCloseShifts(app.db, req.user.tid).catch(() => 0);
    if (await checkDigest(app.db, req.user.tid).catch(() => 0)) await flushPushes(app.db, req.user.tid).catch(() => undefined);
    await app.db.query(
      `UPDATE devices SET last_seen_at = now(), pending_count = $3, failed_count = $4, last_ip = $5 WHERE id = $1 AND tenant_id = $2`,
      [req.user.did, req.user.tid, b.pending, b.failed, ip],
    );
    return { ok: true };
  });

  // ── A cashier gets a new device in without the owner there ─────────────────────────

  /** Step 1: the shop code shows which shop it is, its branches and who can sign in with a PIN. */
  app.post("/auth/shop-lookup", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { shopCode: code } = z.object({ shopCode: shopCodeSchema }).parse(req.body);
    const t = (await app.db.query(`SELECT id, name FROM tenants WHERE shop_code = $1`, [code])).rows[0];
    if (!t) throw new HttpError(404, "كود المحل غلط. تلقاه عند صاحب المحل في «الأجهزة»");
    await assertNotLocked(app.db, t.id);
    const stores = (await app.db.query(`SELECT id, name FROM stores WHERE tenant_id = $1 AND active ORDER BY created_at`, [t.id])).rows;
    const users = (await app.db.query(`SELECT id, name FROM users WHERE tenant_id = $1 AND active AND pin_hash IS NOT NULL ORDER BY name`, [t.id])).rows;
    return { shop: { name: t.name }, stores, users };
  });

  /**
   * Step 2: the cashier's PIN asks for this device. The device keeps the token it gets back;
   * the token starts working once the owner approves (or at once if the shop lets such devices in).
   */
  app.post("/auth/device-request", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({
      shopCode: shopCodeSchema, storeId: z.string().uuid(), userId: z.string().uuid(),
      pin: z.string().regex(/^\d{4,8}$/), name: z.string().trim().min(1).max(60),
    }).parse(req.body);
    const t = (await app.db.query(`SELECT id, device_auto_approve FROM tenants WHERE shop_code = $1`, [b.shopCode])).rows[0];
    if (!t) throw new HttpError(404, "كود المحل غلط");
    await assertNotLocked(app.db, t.id);
    const store = (await app.db.query(`SELECT name FROM stores WHERE id = $1 AND tenant_id = $2 AND active`, [b.storeId, t.id])).rows[0];
    if (!store) throw new HttpError(404, "الفرع غير موجود");
    await assertPinNotLocked(app.db, t.id, b.userId);
    const u = (await app.db.query(`SELECT id, name, pin_hash FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [b.userId, t.id])).rows[0];
    if (!u?.pin_hash || !(await bcrypt.compare(b.pin, u.pin_hash))) {
      if (u) await audit(app.db, { tenantId: t.id, userId: u.id, action: "device_request.pin_failed", data: { device: b.name } });
      throw new HttpError(401, "الرقم السري غير صحيح");
    }
    const token = newDeviceToken();
    const tokenHash = hashToken(token);
    if (t.device_auto_approve) {
      const d = await createDevice(app.db, { tenantId: t.id, storeId: b.storeId, name: b.name, kind: "pos", tokenHash });
      await app.db.query(
        `INSERT INTO device_requests (tenant_id, store_id, user_id, name, token_hash, status, device_id, decided_at) VALUES ($1,$2,$3,$4,$5,'approved',$6,now())`,
        [t.id, b.storeId, u.id, b.name, tokenHash, d.id],
      );
      await audit(app.db, { tenantId: t.id, userId: u.id, deviceId: d.id, action: "device.auto_approve", entity: "device", entityId: d.id, data: { name: b.name } });
      await raiseAlert(app.db, { tenantId: t.id, storeId: b.storeId, kind: "device_request", title: "🖥️ جهاز كاشير جديد دخل", body: `${u.name} دخل من جهاز جديد «${b.name}» في ${store.name}. لو مش أنت اللي سمحت، أوقفه من «الأجهزة».` });
      await flushPushes(app.db, t.id);
      return { status: "approved", deviceToken: token, device: await deviceInfo(app.db, d.id) };
    }
    // One open request per person: asking again replaces the old one.
    await app.db.query(`DELETE FROM device_requests WHERE tenant_id = $1 AND user_id = $2 AND status = 'pending'`, [t.id, u.id]);
    const r = await app.db.query(
      `INSERT INTO device_requests (tenant_id, store_id, user_id, name, token_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [t.id, b.storeId, u.id, b.name, tokenHash],
    );
    await audit(app.db, { tenantId: t.id, userId: u.id, action: "device_request.create", entity: "device_request", entityId: r.rows[0].id, data: { name: b.name } });
    await raiseAlert(app.db, { tenantId: t.id, storeId: b.storeId, kind: "device_request", title: "🖥️ جهاز جديد يبي يدخل كاشير", body: `${u.name} يبي يدخل من جهاز «${b.name}» في ${store.name}. وافق أو ارفض من التلفون.`, data: { requestId: r.rows[0].id } });
    await flushPushes(app.db, t.id);
    return { status: "pending", requestId: r.rows[0].id, deviceToken: token };
  });

  /** The waiting device asks whether the owner has answered yet. */
  app.post("/auth/device-request/status", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ requestId: z.string().uuid(), deviceToken: z.string().length(64) }).parse(req.body);
    const r = (await app.db.query(`SELECT status, device_id FROM device_requests WHERE id = $1 AND token_hash = $2`, [b.requestId, hashToken(b.deviceToken)])).rows[0];
    if (!r) return { status: "gone" };
    if (r.status === "approved" && r.device_id) return { status: "approved", device: await deviceInfo(app.db, r.device_id) };
    return { status: r.status };
  });

  /** A one-time link from the owner's phone approves the device it is opened on. */
  app.post("/auth/pair", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.body);
    const link = (await app.db.query(
      `UPDATE device_links SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, tenant_id, store_id, name, kind, created_by`,
      [hashToken(code)],
    )).rows[0];
    if (!link) throw new HttpError(410, "الرابط انتهى أو استعملوه قبل. اطلب من صاحب المحل رابط جديد");
    await assertNotLocked(app.db, link.tenant_id);
    const token = newDeviceToken();
    const d = await createDevice(app.db, { tenantId: link.tenant_id, storeId: link.store_id, name: link.name, kind: link.kind, tokenHash: hashToken(token) });
    await app.db.query(`UPDATE device_links SET device_id = $2 WHERE id = $1`, [link.id, d.id]);
    await audit(app.db, { tenantId: link.tenant_id, userId: link.created_by, deviceId: d.id, action: "device.pair_link", entity: "device", entityId: d.id, data: { name: link.name, kind: link.kind } });
    return { deviceToken: token, device: await deviceInfo(app.db, d.id) };
  });

  // ── The owner's side ───────────────────────────────────────────────────────────────
  const owners = { preHandler: requireRole("owner") };

  app.get("/devices/access", owners, async (req) => {
    const tid = req.user.tid;
    const code = await shopCode(app.db, tid);
    const auto = (await app.db.query(`SELECT device_auto_approve FROM tenants WHERE id = $1`, [tid])).rows[0].device_auto_approve as boolean;
    const requests = (await app.db.query(
      `SELECT r.id, r.name, r.created_at, u.name AS user_name, s.name AS store_name FROM device_requests r
       JOIN users u ON u.id = r.user_id JOIN stores s ON s.id = r.store_id
       WHERE r.tenant_id = $1 AND r.status = 'pending' AND r.created_at > now() - interval '7 days' ORDER BY r.created_at DESC`,
      [tid],
    )).rows;
    return { shopCode: code, autoApprove: auto, requests };
  });

  app.post("/devices/shop-code", owners, async (req) => {
    const code = await shopCode(app.db, req.user.tid, true);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "shop_code.renew" });
    return { shopCode: code };
  });

  app.patch("/devices/access", owners, async (req) => {
    const { autoApprove } = z.object({ autoApprove: z.boolean() }).parse(req.body);
    await app.db.query(`UPDATE tenants SET device_auto_approve = $2 WHERE id = $1`, [req.user.tid, autoApprove]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: autoApprove ? "device.auto_approve_on" : "device.auto_approve_off" });
    return { ok: true };
  });

  app.post("/devices/requests/:id/:answer", owners, async (req) => {
    const { id, answer } = z.object({ id: z.string().uuid(), answer: z.enum(["approve", "reject"]) }).parse(req.params);
    const tid = req.user.tid;
    const r = (await app.db.query(
      `SELECT id, store_id, name, token_hash FROM device_requests WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`, [id, tid],
    )).rows[0];
    if (!r) throw new HttpError(404, "الطلب مش موجود أو انرد عليه قبل");
    if (answer === "reject") {
      await app.db.query(`UPDATE device_requests SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [id, req.user.sub]);
      await audit(app.db, { tenantId: tid, userId: req.user.sub, action: "device_request.reject", entity: "device_request", entityId: id, data: { name: r.name } });
      return { ok: true };
    }
    const d = await createDevice(app.db, { tenantId: tid, storeId: r.store_id, name: r.name, kind: "pos", tokenHash: r.token_hash });
    await app.db.query(`UPDATE device_requests SET status = 'approved', device_id = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [id, d.id, req.user.sub]);
    await audit(app.db, { tenantId: tid, userId: req.user.sub, deviceId: d.id, action: "device.register", entity: "device", entityId: d.id, data: { name: r.name, kind: "pos", via: "request" } });
    return { ok: true, deviceId: d.id };
  });

  /** A link that approves whichever device opens it, once, within 15 minutes. */
  app.post("/devices/links", owners, async (req) => {
    const b = z.object({ storeId: z.string().uuid(), name: z.string().trim().min(1).max(60), kind: z.enum(["pos", "price_checker", "kitchen"]).default("pos") }).parse(req.body);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid]);
    if (!store.rowCount) throw new HttpError(404, "الفرع غير موجود");
    await assertWithinPlan(app.db, req.user.tid, "devices", b.kind);
    const code = randomBytes(16).toString("hex");
    const r = await app.db.query(
      `INSERT INTO device_links (tenant_id, store_id, name, kind, code_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '15 minutes') RETURNING expires_at`,
      [req.user.tid, b.storeId, b.name, b.kind, hashToken(code), req.user.sub],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "device.link_create", data: { name: b.name, kind: b.kind } });
    return { code, expiresAt: r.rows[0].expires_at };
  });
}
