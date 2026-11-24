// Licence keys for the desktop's local edition: who the shop is, which computer, and until when,
// signed by the platform with Ed25519. The app carries the platform's public key and checks a key
// with no internet; a key cannot be moved to another computer or have its date changed.
//
// A key reads "S7L1.<payload>.<signature>", both parts base64url.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export interface LicensePayload {
  v: 1;
  /** The licence row; renewals have their own id and share the first one's root. */
  id: string;
  root: string;
  shop: string;
  machine: string;
  /** YYYY-MM-DD, the last day included. */
  from: string;
  until: string;
  devices: number;
  issued: string;
  /** The package's name (صغير، متوسط، كبير), for the shop's licence screen. Older keys have none. */
  plan?: string;
}

export class LicenseError extends Error {
  statusCode = 400;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function signLicense(p: LicensePayload, privateKeyDerB64: string): string {
  const body = b64u(Buffer.from(JSON.stringify(p)));
  const key = createPrivateKey({ key: Buffer.from(privateKeyDerB64, "base64"), format: "der", type: "pkcs8" });
  return `S7L1.${body}.${b64u(sign(null, Buffer.from(body), key))}`;
}

/** The payload of a genuine key, signed by one of `publicKeys` (SPKI DER, base64). Throws otherwise. */
export function readLicense(text: string, publicKeys: string[]): LicensePayload {
  const key = text.replace(/\s+/g, "");
  const [tag, body, sig] = key.split(".");
  if (tag !== "S7L1" || !body || !sig) throw new LicenseError("هذا مش مفتاح تفعيل صحيح. انسخه كامل كما وصلك");
  const ok = publicKeys.some((pk) => {
    try {
      return verify(null, Buffer.from(body), createPublicKey({ key: Buffer.from(pk, "base64"), format: "der", type: "spki" }), Buffer.from(sig, "base64url"));
    } catch {
      return false;
    }
  });
  if (!ok) throw new LicenseError("مفتاح التفعيل غير صحيح أو متعدّل");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LicensePayload;
  if (p.v !== 1) throw new LicenseError("مفتاح من إصدار أحدث. حدّث البرنامج");
  return p;
}

export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** A computer's ID as people read it out: 16 letters and digits from a hash of its own ID. */
export function formatMachineId(raw: string) {
  const h = createHash("sha256").update(`sale7:${raw.trim().toLowerCase()}`).digest("hex").slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join("-");
}

export const normalizeMachineId = (s: string) => s.toUpperCase().replace(/[^0-9A-F]/g, "").replace(/(.{4})(?=.)/g, "$1-");
