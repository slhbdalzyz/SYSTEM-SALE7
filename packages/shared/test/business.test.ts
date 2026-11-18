import { describe, expect, it } from "vitest";
import { addMonths, installmentSchedule, piecesFor, tierPrice } from "../src";

describe("business pack", () => {
  it("prices a unit by the kind of customer, falling back to the normal price", () => {
    const u = { priceMinor: 42000, tierPrices: { contractor: 39000 } };
    expect(tierPrice(u, "retail")).toBe(42000);
    expect(tierPrice(u, null)).toBe(42000);
    expect(tierPrice(u, "contractor")).toBe(39000);
    expect(tierPrice(u, "wholesale")).toBe(42000);
  });

  it("moves to the same day next month, or the month's last day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
  });

  it("splits instalments and covers them in order", () => {
    const s = installmentSchedule({ totalMinor: 1_300_000, downMinor: 100_000, count: 3, firstDue: "2026-09-01" }, 500_000, "2026-11-10");
    expect(s.rows.map((r) => r.amountMinor)).toEqual([400_000, 400_000, 400_000]);
    expect(s.rows.map((r) => r.state)).toEqual(["paid", "late", "late"]);
    expect(s.lateMinor).toBe(700_000);
    expect(s.remainingMinor).toBe(700_000);
    expect(s.next?.n).toBe(2);
    // The last payment takes the rounding.
    const r = installmentSchedule({ totalMinor: 1_000_000, downMinor: 0, count: 3, firstDue: "2027-01-01" }, 0, "2026-11-10");
    expect(r.rows.reduce((a, x) => a + x.amountMinor, 0)).toBe(1_000_000);
    expect(r.rows[2].amountMinor).toBe(334_000);
  });

  it("counts whole pieces for a length or an area", () => {
    expect(piecesFor(25_000, 1_440)).toBe(18);
    expect(piecesFor(0, 1_000)).toBe(0);
  });
});
