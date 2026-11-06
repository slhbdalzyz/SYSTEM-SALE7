import { describe, expect, it } from "vitest";
import { computeZakat, hijriDate, nextHawl, readZakatSettings } from "../src/zakat";

describe("zakat", () => {
  it("reads the hijri date", () => {
    // 1 Ramadan 1447 = 18 Feb 2026 (Umm al-Qura)
    expect(hijriDate(new Date("2026-02-18T12:00:00Z"))).toEqual({ year: 1447, month: 9, day: 1 });
  });
  it("finds the next hawl, today included", () => {
    const s = readZakatSettings({ calendar: "hijri", month: 9, day: 1 });
    expect(nextHawl(s, new Date("2026-02-18T08:00:00Z")).daysLeft).toBe(0);
    const n = nextHawl(s, new Date("2026-02-10T08:00:00Z"));
    expect(n.daysLeft).toBe(8);
    expect(n.year).toBe(1447);
    const g = nextHawl({ calendar: "gregorian", month: 1, day: 1 }, new Date("2026-12-30T10:00:00Z"));
    expect(g.daysLeft).toBe(2);
  });
  it("takes the last day of a short month for the 30th", () => {
    const n = nextHawl({ calendar: "hijri", month: 2, day: 30 }, new Date("2026-07-01T10:00:00Z"));
    const h = hijriDate(n.date);
    expect(h.month).toBe(2);
    expect(h.day).toBeGreaterThanOrEqual(29);
  });
  it("computes zakat with nisab and rate", () => {
    const base = { inventoryMinor: 30_000_000, cashMinor: 5_000_000, receivablesMinor: 2_000_000, otherAssetsMinor: 0, payablesMinor: 7_000_000, otherDebtsMinor: 0, nisabGrams: 85, calendar: "hijri" as const };
    const r = computeZakat({ ...base, goldGramMinor: 300_000 });
    expect(r.baseMinor).toBe(30_000_000);
    expect(r.nisabMinor).toBe(25_500_000);
    expect(r.reachesNisab).toBe(true);
    expect(r.zakatMinor).toBe(750_000);
    expect(computeZakat({ ...base, calendar: "gregorian", goldGramMinor: 300_000 }).zakatMinor).toBe(773_100);
    expect(computeZakat({ ...base, goldGramMinor: 400_000 }).zakatMinor).toBe(0);
    expect(computeZakat({ ...base, goldGramMinor: 0 }).reachesNisab).toBeNull();
  });
});

describe("zakat day near midnight", () => {
  it("counts days from today in Libya, not in UTC", () => {
    // 23:30 UTC on 17 Feb is already 18 Feb (1 Ramadan) in Tripoli.
    expect(nextHawl({ calendar: "hijri", month: 9, day: 1 }, new Date("2026-02-17T23:30:00Z")).daysLeft).toBe(0);
  });
});
