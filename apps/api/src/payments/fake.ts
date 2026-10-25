// A gateway that behaves like Plutu's sandbox (same test codes), for the demo and the tests.
import { GatewayError, type Gateway, type PayMethod } from "./gateway";

const CODES: Record<string, string> = { sadad: "111111", edfali: "1111" };

export function fakeGateway(): Gateway {
  const pending = new Map<string, { method: PayMethod; amount: string }>();
  let n = 0;
  return {
    name: "demo",
    test: true,
    methods: ["sadad", "edfali"],
    async checkout() {
      throw new GatewayError("NOT_AVAILABLE", "الدفع بالبطاقة مش متاح في النسخة التجريبية");
    },
    async sendOtp(method, amount, mobile) {
      if (!/^09[1-6]\d{7}$/.test(mobile)) throw new GatewayError("INVALID_MOBILE_NUMBER_OR_BIRTH_YEAR", "رقم الهاتف غير صحيح");
      const processId = `demo-${++n}`;
      pending.set(processId, { method, amount });
      return { processId };
    },
    async confirmOtp(method, processId, code, amount) {
      const p = pending.get(processId);
      if (!p || p.method !== method || p.amount !== amount) throw new GatewayError("CONFIRMATION_ERROR", "العملية غير موجودة");
      if (code !== CODES[method]) throw new GatewayError("INVALID_OTP", "الرمز غير صحيح");
      pending.delete(processId);
      return { transactionId: `demo-tx-${n}-${Date.now()}` };
    },
    verifyReturn() {
      return null;
    },
  };
}
