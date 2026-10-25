// Plutu (plutu.ly): one API for Libyan bank cards, Sadad (Almadar) and Edfali. Follows
// docs.plutu.ly and the official plutu-php SDK: form-encoded POSTs with an API key and a bearer
// token; card payments come back to return_url signed with HMAC-SHA256 of the query string.
import { createHmac, timingSafeEqual } from "node:crypto";
import { GatewayError, gatewayMessage, PAY_METHODS, type Gateway, type PayMethod, type ReturnResult } from "./gateway";

export interface PlutuConfig {
  apiKey: string;
  accessToken: string;
  secretKey: string;
  baseUrl?: string;
  test?: boolean;
  methods?: PayMethod[];
  fetch?: typeof fetch;
}

const GATEWAY: Record<PayMethod, string> = { localbankcards: "localbankcards", sadad: "sadadapi", edfali: "edfali" };

/** PHP's urlencode, which http_build_query uses: spaces as "+", only A–Z a–z 0–9 - _ . left as they are. */
export function phpUrlencode(s: string) {
  return encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
}

/** The string Plutu signs: the listed parameters, in the order they came, as http_build_query writes them. */
export function signedString(rawQuery: string, keys: string[]) {
  const pairs: string[] = [];
  for (const part of rawQuery.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    const key = decodeURIComponent(k.replace(/\+/g, " "));
    if (!keys.includes(key)) continue;
    pairs.push(`${phpUrlencode(key)}=${phpUrlencode(decodeURIComponent(v.replace(/\+/g, " ")))}`);
  }
  return pairs.join("&");
}

export function plutuSignature(data: string, secret: string) {
  return createHmac("sha256", secret).update(data).digest("hex").toUpperCase();
}

const CARD_KEYS = ["gateway", "approved", "canceled", "invoice_no", "amount", "transaction_id"];

export function plutuGateway(cfg: PlutuConfig): Gateway {
  const base = (cfg.baseUrl ?? "https://api.plutus.ly/api/v1").replace(/\/$/, "");
  const doFetch = cfg.fetch ?? fetch;

  async function call(method: PayMethod, action: string, params: Record<string, string | undefined>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, v);
    let res: Response;
    try {
      res = await doFetch(`${base}/transaction/${GATEWAY[method]}/${action}`, {
        method: "POST",
        headers: { Accept: "application/json", "X-API-KEY": cfg.apiKey, Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GatewayError("NETWORK", "ما قدرناش نوصلوا لبوابة الدفع، جرّب بعد شوية");
    }
    const json = (await res.json().catch(() => ({}))) as { result?: Record<string, string>; error?: { code?: string; message?: string } };
    if (!res.ok || json.error) {
      const code = json.error?.code ?? `HTTP_${res.status}`;
      throw new GatewayError(code, gatewayMessage(code, json.error?.message ?? "بوابة الدفع رفضت العملية"));
    }
    return json.result ?? {};
  }

  return {
    name: "plutu",
    test: cfg.test ?? false,
    methods: cfg.methods ?? [...PAY_METHODS],
    async checkout(method, amount, invoiceNo, returnUrl, lang = "ar") {
      const r = await call(method, "confirm", { amount, invoice_no: invoiceNo, return_url: returnUrl, lang });
      if (!r.redirect_url) throw new GatewayError("NO_REDIRECT", "بوابة الدفع ما رجعتش رابط الدفع");
      return { redirectUrl: r.redirect_url };
    },
    async sendOtp(method, amount, mobile, birthYear) {
      const r = await call(method, "verify", { mobile_number: mobile, birth_year: method === "sadad" ? birthYear : undefined, amount });
      if (!r.process_id) throw new GatewayError("NO_PROCESS", "بوابة الدفع ما رجعتش رقم العملية");
      return { processId: String(r.process_id) };
    },
    async confirmOtp(method, processId, code, amount, invoiceNo) {
      const r = await call(method, "confirm", { process_id: processId, code, amount, invoice_no: invoiceNo });
      if (!r.transaction_id) throw new GatewayError("NO_TRANSACTION", "ما وصلش رقم العملية من البوابة");
      return { transactionId: String(r.transaction_id) };
    },
    verifyReturn(rawQuery): ReturnResult | null {
      const q = new URLSearchParams(rawQuery);
      const got = q.get("hashed") ?? "";
      const want = plutuSignature(signedString(rawQuery, CARD_KEYS), cfg.secretKey);
      if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
      return {
        invoiceNo: q.get("invoice_no") ?? "",
        approved: q.get("approved") === "1",
        canceled: q.get("canceled") === "1",
        transactionId: q.get("transaction_id"),
        amount: q.get("amount"),
      };
    },
  };
}

/** Plutu from the environment, or nothing when its keys are not set. */
export function plutuFromEnv(env: NodeJS.ProcessEnv = process.env): Gateway | null {
  if (!env.PLUTU_API_KEY || !env.PLUTU_ACCESS_TOKEN || !env.PLUTU_SECRET_KEY) return null;
  const methods = env.PLUTU_METHODS?.split(",").map((m) => m.trim()).filter((m): m is PayMethod => (PAY_METHODS as readonly string[]).includes(m));
  return plutuGateway({
    apiKey: env.PLUTU_API_KEY,
    accessToken: env.PLUTU_ACCESS_TOKEN,
    secretKey: env.PLUTU_SECRET_KEY,
    baseUrl: env.PLUTU_BASE_URL,
    test: env.PLUTU_TEST === "1",
    methods: methods?.length ? methods : undefined,
  });
}
