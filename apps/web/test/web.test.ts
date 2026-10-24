import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeScaleBarcode, type CatalogProduct } from "@pos/shared";
import { db, storeCatalog, nextInvoiceNumber } from "../src/localdb";
import { findByCode } from "../src/lookup";
import { addLine, lineFor } from "../src/pos/cart";
import { parseScaleLine } from "../src/scale";

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
  });
});
