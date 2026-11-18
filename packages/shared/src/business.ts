/**
 * Pieces shared by many kinds of shop: prices by kind of customer, instalments, and the kinds of
 * shop the system is set up for.
 */

export const BUSINESS_TYPES = ["grocery", "clothing", "pharmacy", "butcher", "restaurant", "electronics", "building", "auto_parts", "wholesale", "stationery", "perfume", "bakery", "furniture", "other"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const PRICE_TIERS = ["wholesale", "contractor", "workshop"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];
export type CustomerTier = "retail" | PriceTier;
export const PRICE_TIER_LABELS: Record<CustomerTier, string> = { retail: "قطاعي", wholesale: "جملة", contractor: "مقاول", workshop: "ورشة" };

/** The price a customer of this kind pays for a unit: its own price when set, else the normal one. */
export function tierPrice(unit: { priceMinor: number; tierPrices?: Partial<Record<PriceTier, number>> | null }, tier: CustomerTier | null | undefined): number {
  if (!tier || tier === "retail") return unit.priceMinor;
  const p = unit.tierPrices?.[tier];
  return typeof p === "number" && p > 0 ? p : unit.priceMinor;
}

/** Same day of the month, `n` months on; a day the month lacks becomes its last day. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

export interface InstallmentRow { n: number; due: string; amountMinor: number; paidMinor: number; state: "paid" | "part" | "late" | "due" }

/**
 * The monthly payments of a plan, and how much of each the customer has covered with what they
 * paid since it began (oldest first). The last payment takes the rounding.
 */
export function installmentSchedule(p: { totalMinor: number; downMinor: number; count: number; firstDue: string }, paidMinor: number, today: string) {
  const rest = Math.max(0, p.totalMinor - p.downMinor);
  const each = Math.floor(rest / p.count / 1000) * 1000 || Math.floor(rest / p.count);
  let left = Math.max(0, paidMinor);
  const rows: InstallmentRow[] = [];
  for (let i = 0; i < p.count; i++) {
    const amount = i === p.count - 1 ? rest - each * (p.count - 1) : each;
    const paid = Math.min(left, amount);
    left -= paid;
    const due = addMonths(p.firstDue, i);
    rows.push({ n: i + 1, due, amountMinor: amount, paidMinor: paid, state: paid >= amount ? "paid" : due < today ? "late" : paid > 0 ? "part" : "due" });
  }
  const lateMinor = rows.filter((r) => r.due < today).reduce((a, r) => a + r.amountMinor - r.paidMinor, 0);
  const remainingMinor = rows.reduce((a, r) => a + r.amountMinor - r.paidMinor, 0);
  const next = rows.find((r) => r.paidMinor < r.amountMinor) ?? null;
  return { rows, eachMinor: each, lateMinor, remainingMinor, next };
}

/** Lengths and areas sold from a bigger piece: how many metres a roll holds, or square metres a box covers. */
export function piecesFor(neededMilli: number, perPieceMilli: number): number {
  return perPieceMilli > 0 ? Math.ceil(neededMilli / perPieceMilli) : 0;
}
