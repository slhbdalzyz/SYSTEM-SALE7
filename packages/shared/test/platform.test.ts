import { describe, expect, it } from "vitest";
import { applyCoupon, fillPlatformTemplate, platformCan, resolveFeatures, shopHealth } from "../src";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 7);

describe("platform rules", () => {
  it("gives each staff role only its part", () => {
    expect(platformCan("owner", "team")).toBe(true);
    expect(platformCan("manager", "team")).toBe(false);
    expect(platformCan("accountant", "payments")).toBe(true);
    expect(platformCan("accountant", "support")).toBe(false);
    expect(platformCan("support", "tickets")).toBe(true);
    expect(platformCan("agent", "view")).toBe(false);
  });

  it("lets a shop's own feature setting win over its plan's", () => {
    expect(resolveFeatures({ zakat: false }, {}).zakat).toBe(false);
    expect(resolveFeatures({ zakat: false }, { zakat: true }).zakat).toBe(true);
    expect(resolveFeatures(null, null).payroll).toBe(true);
  });

  it("takes a percent off, or adds free months", () => {
    expect(applyCoupon({ kind: "percent", value: 20 }, 150000, 3)).toEqual({ amountMinor: 360000, discountMinor: 90000, bonusMonths: 0 });
    expect(applyCoupon({ kind: "months", value: 1 }, 150000, 6)).toEqual({ amountMinor: 900000, discountMinor: 0, bonusMonths: 1 });
  });

  it("tells a healthy shop from one that stopped using the system", () => {
    const old = new Date(now - 60 * DAY);
    expect(shopHealth({ createdAt: new Date(now - 2 * DAY), lastSeenAt: null, sales7: 0, salesPrev7: 0 }, now)).toBe("new");
    expect(shopHealth({ createdAt: old, lastSeenAt: new Date(now - 5 * DAY), sales7: 20, salesPrev7: 20 }, now)).toBe("idle");
    expect(shopHealth({ createdAt: old, lastSeenAt: new Date(now - DAY), sales7: 0, salesPrev7: 20 }, now)).toBe("idle");
    expect(shopHealth({ createdAt: old, lastSeenAt: new Date(now - DAY), sales7: 8, salesPrev7: 40 }, now)).toBe("drop");
    expect(shopHealth({ createdAt: old, lastSeenAt: null, sales7: 30, salesPrev7: 35 }, now)).toBe("good");
  });

  it("fills a reminder message", () => {
    expect(fillPlatformTemplate("اشتراك {shop} ينتهي {date} {x}", { shop: "النور", date: "2026-11-10" })).toBe("اشتراك النور ينتهي 2026-11-10 {x}");
  });
});
