import { describe, expect, it } from "vitest";
import { daysUntil, expiryState, shelfBatches } from "../src/pharmacy";

describe("pharmacy", () => {
  const d = (expiry: string, qty: number, receivedAt: string) => ({ expiry, qtyMilli: qty * 1000, receivedAt });

  it("finds the shelf stock in the newest deliveries", () => {
    const deliveries = [d("2026-03-01", 10, "2025-06-01"), d("2026-09-01", 10, "2025-12-01"), d("2027-01-01", 5, "2026-04-01")];
    // 8 left: 5 from April, 3 from December; June's are all sold.
    expect(shelfBatches(deliveries, 8000)).toEqual([
      { expiry: "2026-09-01", leftMilli: 3000, receivedMilli: 10000 },
      { expiry: "2027-01-01", leftMilli: 5000, receivedMilli: 5000 },
    ]);
    expect(shelfBatches(deliveries, 0)).toEqual([]);
    expect(shelfBatches(deliveries, 100000).map((b) => b.leftMilli)).toEqual([10000, 10000, 5000]);
  });

  it("puts two deliveries with the same date together", () => {
    expect(shelfBatches([d("2027-01-01", 4, "2026-01-01"), d("2027-01-01", 4, "2026-02-01")], 6000)).toEqual([{ expiry: "2027-01-01", leftMilli: 6000, receivedMilli: 8000 }]);
  });

  it("counts the days left", () => {
    expect(daysUntil("2026-11-20", "2026-11-13")).toBe(7);
    expect(expiryState("2026-11-12", "2026-11-13")).toBe("expired");
    expect(expiryState("2026-12-01", "2026-11-13")).toBe("soon");
    expect(expiryState("2027-06-01", "2026-11-13")).toBe("ok");
  });
});
