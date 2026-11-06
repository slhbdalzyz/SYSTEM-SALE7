import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, newTotpSecret, totpCode, totpUri, verifyTotp } from "../src/totp";

describe("authenticator codes (TOTP)", () => {
  it("matches the RFC 6238 test vector", async () => {
    // Secret "12345678901234567890", time 59 s -> 94287082 (8 digits); the 6-digit code is its last six.
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe("287082");
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("round-trips base32 and accepts the code one step either side", async () => {
    const s = newTotpSecret();
    expect(base32Encode(base32Decode(s))).toBe(s);
    const now = 1_700_000_000_000;
    const code = await totpCode(s, Math.floor(now / 30000));
    expect(await verifyTotp(s, code, now)).toBe(true);
    expect(await verifyTotp(s, code, now + 30000)).toBe(true);
    expect(await verifyTotp(s, code, now + 95000)).toBe(false);
    expect(await verifyTotp(s, "12345", now)).toBe(false);
    expect(totpUri(s, "a@b.ly", "Sale7 POS")).toMatch(/^otpauth:\/\/totp\/Sale7%20POS(:|%3A)a%40b\.ly\?secret=[A-Z2-7]+&issuer=Sale7%20POS/);
  });
});
