/**
 * Time-based one-time codes (RFC 6238), the six digits an authenticator app shows. Uses Web
 * Crypto, which both the server (Node 20+) and the browser demo have.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out) as Uint8Array<ArrayBuffer>;
}

/** A new random secret (20 bytes), in base32 as authenticator apps expect. */
export function newTotpSecret(): string {
  const b = new Uint8Array(20);
  globalThis.crypto.getRandomValues(b);
  return base32Encode(b);
}

/** The code for one 30-second step. */
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step >>> 0);
  const h = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Accepts the current code, or the one just before or after it (clocks drift). */
export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) if ((await totpCode(secret, step + d)) === c) return true;
  return false;
}

/** The link an authenticator app reads (as a QR code, or tapped on the phone). */
export const totpUri = (secret: string, account: string, issuer = "نظام نقاط البيع") =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
