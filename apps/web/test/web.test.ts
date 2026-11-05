import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeScaleBarcode, type CatalogProduct } from "@pos/shared";
import { db, storeCatalog, nextInvoiceNumber } from "../src/localdb";
import { findByCode } from "../src/lookup";
import { addLine, lineFor } from "../src/pos/cart";
import { parseScaleLine, parseScaleOutput } from "../src/scale";

const water: CatalogProduct = {
  id: "11111111-1111-4111-8111-111111111111", name: "مياه", sku: "W1", categoryId: null, isWeighted: false, scaleCode: null, taxBp: 0,
  costMinor: 400, minStockMilli: 0, active: true, updatedAt: new Date().toISOString(),
  units: [
    { id: "21111111-1111-4111-8111-111111111111", name: "قنينة", factorMilli: 1000, priceMinor: 750, isBase: true, barcodes: ["6191234500011"] },
    { id: "31111111-1111-4111-8111-111111111111", name: "شد 6", factorMilli: 6000, priceMinor: 4000, isBase: false, barcodes: ["6191234500028"] },
  ],
};
const tomato: CatalogProduct = {
  ...water, id: "41111111-1111-4111-8111-111111111111", name: "طماطم", sku: null, isWeighted: true, scaleCode: "00101",
  units: [{ id: "51111111-1111-4111-8111-111111111111", name: "كيلو", factorMilli: 1000, priceMinor: 3500, isBase: true, barcodes: [] }],
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  await storeCatalog([water, tomato], true);
});

describe("lookup", () => {
  it("finds the unit a barcode belongs to", async () => {
    expect((await findByCode("6191234500028"))?.unit.name).toBe("شد 6");
  });
  it("reads weight from a scale label", async () => {
    const hit = await findByCode(makeScaleBarcode("20", "00101", 1250));
    expect(hit?.product.name).toBe("طماطم");
    expect(hit?.qtyMilli).toBe(1250);
  });
  it("finds by SKU and misses unknown codes", async () => {
    expect((await findByCode("W1"))?.product.id).toBe(water.id);
    expect(await findByCode("0000000000000")).toBeNull();
  });
  it("forgets barcodes removed from a product on the next sync", async () => {
    await storeCatalog([{ ...water, units: [{ ...water.units[0], barcodes: ["999"] }] }], false);
    expect(await findByCode("6191234500011")).toBeNull();
    expect((await findByCode("999"))?.product.id).toBe(water.id);
  });
});

describe("cart", () => {
  it("merges the same counted item and keeps weighed items apart", () => {
    let r = addLine([], lineFor(water, water.units[0], 1000));
    r = addLine(r.lines, lineFor(water, water.units[0], 2000));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].qtyMilli).toBe(3000);
    r = addLine(r.lines, lineFor(tomato, tomato.units[0], 500));
    r = addLine(r.lines, lineFor(tomato, tomato.units[0], 700));
    expect(r.lines).toHaveLength(3);
  });
});

describe("device", () => {
  it("numbers invoices per device", async () => {
    expect(await nextInvoiceNumber("P1")).toBe("P1-000001");
    expect(await nextInvoiceNumber("P1")).toBe("P1-000002");
  });
  it("parses common scale outputs", () => {
    expect(parseScaleLine("ST,GS,+  1.250kg")).toBe(1250);
    expect(parseScaleLine("  850 g")).toBe(850);
    expect(parseScaleLine("---")).toBeNull();
    expect(parseScaleLine("US,GS,+  1.180kg")).toBeNull(); // still settling
    expect(parseScaleLine("01250")).toBe(1250);
    expect(parseScaleLine("2.5 lb")).toBe(1134);
    expect(parseScaleOutput("0.98kg\r\nUS,GS,+  1.010kg\r\nST,GS,+  1.020kg\r\nUS,GS,+  1.100kg\r\n")).toBe(1020);
    expect(parseScaleOutput("\x02  0.000kg\x03")).toBeNull();
  });
});

describe("receipt rows for the thermal printer", async () => {
  const { receiptRows } = await import("../src/hardware/receiptImage");
  const base = { storeName: "المحل", deviceName: "كاشير 1", cashierName: "أحمد" };
  const text = (rows: ReturnType<typeof receiptRows>) => JSON.stringify(rows);

  it("lists each line, the total, the cash and the change", () => {
    const rows = receiptRows({
      ...base,
      changeMinor: 1500,
      sale: {
        id: water.id, number: "P1-0007", createdAt: "2026-10-24T10:00:00Z", invoiceDiscountMinor: 0, totalMinor: 8500,
        lines: [{ productId: water.id, unitId: water.units[0].id, name: "مياه", qtyMilli: 2000, priceMinor: 750, discountMinor: 0, promoMinor: 0, taxBp: 0 },
                { productId: water.id, unitId: water.units[1].id, name: "مياه شد 6", qtyMilli: 1000, priceMinor: 7000, discountMinor: 0, promoMinor: 0, taxBp: 0 }],
        payments: [{ method: "cash", amountMinor: 10000 }],
      },
    });
    const t = text(rows);
    for (const s of ["المحل", "P1-0007", "مياه شد 6", "8.500", "10.000", "1.500"]) expect(t).toContain(s);
  });

  it("prints a refund and a debt payment", () => {
    const r = text(receiptRows({ ...base, ret: { number: "P1-0008", originalNumber: "P1-0007", customerName: null, method: "cash", totalMinor: 1500, reason: "تالف", lines: [{ name: "مياه", qtyMilli: 2000, totalMinor: 1500 }] } }));
    expect(r).toContain("P1-0007");
    expect(r).toContain("1.500");
    const p = text(receiptRows({ ...base, payment: { customerName: "محمد", amountMinor: 50000, method: "cash", balanceMinor: 20000, at: "2026-10-24T10:00:00Z" } }));
    expect(p).toContain("محمد");
    expect(p).toContain("50.000");
  });
});
