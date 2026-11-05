import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { PERMISSION_KEYS, ROLES, effectivePermissions, type Permission } from "@pos/shared";
import { audit } from "../db";
import { HttpError, hashToken, newDeviceToken, requirePerm, requireRole } from "../auth";
import { assertWithinPlan } from "../billing";

const userSchema = z.object({
  name: z.string().min(2).max(120),
  role: z.enum(ROLES),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  email: z.string().email().nullable().optional(),
  password: z.string().min(8).optional(),
  active: z.boolean().optional(),
  jobTitle: z.string().max(80).nullable().optional(),
  /** null = what the job normally has. */
  permissions: z.array(z.enum(PERMISSION_KEYS as [Permission, ...Permission[]])).nullable().optional(),
  salaryMinor: z.number().int().min(0).optional(),
  dayMinutes: z.number().int().min(60).max(1440).optional(),
  hiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
type UserInput = Partial<z.infer<typeof userSchema>>;

/** The permissions of whoever is asking. */
export async function myPermissions(app: FastifyInstance, user: { sub: string; tid: string; role: string }): Promise<Permission[]> {
  if (user.role === "owner") return [...PERMISSION_KEYS];
  const u = (await app.db.query(`SELECT role, permissions FROM users WHERE id = $1 AND tenant_id = $2`, [user.sub, user.tid])).rows[0];
  return u ? effectivePermissions(u.role, u.permissions) : [];
}

export async function adminRoutes(app: FastifyInstance) {
  const managers = { preHandler: requirePerm("devices") };
  const owners = { preHandler: requireRole("owner") };
  const staff = { preHandler: requirePerm("staff", "payroll") };

  /**
   * Someone who is not the owner can only give what they have themselves, never make an owner,
   * and only someone allowed to handle pay can see or change a salary.
   */
  async function checkGrant(req: { user: { sub: string; tid: string; role: string } }, b: UserInput, target?: { role: string; permissions: string[] | null }) {
    const mine = await myPermissions(app, req.user);
    const touchesPay = b.salaryMinor !== undefined || b.dayMinutes !== undefined || b.hiredOn !== undefined;
    const touchesAccount = Object.keys(b).some((k) => !["salaryMinor", "dayMinutes", "hiredOn", "jobTitle"].includes(k));
    if (touchesPay && !mine.includes("payroll")) throw new HttpError(403, "تعديل الراتب يحتاج صلاحية الرواتب");
    if (touchesAccount && !mine.includes("staff")) throw new HttpError(403, "ليس لديك صلاحية على الموظفين");
    if (req.user.role === "owner") return;
    if (b.role === "owner" || target?.role === "owner") throw new HttpError(403, "فقط صاحب المحل يعدل حساب المالك");
    const role = b.role ?? target?.role ?? "cashier";
    const perms = b.permissions !== undefined ? b.permissions : (target?.permissions ?? null);
    if (effectivePermissions(role, perms).some((p) => !mine.includes(p))) throw new HttpError(403, "ما تقدرش تعطي صلاحية ما عندكش");
  }

  app.get("/users", staff, async (req) => {
    const pay = (await myPermissions(app, req.user)).includes("payroll");
    const r = await app.db.query(
      `SELECT id, name, email, role, job_title, permissions, active, pin_hash IS NOT NULL AS has_pin,
              salary_minor, day_minutes, to_char(hired_on, 'YYYY-MM-DD') AS hired_on
       FROM users WHERE tenant_id = $1 ORDER BY active DESC, created_at`,
      [req.user.tid],
    );
    return r.rows.map((u) => ({
      ...u,
      effective: effectivePermissions(u.role, u.permissions),
      ...(pay ? {} : { salary_minor: null, day_minutes: null, hired_on: null }),
    }));
  });

  app.post("/users", staff, async (req) => {
    const b = userSchema.parse(req.body);
    await checkGrant(req, b);
    if (!b.pin && !b.password) throw new HttpError(400, "لازم رقم سري أو كلمة سر");
    if (b.password && !b.email) throw new HttpError(400, "كلمة السر تحتاج بريد إلكتروني للدخول");
    await assertWithinPlan(app.db, req.user.tid, "users");
    try {
      const r = await app.db.query(
        `INSERT INTO users (tenant_id, name, role, email, password_hash, pin_hash, job_title, permissions, salary_minor, day_minutes, hired_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          req.user.tid, b.name, b.role, b.email?.toLowerCase() ?? null,
          b.password ? await bcrypt.hash(b.password, 12) : null,
          b.pin ? await bcrypt.hash(b.pin, 10) : null,
          b.jobTitle ?? null, b.permissions ?? null, b.salaryMinor ?? 0, b.dayMinutes ?? 480, b.hiredOn ?? null,
        ],
      );
      await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: "user.create", entity: "user", entityId: r.rows[0].id, data: { name: b.name, role: b.role, permissions: b.permissions ?? null } });
      return { id: r.rows[0].id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "البريد هذا مستعمل لحساب ثاني");
      throw e;
    }
  });

  app.patch("/users/:id", staff, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = userSchema.partial().parse(req.body);
    const target = (await app.db.query(`SELECT role, active, permissions FROM users WHERE id = $1 AND tenant_id = $2`, [id, req.user.tid])).rows[0];
    if (!target) throw new HttpError(404, "المستخدم غير موجود");
    await checkGrant(req, b, target);
    if (id === req.user.sub && (b.active === false || (b.role && b.role !== target.role))) throw new HttpError(400, "ما تقدرش توقف أو تغير دور حسابك");
    if (b.active && !target.active) await assertWithinPlan(app.db, req.user.tid, "users");
    const sets: string[] = [];
    const args: unknown[] = [id, req.user.tid];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (b.name !== undefined) set("name", b.name);
    if (b.role !== undefined) set("role", b.role);
    if (b.active !== undefined) set("active", b.active);
    if (b.pin) set("pin_hash", await bcrypt.hash(b.pin, 10));
    if (b.email !== undefined) set("email", b.email?.toLowerCase() ?? null);
    if (b.password) set("password_hash", await bcrypt.hash(b.password, 12));
    if (b.jobTitle !== undefined) set("job_title", b.jobTitle);
    if (b.permissions !== undefined) set("permissions", b.permissions);
    if (b.salaryMinor !== undefined) set("salary_minor", b.salaryMinor);
    if (b.dayMinutes !== undefined) set("day_minutes", b.dayMinutes);
    if (b.hiredOn !== undefined) set("hired_on", b.hiredOn);
    if (!sets.length) return { ok: true };
    try {
      await app.db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2`, args);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(409, "البريد هذا مستعمل لحساب ثاني");
      throw e;
    }
    // A raise counts from this month on; months already started before keep their salary.
    if (b.salaryMinor !== undefined) {
      await app.db.query(
        `UPDATE payroll_months SET salary_minor = $3 WHERE user_id = $1 AND tenant_id = $2 AND month = date_trunc('month', now())::date`,
        [id, req.user.tid, b.salaryMinor],
      );
    }
    await audit(app.db, {
      tenantId: req.user.tid, userId: req.user.sub, action: "user.update", entity: "user", entityId: id,
      data: { ...b, pin: b.pin ? "***" : undefined, password: b.password ? "***" : undefined },
    });
    return { ok: true };
  });

  app.get("/devices", managers, async (req) => {
    const r = await app.db.query(
      `SELECT id, store_id, name, prefix, kind, active, backup, last_seen_at FROM devices WHERE tenant_id = $1 ORDER BY created_at`,
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
    const b = z.object({
      name: z.string().min(1).optional(),
      address: z.string().nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      receiptFooter: z.string().max(300).nullable().optional(),
      active: z.boolean().optional(),
    }).parse(req.body);
    if (b.active === false) {
      const others = await app.db.query(`SELECT 1 FROM stores WHERE tenant_id = $1 AND active AND id <> $2`, [req.user.tid, id]);
      if (!others.rowCount) throw new HttpError(400, "لازم يبقى فرع واحد شغال على الأقل");
    }
    const r = await app.db.query(
      `UPDATE stores SET name = COALESCE($3, name), address = COALESCE($4, address), receipt_footer = COALESCE($5, receipt_footer),
              phone = COALESCE($6, phone), active = COALESCE($7, active) WHERE id = $1 AND tenant_id = $2`,
      [id, req.user.tid, b.name ?? null, b.address ?? null, b.receiptFooter ?? null, b.phone ?? null, b.active ?? null],
    );
    if (!r.rowCount) throw new HttpError(404, "الفرع غير موجود");
    if (b.active !== undefined) await audit(app.db, { tenantId: req.user.tid, userId: req.user.sub, action: b.active ? "store.enable" : "store.disable", entity: "store", entityId: id });
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
