import { lineAmount } from "./money";

export const OFFER_KINDS = ["percent", "amount", "buy_get", "bundle"] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

/**
 * A promotion. `percent` and `amount` (off each unit) work on any line, weighed or not.
 * `buy_get` (buy X get Y free) and `bundle` (N for a price) count pieces of the base unit only,
 * so a carton never counts as 24 cans.
 */
export interface Offer {
  id: string;
  name: string;
  kind: OfferKind;
  percentBp: number | null; // 1500 = 15%
  amountMinor: number | null; // off each unit
  buyQty: number | null;
  getQty: number | null;
  bundleQty: number | null;
  bundlePriceMinor: number | null;
  productIds: string[]; // empty with no categories = everything
  categoryIds: string[];
  storeIds: string[]; // empty = every branch
  startsAt: string | null;
  endsAt: string | null;
  days: number[]; // 0 = Sunday … 6 = Saturday; empty = every day
  hourFrom: number | null; // local hours, [from, to); may wrap past midnight
  hourTo: number | null;
  active: boolean;
}

export interface OfferLine {
  productId: string;
  categoryId: string | null;
  priceMinor: number;
  qtyMilli: number;
  isBaseUnit: boolean;
  isWeighted: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localDayHour(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(at);
  return {
    day: WEEKDAYS.indexOf(parts.find((p) => p.type === "weekday")!.value),
    hour: Number(parts.find((p) => p.type === "hour")!.value) % 24,
  };
}

/** Whether an offer runs at this moment in this branch. */
export function offerLive(o: Offer, at: Date, storeId: string | null, tz = "Africa/Tripoli"): boolean {
  if (!o.active) return false;
  if (o.startsAt && at < new Date(o.startsAt)) return false;
  if (o.endsAt && at >= new Date(o.endsAt)) return false;
  if (storeId && o.storeIds.length && !o.storeIds.includes(storeId)) return false;
  if (o.days.length || o.hourFrom !== null) {
    const { day, hour } = localDayHour(at, tz);
    if (o.days.length && !o.days.includes(day)) return false;
    if (o.hourFrom !== null && o.hourTo !== null && o.hourFrom !== o.hourTo) {
      const inside = o.hourFrom < o.hourTo ? hour >= o.hourFrom && hour < o.hourTo : hour >= o.hourFrom || hour < o.hourTo;
      if (!inside) return false;
    }
  }
  return true;
}

function covers(o: Offer, l: OfferLine) {
  if (!o.productIds.length && !o.categoryIds.length) return true;
  return o.productIds.includes(l.productId) || (l.categoryId !== null && o.categoryIds.includes(l.categoryId));
}

/** What one offer would take off the given lines, and which lines it uses up. */
function evaluate(o: Offer, lines: OfferLine[], free: boolean[]): { promo: number[]; used: number[] } {
  const promo = lines.map(() => 0);
  const used: number[] = [];
  const idx = lines.map((_, i) => i).filter((i) => free[i] && covers(o, lines[i]));
  if (o.kind === "percent" || o.kind === "amount") {
    for (const i of idx) {
      const l = lines[i];
      const gross = lineAmount(l.priceMinor, l.qtyMilli);
      const off = o.kind === "percent" ? Math.round((gross * (o.percentBp ?? 0)) / 10000) : lineAmount(o.amountMinor ?? 0, l.qtyMilli);
      promo[i] = Math.min(Math.max(off, 0), gross);
      if (promo[i] > 0) used.push(i);
    }
    return { promo, used };
  }
  // Piece offers: lay every piece out, dearest first, and take them in groups.
  const pieces: { line: number; price: number }[] = [];
  for (const i of idx) {
    const l = lines[i];
    if (l.isWeighted || !l.isBaseUnit) continue;
    for (let k = 0; k < Math.floor(l.qtyMilli / 1000); k++) pieces.push({ line: i, price: l.priceMinor });
  }
  pieces.sort((a, b) => b.price - a.price || a.line - b.line);
  const size = o.kind === "buy_get" ? (o.buyQty ?? 0) + (o.getQty ?? 0) : (o.bundleQty ?? 0);
  if (size < 1 || (o.kind === "buy_get" && !(o.getQty! > 0)) || (o.kind === "bundle" && size < 2)) return { promo, used };
  const usedSet = new Set<number>();
  for (let g = 0; g + size <= pieces.length; g += size) {
    const group = pieces.slice(g, g + size);
    group.forEach((p) => usedSet.add(p.line));
    if (o.kind === "buy_get") {
      for (const p of group.slice(size - o.getQty!)) promo[p.line] += p.price; // the cheapest in the group go free
    } else {
      const sum = group.reduce((a, p) => a + p.price, 0);
      const off = sum - (o.bundlePriceMinor ?? sum);
      if (off <= 0) continue;
      let left = off;
      group.forEach((p, k) => {
        const share = k === group.length - 1 ? left : Math.floor((off * p.price) / sum);
        promo[p.line] += share;
        left -= share;
      });
    }
  }
  return { promo, used: [...usedSet] };
}

export interface AppliedOffers {
  /** Discount from offers on each line, same order as the input. */
  promo: number[];
  offerIds: (string | null)[];
  applied: { offerId: string; name: string; amountMinor: number }[];
}

/**
 * Applies the running offers to a cart. A line takes at most one offer; the offer that saves
 * the customer the most goes first, then the next on the lines left. Device and server both run
 * this, so the result must depend only on its inputs.
 */
export function applyOffers(lines: OfferLine[], offers: Offer[], at: Date, storeId: string | null, tz = "Africa/Tripoli"): AppliedOffers {
  const live = offers.filter((o) => offerLive(o, at, storeId, tz)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const free = lines.map(() => true);
  const promo = lines.map(() => 0);
  const offerIds: (string | null)[] = lines.map(() => null);
  const applied: AppliedOffers["applied"] = [];
  for (;;) {
    let best: { o: Offer; r: ReturnType<typeof evaluate>; total: number } | null = null;
    for (const o of live) {
      if (applied.some((a) => a.offerId === o.id)) continue;
      const r = evaluate(o, lines, free);
      const total = r.promo.reduce((a, b) => a + b, 0);
      if (total > 0 && (!best || total > best.total)) best = { o, r, total };
    }
    if (!best) break;
    for (const i of best.r.used) {
      free[i] = false;
      promo[i] = best.r.promo[i];
      offerIds[i] = best.o.id;
    }
    applied.push({ offerId: best.o.id, name: best.o.name, amountMinor: best.total });
  }
  return { promo, offerIds, applied };
}
