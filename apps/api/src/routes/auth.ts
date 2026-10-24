import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, inTx } from "../db";
import { HttpError, authenticate, hashToken, type TokenPayload } from "../auth";
import { assertNotLocked } from "../billing";

const registerSchema = z.object({
  businessName: z.string().min(2).max(120),
  storeName: z.string().min(2).max(120),
  phone: z.string().max(40).optional(),
  planCode: z.string().max(30).optional(),
  ownerName: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const pinSchema = z.object({ deviceToken: z.string().length(64), userId: z.string().uuid(), pin: z.string().regex(/^\d{4,8}$/) });

export async function authRoutes(app: FastifyInstance) {
  const sign = (p: TokenPayload, expiresIn: string) => app.jwt.sign(p, { expiresIn });
  const loginLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/auth/register", loginLimit, async (req) => {
    const b = registerSchema.parse(req.body);
    const email = b.email.toLowerCase();
    const exists = await app.db.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (exists.rowCount) throw new HttpError(409, "البريد مسجل من قبل");
    const hash = await bcrypt.hash(b.password, 12);
    const out = await inTx(app.db, async (tx) => {
      // Every new shop starts on a 14-day free trial of the plan it picked.
      const plan = b.planCode && (await tx.query(`SELECT 1 FROM plans WHERE code = $1 AND active`, [b.planCode])).rowCount ? b.planCode : "basic";
      const t = await tx.query(
        `INSERT INTO tenants (name, phone, plan_code, status, paid_until) VALUES ($1,$2,$3,'trial', now() + interval '14 days') RETURNING id`,
        [b.businessName, b.phone ?? null, plan],
      );
      const tid = t.rows[0].id as string;
      const s = await tx.query(`INSERT INTO stores (tenant_id, name) VALUES ($1,$2) RETURNING id`, [tid, b.storeName]);
      const u = await tx.query(
        `INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id`,
        [tid, b.ownerName, email, hash],
      );
      await audit(tx, { tenantId: tid, userId: u.rows[0].id, action: "tenant.register" });
      return { tid, sid: s.rows[0].id as string, uid: u.rows[0].id as string };
    });
    return { token: sign({ sub: out.uid, tid: out.tid, role: "owner" }, "12h"), tenantId: out.tid, storeId: out.sid };
  });

  app.post("/auth/login", loginLimit, async (req) => {
    const b = loginSchema.parse(req.body);
    const r = await app.db.query(
      `SELECT id, tenant_id, role, password_hash FROM users WHERE email = $1 AND active`,
      [b.email.toLowerCase()],
    );
    const u = r.rows[0];
    if (!u?.password_hash || !(await bcrypt.compare(b.password, u.password_hash))) {
      throw new HttpError(401, "البريد أو كلمة السر غير صحيحة");
    }
    await audit(app.db, { tenantId: u.tenant_id, userId: u.id, action: "user.login" });
    return { token: sign({ sub: u.id, tid: u.tenant_id, role: u.role }, "12h") };
  });

  /** Staff on a registered device pick their name and type a PIN. */
  app.post("/auth/pin", loginLimit, async (req) => {
    const b = pinSchema.parse(req.body);
    const d = (await app.db.query(`SELECT id, tenant_id, store_id FROM devices WHERE token_hash = $1 AND active AND kind = 'pos'`, [hashToken(b.deviceToken)])).rows[0];
    if (!d) throw new HttpError(401, "الجهاز غير معتمد");
    await assertNotLocked(app.db, d.tenant_id);
    const u = (await app.db.query(`SELECT id, role, pin_hash FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [b.userId, d.tenant_id])).rows[0];
    if (!u?.pin_hash || !(await bcrypt.compare(b.pin, u.pin_hash))) {
      await audit(app.db, { tenantId: d.tenant_id, userId: b.userId, deviceId: d.id, action: "user.pin_failed" });
      throw new HttpError(401, "الرقم السري غير صحيح");
    }
    await app.db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [d.id]);
    await audit(app.db, { tenantId: d.tenant_id, userId: u.id, deviceId: d.id, action: "user.pin_login" });
    return { token: sign({ sub: u.id, tid: d.tenant_id, role: u.role, did: d.id, sid: d.store_id }, "16h") };
  });

  /** The device lists who may sign in on it, before anyone is signed in. */
  app.post("/auth/device-users", async (req) => {
    const { deviceToken } = z.object({ deviceToken: z.string().length(64) }).parse(req.body);
    const d = (await app.db.query(`SELECT d.id, d.tenant_id, d.name, d.prefix, s.name AS store_name FROM devices d JOIN stores s ON s.id = d.store_id WHERE d.token_hash = $1 AND d.active AND d.kind = 'pos'`, [hashToken(deviceToken)])).rows[0];
    if (!d) throw new HttpError(401, "الجهاز غير معتمد");
    const users = await app.db.query(
      `SELECT id, name, role FROM users WHERE tenant_id = $1 AND active AND pin_hash IS NOT NULL ORDER BY name`,
      [d.tenant_id],
    );
    return { device: { id: d.id, name: d.name, prefix: d.prefix, storeName: d.store_name }, users: users.rows };
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    const u = (await app.db.query(`SELECT id, name, email, role FROM users WHERE id = $1 AND tenant_id = $2`, [req.user.sub, req.user.tid])).rows[0];
    const t = (await app.db.query(`SELECT id, name, currency, business_type FROM tenants WHERE id = $1`, [req.user.tid])).rows[0];
    const stores = await app.db.query(`SELECT id, name, address, receipt_footer FROM stores WHERE tenant_id = $1 ORDER BY created_at`, [req.user.tid]);
    return { user: u, tenant: t, stores: stores.rows, deviceId: req.user.did ?? null, storeId: req.user.sid ?? null };
  });
}
