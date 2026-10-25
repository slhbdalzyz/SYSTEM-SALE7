// Wording for subscription states, shared by the shop's admin and the platform back office.
import { toMinor } from "@pos/shared";
export type SubState = "trial" | "active" | "grace" | "locked" | "suspended" | "cancelled";

export const STATE_LABEL: Record<SubState, string> = {
  trial: "فترة تجربة",
  active: "مشترك",
  grace: "متأخر (مهلة)",
  locked: "مقفول (انتهى)",
  suspended: "موقوف",
  cancelled: "ملغي",
};

export const STATE_BADGE: Record<SubState, string> = { trial: "off", active: "ok", grace: "off", locked: "bad", suspended: "bad", cancelled: "bad" };

export const METHOD_LABEL: Record<string, string> = { cash: "كاش", bank: "تحويل مصرفي", card: "بطاقة", other: "أخرى", online: "دفع إلكتروني" };

export interface Plan {
  code: string;
  name: string;
  price_minor: number;
  max_stores: number;
  max_devices: number;
  max_users: number;
  active?: boolean;
  sort?: number;
}

export const date = (d: string | Date) => new Date(d).toLocaleDateString("en-GB");

/** "150" or "1,500.250" typed in dinars, to dirham. Undefined when it is not a price. */
export function parseMoney(s: string): number | undefined {
  const n = Number(s.replace(/[,\s]/g, "").replace("٫", "."));
  return Number.isFinite(n) && n >= 0 ? toMinor(n) : undefined;
}
