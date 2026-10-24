import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ROLES } from "@pos/shared";
import { audit } from "../db";
import { HttpError, hashToken, newDeviceToken, requireRole } from "../auth";
import { assertWithinPlan } from "../billing";

const userSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.enum(ROLES),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  active: z.boolean().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  const managers = { preHandler: requireRole("owner", "manager") };
  const owners = { preHandler: requireRole("owner") };

  app.get("/users", managers, async (req) => {
    const r = await app.db.query(
      `SELECT id, name, email, role, active, pin_hash IS NOT NULL AS has_pin FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [req.user.tid],
    );
    return r.rows;
  });

  app.post("/users", managers, async (req) => {
    const b = userSchema.parse(req.body);
    if (b.role === "owner" && req.user.role !== "owner") throw new HttpError(403, "فقط المالك يضيف مالك");
    if (!b.pin && !b.password) throw new HttpError(400, "لازم رقم سري أو كلمة سر");
    await assertWithinPlan(app.db, req.user.tid, "users");
    const r = await app.db.query(
      `INSERT INTO users (tenant_id, name, role, email, password_hash, pin_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        req.user.tid,
        b.name,
        b.role,
        b.email?.toLowerCase() ?? null,
        b.password ? await bcrypt.hash(b.password, 12) : null,
        b.pin ? await bcrypt.hash(b.pin, 10) : null,
      ],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "user.create", entity: "user", entityId: r.rows[0].id, data: { name: b.name, role: b.role } });
    return { id: r.rows[0].id };
  });

  app.patch("/users/:id", managers, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = userSchema.partial().parse(req.body);
    const target = (await app.db.query(`SELECT role, active FROM users WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!target) throw new HttpError(404, "المستخدم غير موجود");
    if ((target.role === "owner" || b.role === "owner") && req.user.role !== "owner") throw new HttpError(403, "ليس لديك صلاحية");
    if (b.active && !target.active) await assertWithinPlan(app.db, req.user.tid, "users");
    await app.db.query(
      `UPDATE users SET name = COALESCE($3, name), role = COALESCE($4, role), active = COALESCE($5, active),
         pin_hash = COALESCE($6, pin_hash) WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, b.name ?? null, b.role ?? null, b.active ?? null, b.pin ? await bcrypt.hash(b.pin, 10) : null],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "user.update", entity: "user", entityId: id, data: { ...b, pin: b.pin ? "***" : undefined } });
    return { ok: true };
  });

  app.get("/devices", managers, async (req) => {
    const r = await app.db.query(
      `SELECT id, store_id, name, prefix, kind, active, last_seen_at FROM devices WHERE tenant_id = $1 ORDER BY created_at`,
      [req.user.tid],
    );
    return r.rows;
  });

  /** Registers a cashier device. The token is returned once and only its hash is stored. */
  app.post("/devices", owners, async (req) => {
    const b = z.object({ storeId: z.string().uuid(), name: z.string().min(1).max(60), kind: z.enum(["pos", "price_checker"]).default("pos") }).parse(req.body);
    const store = await app.db.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2`, [b.storeId, req.user.tid]);
    if (!store.rowCount) throw new HttpError(404, "الفرع غير موجود");
    await assertWithinPlan(app.db, req.user.tid, "devices");
    const n = (await app.db.query(`SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1`, [req.user.tid])).rows[0].n as number;
    const prefix = `P${n + 1}`;
    const token = newDeviceToken();
    const r = await app.db.query(
      `INSERT INTO devices (tenant_id, store_id, name, prefix, token_hash, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.tid, b.storeId, b.name, prefix, hashToken(token), b.kind],
    );
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "device.register", entity: "device", entityId: r.rows[0].id, data: { name: b.name, kind: b.kind } });
    return { id: r.rows[0].id, prefix, kind: b.kind, deviceToken: token };
  });

  app.patch("/devices/:id", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    const was = (await app.db.query(`SELECT active FROM devices WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (b.active && was && !was.active) await assertWithinPlan(app.db, req.user.tid, "devices");
    await app.db.query(`UPDATE devices SET active = $3 WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid, b.active]);
    await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: b.active ? "device.enable" : "device.disable", entity: "device", entityId: id });
    return { ok: true };
  });

  app.patch("/stores/:id", owners, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ name: z.string().min(1).optional(), address: z.string().nullable().optional(), receiptFooter: z.string().max(300).nullable().optional() }).parse(req.body);
    await app.db.query(
      `UPDATE stores SET name = COALESCE($3, name), address = COALESCE($4, address), receipt_footer = COALESCE($5, receipt_footer) WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, b.name ?? null, b.address ?? null, b.receiptFooter ?? null],
    );
    return { ok: true };
  });

  app.get("/audit", owners, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r = await app.db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, a.created_at, u.name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 ORDER BY a.id DESC LIMIT $2`,
      [req.user.tid, limit],
    );
    return r.rows;
  });
}
