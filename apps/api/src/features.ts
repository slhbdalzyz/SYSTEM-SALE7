import { FEATURES, resolveFeatures, type Feature } from "@pos/shared";
import type { Db } from "./db";
import { HttpError, type TokenPayload } from "./auth";

const featureCache = new Map<string, { at: number; f: Record<Feature, boolean> }>();
export const forgetFeatures = (tid?: string) => (tid ? featureCache.delete(tid) : featureCache.clear());
export async function tenantFeatures(db: Db, tid: string) {
  const hit = featureCache.get(tid);
  if (hit && Date.now() - hit.at < 30_000) return hit.f;
  const r = (await db.query(`SELECT t.features, p.features AS plan FROM tenants t JOIN plans p ON p.code = t.plan_code WHERE t.id = $1`, [tid])).rows[0];
  const f = resolveFeatures(r?.plan, r?.features);
  featureCache.set(tid, { at: Date.now(), f });
  return f;
}

/** Which feature a request belongs to, if the platform can close it. Reads stay open so old data shows. */
export function gatedFeature(method: string, url: string): Feature | null {
  const path = url.split("?")[0];
  const write = method !== "GET" && method !== "HEAD";
  if (/^\/zakat(\/|$)/.test(path)) return "zakat";
  if (/^\/payroll(\/|$)/.test(path)) return "payroll";
  if (/^\/counts(\/|$)/.test(path)) return "counts";
  if (write && /^\/offers(\/|$)/.test(path)) return "offers";
  if (write && /^\/quick-(keys|groups)(\/|$)/.test(path)) return "quick_keys";
  if (write && /^\/loyalty\/settings$/.test(path)) return "loyalty";
  return null;
}


/**
 * Run before every route with a token: a platform support session (with the owner's consent) only
 * looks, with no writes and no full copy of the data; and features the platform closed for this
 * plan or shop answer 403.
 */
export async function checkTokenRules(db: Db, method: string, url: string, verify: () => Promise<TokenPayload>) {
  let u: TokenPayload;
  try {
    u = await verify();
  } catch {
    return;
  }
  if (u.role === "platform" || !u.tid) return;
  if (u.ro) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(403, "وضع الدعم: قراءة بس، ما يقدرش يغيّر شي");
    if (/^\/(backup|restore|owner\/backup)/.test(url)) throw new HttpError(403, "النسخة الاحتياطية مش متاحة في وضع الدعم");
  }
  const f = gatedFeature(method, url);
  if (f && !(await tenantFeatures(db, u.tid))[f]) throw new HttpError(403, `ميزة «${FEATURES[f]}» مش ضمن باقتك. تواصل معانا لتفعيلها`);
}
