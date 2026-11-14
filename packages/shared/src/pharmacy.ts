/** A delivery of one item with its expiry date, as it came on a supply invoice. */
export interface Delivery { expiry: string; qtyMilli: number; receivedAt: string }
/** What is still on the shelf of one delivery. */
export interface ShelfBatch { expiry: string; leftMilli: number; receivedMilli: number }

/**
 * Which deliveries the stock on the shelf comes from. Shops sell the oldest boxes first, so what is
 * left is the newest deliveries, back in time until they add up to the stock. Deliveries without
 * a date are not counted here; stock beyond the dated deliveries has an unknown date.
 */
export function shelfBatches(deliveries: Delivery[], stockMilli: number): ShelfBatch[] {
  let need = Math.max(0, stockMilli);
  const out: ShelfBatch[] = [];
  const newestFirst = [...deliveries].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.expiry.localeCompare(a.expiry));
  for (const d of newestFirst) {
    if (need <= 0) break;
    const left = Math.min(need, d.qtyMilli);
    need -= left;
    const same = out.find((b) => b.expiry === d.expiry);
    if (same) { same.leftMilli += left; same.receivedMilli += d.qtyMilli; } else out.push({ expiry: d.expiry, leftMilli: left, receivedMilli: d.qtyMilli });
  }
  return out.sort((a, b) => a.expiry.localeCompare(b.expiry));
}

/** Whole days from `today` to `date` (both YYYY-MM-DD); negative once it has passed. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
}

export type ExpiryState = "expired" | "soon" | "ok";
export function expiryState(date: string, today: string, soonDays = 30): ExpiryState {
  const d = daysUntil(date, today);
  return d < 0 ? "expired" : d <= soonDays ? "soon" : "ok";
}

/** A prescription seen at the till, for a medicine that needs one. */
export interface Prescription { doctor?: string; number?: string; patient?: string }
