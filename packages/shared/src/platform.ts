/**
 * The service's own back office: who on the platform team may do what, the features a shop can
 * have switched on or off, and how a coupon changes a subscription payment.
 */

export const PLATFORM_ROLES = ["owner", "manager", "accountant", "support", "agent"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  owner: "صاحب المنصة", manager: "مدير", accountant: "محاسب", support: "دعم فني", agent: "وكيل",
};

export const PLATFORM_PERMS = [
  "view", "edit", "payments", "revenue", "reminders", "coupons", "agents", "announce", "tickets", "support", "plans", "settings", "errors", "audit", "team",
] as const;
export type PlatformPerm = (typeof PLATFORM_PERMS)[number];

const ALL = [...PLATFORM_PERMS];
export const PLATFORM_ROLE_PERMS: Record<PlatformRole, readonly PlatformPerm[]> = {
  owner: ALL,
  manager: ALL.filter((p) => p !== "team"),
  accountant: ["view", "payments", "revenue", "reminders", "coupons", "agents", "audit"],
  support: ["view", "reminders", "announce", "tickets", "support"],
  // An agent sees only their own shops and commission, through their own page.
  agent: [],
};
export const platformCan = (role: PlatformRole, perm: PlatformPerm) => PLATFORM_ROLE_PERMS[role]?.includes(perm) ?? false;

/** Features the platform can open or close per plan, or per shop over its plan. All open unless closed. */
export const FEATURES = {
  zakat: "الزكاة",
  loyalty: "نقاط الولاء",
  quick_keys: "أزرار الكاشير",
  payroll: "الرواتب",
  offers: "العروض",
  counts: "جرد المخزون",
} as const;
export type Feature = keyof typeof FEATURES;
export type FeatureMap = Partial<Record<Feature, boolean>>;

/** A shop's own setting wins, then its plan's, then open. */
export function resolveFeatures(plan: FeatureMap | null | undefined, tenant: FeatureMap | null | undefined): Record<Feature, boolean> {
  const out = {} as Record<Feature, boolean>;
  for (const f of Object.keys(FEATURES) as Feature[]) out[f] = tenant?.[f] ?? plan?.[f] ?? true;
  return out;
}

export interface CouponRule { kind: "percent" | "months"; value: number }

/** What a coupon does to a payment: a percent off the price, or months added free. */
export function applyCoupon(c: CouponRule, priceMinor: number, months: number): { amountMinor: number; discountMinor: number; bonusMonths: number } {
  const full = priceMinor * months;
  if (c.kind === "percent") {
    const discountMinor = Math.round((full * Math.min(Math.max(c.value, 0), 100)) / 100);
    return { amountMinor: full - discountMinor, discountMinor, bonusMonths: 0 };
  }
  return { amountMinor: full, discountMinor: 0, bonusMonths: Math.max(0, Math.round(c.value)) };
}

export const couponLabel = (c: CouponRule) => (c.kind === "percent" ? `خصم ${c.value}%` : `${c.value} شهر مجاناً`);

/** A shop's health from how it uses the system: the platform's early warning before it stops paying. */
export type Health = "new" | "good" | "drop" | "idle";
export const HEALTH_LABELS: Record<Health, string> = { new: "جديد", good: "شغال", drop: "مبيعاته نقصت", idle: "بطّل يستعمل" };

export function shopHealth(t: { createdAt: Date | string; lastSeenAt: Date | string | null; sales7: number; salesPrev7: number }, now = Date.now()): Health {
  const DAY = 86_400_000;
  const age = now - new Date(t.createdAt).getTime();
  // Sales this week count as being seen, for a shop whose tills never reported in.
  const seen = t.lastSeenAt ? now - new Date(t.lastSeenAt).getTime() : t.sales7 > 0 ? 0 : Infinity;
  if (age < 7 * DAY && t.sales7 + t.salesPrev7 === 0) return "new";
  if (seen > 3 * DAY || t.sales7 === 0) return "idle";
  if (t.salesPrev7 >= 10 && t.sales7 < t.salesPrev7 / 2) return "drop";
  return "good";
}

/** Fills a reminder or message template: {shop} {days} {date} {plan} {price}. */
export function fillPlatformTemplate(t: string, v: Record<string, string | number>) {
  return t.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
}
