import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { phpUrlencode, plutuGateway, signedString } from "../src/payments/plutu";

describe("Plutu adapter", () => {
  it("encodes like PHP's http_build_query", () => {
    expect(phpUrlencode("a b*c~d.e-f_g")).toBe("a+b%2Ac%7Ed.e-f_g");
    expect(signedString("hashed=X&amount=10.50&gateway=localbankcards&x=1&invoice_no=A%20B", ["gateway", "amount", "invoice_no"]))
      .toBe("amount=10.50&gateway=localbankcards&invoice_no=A+B");
  });

  it("accepts a return signed with the secret and nothing else", () => {
    const g = plutuGateway({ apiKey: "k", accessToken: "t", secretKey: "secret" });
    const q = "gateway=localbankcards&canceled=1&invoice_no=INV1&amount=150.00";
    const h = createHmac("sha256", "secret").update(q).digest("hex").toUpperCase();
    expect(g.verifyReturn(`${q}&hashed=${h}`)).toEqual({ invoiceNo: "INV1", approved: false, canceled: true, transactionId: null, amount: "150.00" });
    expect(g.verifyReturn(`${q}&hashed=${h.toLowerCase()}`)).toBeNull();
    expect(g.verifyReturn(`${q.replace("canceled", "approved")}&hashed=${h}`)).toBeNull();
  });

  it("posts form data with its keys and turns gateway errors into plain Arabic", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const g = plutuGateway({
      apiKey: "KEY", accessToken: "TOKEN", secretKey: "s",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/verify")) return new Response(JSON.stringify({ status: 200, result: { process_id: 4242 } }));
        return new Response(JSON.stringify({ error: { status: 400, code: "OTP_EXPIRED", message: "expired" } }), { status: 400 });
      }) as typeof fetch,
    });
    expect(await g.sendOtp("edfali", "12.00", "0913632323")).toEqual({ processId: "4242" });
    expect(calls[0].url).toBe("https://api.plutus.ly/api/v1/transaction/edfali/verify");
    expect(calls[0].init.headers).toMatchObject({ "X-API-KEY": "KEY", Authorization: "Bearer TOKEN" });
    expect(String(calls[0].init.body)).toBe("mobile_number=0913632323&amount=12.00");
    await expect(g.confirmOtp("sadad", "1", "000000", "12.00", "INV")).rejects.toMatchObject({ code: "OTP_EXPIRED", message: "الرمز انتهت صلاحيته، اطلب رمز جديد" });
    expect(calls[1].url).toBe("https://api.plutus.ly/api/v1/transaction/sadadapi/confirm");
  });
});
