import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@pos/shared";

export interface TokenPayload {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
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
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await authenticate(req);
    if (!roles.includes(req.user.role)) throw new HttpError(403, "ليس لديك صلاحية");
  };
}

export async function requireDevice(req: FastifyRequest) {
  await authenticate(req);
  if (!req.user.did || !req.user.sid) throw new HttpError(403, "هذه العملية تحتاج جهاز كاشير معتمد");
}
