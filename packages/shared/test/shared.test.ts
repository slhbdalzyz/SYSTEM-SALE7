import { describe, expect, it } from "vitest";
import {
  computeTotals,
  ean13CheckDigit,
  formatMoney,
  isValidEan13,
  lineAmount,
  makeScaleBarcode,
  parseScaleBarcode,
} from "../src";

describe("money", () => {
  it("multiplies price by milli quantity with rounding", () => {
    expect(lineAmount(12500, 1250)).toBe(15625); // 12.500 LYD/kg × 1.250 kg
    expect(lineAmount(1000, 3000)).toBe(3000);
    expect(lineAmount(333, 1500)).toBe(500); // 499.5 rounds to 500
  });
  it("formats dirhams", () => {
    expect(formatMoney(15625)).toBe("15.625 د.ل");
    expect(formatMoney(-50)).toBe("-0.050 د.ل");
    expect(formatMoney(1234567)).toBe("1,234.567 د.ل");
  });
});

describe("barcode", () => {
  it("computes EAN-13 check digits", () => {
    expect(ean13CheckDigit("590123412345")).toBe(7);
    expect(isValidEan13("5901234123457")).toBe(true);
    expect(isValidEan13("5901234123458")).toBe(false);
  });
  it("decodes a weight scale label", () => {
    const code = makeScaleBarcode("20", "01234", 1250);
    expect(code).toHaveLength(13);
    expect(parseScaleBarcode(code)).toEqual({ itemCode: "01234", mode: "weight", qtyMilli: 1250 });
  });
  it("decodes a price scale label", () => {
    const code = makeScaleBarcode("21", "00042", 7350);
    expect(parseScaleBarcode(code, { prefixes: ["21"], itemDigits: 5, mode: "price" })).toEqual({
      itemCode: "00042",
      mode: "price",
      priceMinor: 7350,
    });
  });
  it("ignores normal product barcodes", () => {
    expect(parseScaleBarcode("5901234123457")).toBeNull();
  });
});

describe("cart totals", () => {
  it("applies line and invoice discounts", () => {
    const t = computeTotals(
      [
        { priceMinor: 2000, qtyMilli: 3000, discountMinor: 500 },
        { priceMinor: 12500, qtyMilli: 1250 },
      ],
      125,
    );
    expect(t.subtotal).toBe(21625);
    expect(t.lineDiscount).toBe(500);
    expect(t.invoiceDiscount).toBe(125);
    expect(t.total).toBe(21000);
    expect(t.tax).toBe(0);
  });
  it("extracts inclusive tax", () => {
    const t = computeTotals([{ priceMinor: 11500, qtyMilli: 1000, taxBp: 1500 }]);
    expect(t.total).toBe(11500);
    expect(t.tax).toBe(1500);
  });
  it("never discounts below zero", () => {
    const t = computeTotals([{ priceMinor: 1000, qtyMilli: 1000, discountMinor: 5000 }], 5000);
    expect(t.total).toBe(0);
  });
});

import { creditRoom, refundFor } from "../src";

describe("returns", () => {
  it("refunds the paid share of a line, including its part of the invoice discount", () => {
    // 3 × 2.000 with 0.500 line discount = 5.500; second line 4.500; invoice discount 1.000 over 10.000
    const r = refundFor({ qtyMilli: 3000, priceMinor: 2000, discountMinor: 500, costMinor: 3000 }, { linesNetMinor: 10000, invoiceDiscountMinor: 1000 }, 1000);
    expect(r.totalMinor).toBe(Math.round((5500 - 550) / 3));
    expect(r.costMinor).toBe(1000);
  });
  it("refunds the full line when everything comes back", () => {
    expect(refundFor({ qtyMilli: 1250, priceMinor: 3500, discountMinor: 0, costMinor: 2500 }, { linesNetMinor: 4375, invoiceDiscountMinor: 0 }, 1250).totalMinor).toBe(4375);
  });
});

describe("credit", () => {
  it("knows how much credit is left", () => {
    expect(creditRoom({ creditLimitMinor: null, balanceMinor: 5000 })).toBeNull();
    expect(creditRoom({ creditLimitMinor: 10000, balanceMinor: 4000 })).toBe(6000);
    expect(creditRoom({ creditLimitMinor: 10000, balanceMinor: 12000 })).toBe(0);
  });
});
