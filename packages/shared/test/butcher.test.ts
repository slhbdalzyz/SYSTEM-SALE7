import { describe, expect, it } from "vitest";
import { allocateCost, breakdownYield } from "../src/butcher";

describe("butcher", () => {
  it("puts more of the cost on the cuts that sell for more", () => {
    // 10 kg fillet at 60, 10 kg mince at 30: fillet carries two thirds.
    expect(allocateCost(900000, [{ qtyMilli: 10000, priceMinor: 60000 }, { qtyMilli: 10000, priceMinor: 30000 }])).toEqual([600000, 300000]);
  });

  it("adds up to the cost exactly, to the dirham", () => {
    const c = allocateCost(1000, [{ qtyMilli: 1000, priceMinor: 1 }, { qtyMilli: 1000, priceMinor: 1 }, { qtyMilli: 1000, priceMinor: 1 }]);
    expect(c.reduce((a, x) => a + x, 0)).toBe(1000);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
  });

  it("shares by weight when a cut has no price yet", () => {
    expect(allocateCost(300, [{ qtyMilli: 2000, priceMinor: 0 }, { qtyMilli: 1000, priceMinor: 50000 }])).toEqual([200, 100]);
  });

  it("works out the yield and the loss", () => {
    expect(breakdownYield(20000, [9000, 7000, 2500])).toEqual({ outMilli: 18500, wasteMilli: 1500, yieldBp: 9250 });
  });
});
