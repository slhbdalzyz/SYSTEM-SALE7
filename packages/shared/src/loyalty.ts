import { z } from "zod";

/**
 * Loyalty points. A customer earns points on what they pay for (not on what they pay with points),
 * and spends them at the till as a way of paying. The same arithmetic runs on the till, offline, and
 * on the server, which keeps the ledger.
 */
export const loyaltySettingsSchema = z.object({
  enabled: z.boolean(),
  /** Dirham spent for one point: 1000 means 1 point per dinar. */
  earnMinorPerPoint: z.number().int().min(1).max(1_000_000),
  /** What one point is worth when spent, in dirham: 10 means 100 points pay 1 dinar. */
  pointValueMinor: z.number().int().min(1).max(1_000_000),
  /** Fewest points a customer must hold before spending any. */
  minRedeemPoints: z.number().int().min(0).max(1_000_000),
});
export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;

export const DEFAULT_LOYALTY: LoyaltySettings = { enabled: false, earnMinorPerPoint: 1000, pointValueMinor: 10, minRedeemPoints: 100 };

/** Points a sale earns. Only what the customer paid for earns; points spent do not. */
export function pointsEarned(s: LoyaltySettings, totalMinor: number, pointsPaidMinor = 0): number {
  if (!s.enabled) return 0;
  return Math.floor(Math.max(totalMinor - pointsPaidMinor, 0) / s.earnMinorPerPoint);
}

/** Points taken for a payment of this many dirham (rounded up, so a point is never worth more than its value). */
export function pointsFor(s: LoyaltySettings, amountMinor: number): number {
  return Math.ceil(Math.max(amountMinor, 0) / s.pointValueMinor);
}

/** The most a customer can pay with points on a sale: whole points, no more than the total. */
export function maxPointsPayment(s: LoyaltySettings, balancePoints: number, totalMinor: number): number {
  if (!s.enabled || balancePoints < Math.max(s.minRedeemPoints, 1)) return 0;
  const worth = balancePoints * s.pointValueMinor;
  const cap = Math.min(worth, Math.max(totalMinor, 0));
  return cap - (cap % s.pointValueMinor);
}
