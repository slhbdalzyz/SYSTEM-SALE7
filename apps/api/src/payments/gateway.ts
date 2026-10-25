// Online payment for subscriptions. The routes talk to a Gateway; which one depends on the
// deployment: Plutu (Libyan cards, Sadad, Edfali) when its keys are set, a stand-in for the demo
// and tests, or none, in which case shops pay by bank transfer as before.

export const PAY_METHODS = ["localbankcards", "sadad", "edfali"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export class GatewayError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface ReturnResult {
  invoiceNo: string;
  approved: boolean;
  canceled: boolean;
  transactionId: string | null;
  amount: string | null;
}

export interface Gateway {
  name: string;
  /** Test credentials: no real money moves. */
  test: boolean;
  methods: PayMethod[];
  /** Card payments: the customer is sent to the gateway's page and comes back to returnUrl. */
  checkout(method: PayMethod, amount: string, invoiceNo: string, returnUrl: string, lang?: "ar" | "en"): Promise<{ redirectUrl: string }>;
  /** Wallet payments: the gateway texts a code to the customer's phone. */
  sendOtp(method: PayMethod, amount: string, mobile: string, birthYear?: string): Promise<{ processId: string }>;
  confirmOtp(method: PayMethod, processId: string, code: string, amount: string, invoiceNo: string): Promise<{ transactionId: string }>;
  /** Checks the signed query string the gateway sends the customer back with. Null when the signature is wrong. */
  verifyReturn(rawQuery: string): ReturnResult | null;
}

let current: Gateway | null = null;
export const setGateway = (g: Gateway | null) => void (current = g);
export const getGateway = () => current;

/** LYD with two decimals at most, as the gateways want it. Dirhams below 10 can't be charged. */
export function lyd(amountMinor: number) {
  if (amountMinor % 10 !== 0) throw new GatewayError("AMOUNT", "المبلغ لازم يكون بالقرش");
  return (amountMinor / 1000).toFixed(2);
}

/** What the customer should read when a gateway says no. */
export function gatewayMessage(code: string, fallback: string) {
  const m: Record<string, string> = {
    INVALID_OTP: "الرمز غير صحيح",
    INVLIAD_OTP: "الرمز غير صحيح",
    OTP_EXPIRED: "الرمز انتهت صلاحيته، اطلب رمز جديد",
    NOT_ALLOWED_AMOUNT: "المبلغ غير مسموح في هالحساب",
    INVALID_MOBILE_NUMBER_OR_BIRTH_YEAR: "رقم الهاتف أو سنة الميلاد غير صحيحة",
    CHECK_BANK_ACCOUNT: "تأكد من حسابك المصرفي (رصيد غير كافي أو حساب موقوف)",
    NOT_SUBSCRIBED: "الرقم مش مشترك في الخدمة",
    CONFIRMATION_ERROR: "ما تمش تأكيد العملية",
  };
  return m[code] ?? fallback;
}
