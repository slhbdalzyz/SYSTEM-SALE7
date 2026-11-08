import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { effectivePermissions, platformCan, type Permission, type PlatformPerm, type PlatformRole, type Role } from "@pos/shared";

export interface TokenPayload {
  sub: string; // user id
  tid: string; // tenant id
  role: Role | "platform"; // "platform" = staff running the service, with no shop (tid is "")
  did?: string; // device id, present for cashier sessions on a registered device
  sid?: string; // store id of that device
  ro?: boolean; // read-only: platform support looking at a shop, with the owner's consent
  imp?: string; // the platform staff member behind a support session
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by platformGuard: the platform staff member making the call. */
    platform?: { id: string; role: PlatformRole; agentId: string | null; name: string };
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

export function newDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function authenticate(req: FastifyRequest) {
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, "غير مصرح");
  }
  if (req.user.role === "platform") throw new HttpError(403, "هذا حساب إدارة المنصة، مش حساب محل");
  if (req.user.ro && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(403, "وضع الدعم: قراءة بس، ما يقدرش يغيّر شي");
}

/**
 * Platform staff only, and only what their role allows. The row is read on every call, so a staff
 * member switched off or moved to another role is cut off at once, not when their token runs out.
 */
export function platformGuard(perm?: PlatformPerm) {
  return async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new HttpError(401, "غير مصرح");
    }
    if (req.user.role !== "platform") throw new HttpError(403, "ليس لديك صلاحية");
    const a = (await req.server.db.query(`SELECT id, name, role, agent_id, active FROM platform_admins WHERE id = $1`, [req.user.sub])).rows[0];
    if (!a?.active) throw new HttpError(401, "الحساب موقوف");
    req.platform = { id: a.id, role: a.role, agentId: a.agent_id, name: a.name };
    if (perm && !platformCan(a.role, perm)) throw new HttpError(403, "ليس لديك صلاحية");
  };
}

export const requirePlatform = platformGuard();

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(req);
    if (!roles.includes(req.user.role as Role)) throw new HttpError(403, "ليس لديك صلاحية");
  };
}

/**
 * Lets the owner through, and anyone else whose permissions include one of these.
 * Permissions are read from the database on every call, so a change or a suspended account
 * takes effect at once, without waiting for the person's login to expire.
 */
export function requirePerm(...perms: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(req);
    if (req.user.role === "owner") return;
    const u = (await req.server.db.query(`SELECT role, permissions FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [req.user.sub, req.user.tid])).rows[0];
    if (!u) throw new HttpError(401, "الحساب موقوف");
    const mine = effectivePermissions(u.role, u.permissions);
    if (!perms.some((p) => mine.includes(p))) throw new HttpError(403, "ليس لديك صلاحية");
  };
}

export async function requireDevice(req: FastifyRequest) {
  await authenticate(req);
  if (!req.user.did || !req.user.sid) throw new HttpError(403, "هذه العملية تحتاج جهاز كاشير معتمد");
}

/** Checks a manager's PIN typed on a cashier's device. Returns the approver's id. */
export async function verifyApproval(
  db: { query: (q: string, a: unknown[]) => Promise<{ rows: { id: string; pin_hash: string | null; role: Role }[] }> },
  tenantId: string,
  approval: { userId: string; pin: string } | undefined,
): Promise<string> {
  if (!approval) throw new HttpError(403, "تحتاج موافقة المدير");
  const u = (await db.query(`SELECT id, pin_hash, role FROM users WHERE id = $1 AND tenant_id = $2 AND active`, [approval.userId, tenantId])).rows[0];
  if (!u || !["owner", "manager"].includes(u.role) || !u.pin_hash || !(await bcrypt.compare(approval.pin, u.pin_hash))) {
    throw new HttpError(403, "موافقة المدير غير صحيحة");
  }
  return u.id;
}
