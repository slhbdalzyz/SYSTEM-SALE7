import { describe, expect, it } from "vitest";
import { applyOffers, offerLive, type Offer, type OfferLine } from "../src";

const base: Offer = {
  id: "00000000-0000-0000-0000-000000000001", name: "", kind: "percent", percentBp: null, amountMinor: null, buyQty: null, getQty: null,
  bundleQty: null, bundlePriceMinor: null, productIds: [], categoryIds: [], storeIds: [], startsAt: null, endsAt: null, days: [],
  hourFrom: null, hourTo: null, active: true,
};
const offer = (o: Partial<Offer>): Offer => ({ ...base, ...o });
const line = (productId: string, priceMinor: number, qty: number, o: Partial<OfferLine> = {}): OfferLine => ({
  productId, categoryId: null, priceMinor, qtyMilli: qty * 1000, isBaseUnit: true, isWeighted: false, ...o,
});
const at = new Date("2026-10-25T10:00:00Z"); // Sunday, 12:00 in Tripoli

describe("offers", () => {
  it("buy 2 get 1 gives the cheapest piece of each group of three", () => {
    const o = offer({ name: "2+1 ياغورت", kind: "buy_get", buyQty: 2, getQty: 1, categoryIds: ["dairy"] });
    const r = applyOffers([line("a", 1000, 2, { categoryId: "dairy" }), line("b", 800, 2, { categoryId: "dairy" }), line("c", 5000, 1)], [o], at, null);
    // pieces 1000,1000,800 | 800 → one group, the 800 goes free
    expect(r.promo).toEqual([0, 800, 0]);
    expect(r.offerIds).toEqual([o.id, o.id, null]);
    expect(r.applied).toEqual([{ offerId: o.id, name: "2+1 ياغورت", amountMinor: 800 }]);
  });

  it("counts only base-unit pieces for piece offers", () => {
    const o = offer({ kind: "buy_get", buyQty: 1, getQty: 1, productIds: ["p"] });
    expect(applyOffers([line("p", 32000, 2, { isBaseUnit: false })], [o], at, null).promo).toEqual([0]);
    expect(applyOffers([line("p", 1500, 3)], [o], at, null).promo).toEqual([1500]);
  });

  it("prices a bundle and spreads the saving over its pieces", () => {
    const o = offer({ kind: "bundle", bundleQty: 3, bundlePriceMinor: 10000, productIds: ["x", "y"] });
    const r = applyOffers([line("x", 4000, 2), line("y", 3500, 2)], [o], at, null);
    // 4000+4000+3500 = 11500 → 10000, saves 1500; the fourth piece is full price
    expect(r.promo.reduce((a, b) => a + b, 0)).toBe(1500);
  });

  it("takes a percentage off weighed items too", () => {
    const o = offer({ kind: "percent", percentBp: 1000, productIds: ["meat"] });
    expect(applyOffers([line("meat", 48000, 0, { qtyMilli: 1250, isWeighted: true })], [o], at, null).promo).toEqual([6000]);
  });

  it("gives each line the best single offer", () => {
    const small = offer({ id: "00000000-0000-0000-0000-00000000000a", kind: "percent", percentBp: 500 });
    const big = offer({ id: "00000000-0000-0000-0000-00000000000b", kind: "amount", amountMinor: 300, productIds: ["a"] });
    const r = applyOffers([line("a", 1000, 2), line("b", 2000, 1)], [small, big], at, null);
    expect(r.promo).toEqual([600, 100]);
    expect(r.offerIds).toEqual([big.id, small.id]);
  });

  it("runs only inside its dates, days, hours and branches", () => {
    expect(offerLive(offer({ endsAt: "2026-10-25T09:00:00Z" }), at, null)).toBe(false);
    expect(offerLive(offer({ startsAt: "2026-10-26T00:00:00Z" }), at, null)).toBe(false);
    expect(offerLive(offer({ days: [5] }), at, null)).toBe(false); // Fridays only
    expect(offerLive(offer({ days: [0], hourFrom: 11, hourTo: 14 }), at, null)).toBe(true);
    expect(offerLive(offer({ hourFrom: 20, hourTo: 2 }), at, null)).toBe(false);
    expect(offerLive(offer({ hourFrom: 20, hourTo: 2 }), new Date("2026-10-25T23:30:00Z"), null)).toBe(true);
    expect(offerLive(offer({ storeIds: ["s1"] }), at, "s2")).toBe(false);
    expect(offerLive(offer({ active: false }), at, null)).toBe(false);
  });
});
