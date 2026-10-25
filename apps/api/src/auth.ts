import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@pos/shared";

export interface TokenPayload {
  sub: string; // user id
  tid: string; // tenant id
  role: Role | "platform"; // "platform" = staff running the service, with no shop (tid is "")
  did?: string; // device id, present for cashier sessions on a registered device
  sid?: string; // store id of that device
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
}

export async function requirePlatform(req: FastifyRequest) {
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, "غير مصرح");
  }
  if (req.user.role !== "platform") throw new HttpError(403, "ليس لديك صلاحية");
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(req);
    if (!roles.includes(req.user.role as Role)) throw new HttpError(403, "ليس لديك صلاحية");
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
