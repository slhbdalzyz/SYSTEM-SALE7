import { describe, expect, it } from "vitest";
import { isImei, looksLikeBadImei, normSerial, parseSerials, repairDue, serialsMissing, warrantyLabel, warrantyState, warrantyUntil } from "../src";

describe("electronics", () => {
  it("checks an IMEI by its last digit", () => {
    expect(isImei("490154203237518")).toBe(true);
    expect(isImei("49-015420-323751-8")).toBe(true);
    expect(isImei("490154203237519")).toBe(false);
    expect(looksLikeBadImei("490154203237519")).toBe(true);
    expect(looksLikeBadImei("C02XK1ZJJG5H")).toBe(false);
  });
  it("reads a pasted list of serials", () => {
    expect(parseSerials("490154203237518\n 35-209900-176148-1 ,abc12\n490154203237518\n\nx")).toEqual(["490154203237518", "352099001761481", "ABC12"]);
    expect(normSerial(" sn 12-ab ")).toBe("SN12AB");
  });
  it("works out the warranty", () => {
    expect(warrantyUntil("2026-01-31T10:00:00Z", 1)).toBe("2026-02-28");
    expect(warrantyUntil("2026-11-18T10:00:00Z", 12)).toBe("2027-11-18");
    expect(warrantyUntil("2026-11-18T10:00:00Z", 0)).toBeNull();
    expect(warrantyState("2027-11-18", "2026-11-18")).toEqual({ state: "active", daysLeft: 365 });
    expect(warrantyState("2026-11-10", "2026-11-18")).toEqual({ state: "expired", daysAgo: 8 });
    expect(warrantyLabel(12)).toBe("ضمان سنة");
    expect(warrantyLabel(6)).toBe("ضمان 6 شهور");
  });
  it("counts the pieces still without a number, and what a repair still owes", () => {
    expect(serialsMissing({ qtyMilli: 3000, serials: ["A1B"] })).toBe(2);
    expect(serialsMissing({ qtyMilli: 1000 })).toBe(1);
    expect(repairDue({ estimateMinor: 50000, depositMinor: 20000 })).toBe(30000);
    expect(repairDue({ estimateMinor: 50000, depositMinor: 20000, finalMinor: 15000 })).toBe(0);
  });
});
