import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeScaleBarcode, type CatalogProduct } from "@pos/shared";
import { db, storeCatalog, nextInvoiceNumber } from "../src/localdb";
import { findByCode } from "../src/lookup";
import { addLine, lineFor, switchUnit } from "../src/pos/cart";
import { parseScaleLine, parseScaleOutput } from "../src/scale";

const water: CatalogProduct = {
  id: "11111111-1111-4111-8111-111111111111", name: "مياه", sku: "W1", categoryId: null, isWeighted: false, scaleCode: null, taxBp: 0,
  costMinor: 400, minStockMilli: 0, active: true, trackExpiry: false, updatedAt: new Date().toISOString(),
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

  it("prints the shop's own details from its settings, and marks a reprint as a copy", async () => {
    const { readShopSettings } = await import("@pos/shared");
    const settings = readShopSettings({
      phone: "0911111111", address: "شارع الجمهورية", city: "طرابلس", taxNumber: "TX-55", logo: "data:image/png;base64,AAAA",
      bank: { name: "مصرف الوحدة", accountNumber: "998877" }, receipt: { header: "مفتوح 24 ساعة", footer: "نورتونا", showBank: true, showTaxNumber: true, showCashier: false },
    });
    const sale = { id: water.id, number: "P1-0009", createdAt: "2026-10-24T10:00:00Z", invoiceDiscountMinor: 0, totalMinor: 750,
      lines: [{ productId: water.id, unitId: water.units[0].id, name: "مياه", qtyMilli: 1000, priceMinor: 750, discountMinor: 0, promoMinor: 0, taxBp: 0 }],
      payments: [{ method: "cash" as const, amountMinor: 750 }] };
    const rows = receiptRows({ ...base, storeName: "فرع السوق", shop: { name: "سوبرماركت النور", settings }, sale });
    const t = text(rows);
    expect(rows[0]).toEqual({ kind: "image", src: "data:image/png;base64,AAAA" });
    for (const s of ["سوبرماركت النور", "فرع السوق", "مفتوح 24 ساعة", "شارع الجمهورية، طرابلس", "0911111111", "TX-55", "مصرف الوحدة", "998877", "نورتونا"]) expect(t).toContain(s);
    expect(t).not.toContain("أحمد");
    expect(t).not.toContain("نسخة");
    expect(text(receiptRows({ ...base, shop: { name: "سوبرماركت النور", settings }, sale, copy: true }))).toContain("*** نسخة ***");
    // Without settings it still prints a plain receipt under the branch's name.
    const plain = text(receiptRows({ ...base, sale }));
    expect(plain).toContain("المحل");
    expect(plain).toContain("أحمد");
    expect(plain).not.toContain("998877");
  });
});

describe("switching the packing sold", () => {
  it("sells the same line as a pack at the pack's price, and back", () => {
    const piece = lineFor(water, water.units[0], 2000);
    expect(piece.units?.map((u) => u.name)).toEqual(["قنينة", "شد 6"]);
    const pack = switchUnit({ ...piece, discountMinor: 100 }, water.units[1].id);
    expect(pack).toMatchObject({ key: piece.key, unitId: water.units[1].id, unitName: "شد 6", priceMinor: 4000, qtyMilli: 2000, discountMinor: 0, isBaseUnit: false, name: "مياه (شد 6)" });
    expect(switchUnit(pack, water.units[0].id)).toMatchObject({ priceMinor: 750, name: "مياه (قنينة)" });
    expect(lineFor(tomato, tomato.units[0], 1000).units).toBeUndefined();
  });
});

describe("WhatsApp links", async () => {
  const { waNumber, waLink, fillTemplate, DEFAULT_INVOICE_MESSAGE } = await import("@pos/shared");
  it("turns Libyan numbers into WhatsApp numbers", () => {
    expect(waNumber("091-234 5678")).toBe("218912345678");
    expect(waNumber("+218 92 1234567")).toBe("218921234567");
    expect(waNumber("00218911111111")).toBe("218911111111");
    expect(waNumber("912345678")).toBe("218912345678");
    expect(waNumber("123")).toBeNull();
  });
  it("writes the message and leaves the number out when there is none", () => {
    const text = fillTemplate(DEFAULT_INVOICE_MESSAGE, { shop: "النور", number: "P1-7", total: "9.500 د.ل", link: "https://x/?r=1" });
    expect(text).toContain("P1-7");
    expect(text).toContain("https://x/?r=1");
    expect(fillTemplate("{a} {b}", { a: "1" })).toBe("1 {b}");
    expect(waLink("0912345678", "مرحبا")).toBe(`https://wa.me/218912345678?text=${encodeURIComponent("مرحبا")}`);
    expect(waLink(null, "x")).toBe("https://wa.me/?text=x");
  });
});

describe("shift-close (Z) report", async () => {
  const { shiftReport } = await import("../src/pos/shiftReport");
  const { receiptRows } = await import("../src/hardware/receiptImage");
  it("adds up sales by way of payment, returns, debt paid and the cash in the drawer", () => {
    const at = new Date().toISOString();
    const line = (qty: number, price: number) => ({ productId: water.id, unitId: water.units[0].id, name: "مياه", qtyMilli: qty, priceMinor: price, discountMinor: 0, promoMinor: 0, taxBp: 0 });
    const sale = (id: string, total: number, payments: { method: "cash" | "card" | "credit"; amountMinor: number }[], change = 0) => ({
      id, number: id, shiftId: "s", createdAt: at, totalMinor: total, cashierName: "أحمد", kind: "sale" as const,
      cashInMinor: payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountMinor, 0), changeMinor: change,
      input: { id, number: id, shiftId: "s", createdAt: at, lines: [line(2000, total / 2)], invoiceDiscountMinor: 0, payments, totalMinor: total },
    });
    const list = [
      sale("A1", 10000, [{ method: "cash", amountMinor: 20000 }], 10000),
      sale("A2", 6000, [{ method: "card", amountMinor: 6000 }]),
      sale("A3", 4000, [{ method: "cash", amountMinor: 1000 }, { method: "credit", amountMinor: 3000 }]),
      { id: "r", number: "R1", shiftId: "s", createdAt: at, totalMinor: -1500, cashInMinor: -1500, changeMinor: 0, cashierName: "أحمد", input: null, kind: "return" as const },
      { id: "p", number: "تسديد", shiftId: "s", createdAt: at, totalMinor: 0, cashInMinor: 2500, changeMinor: 0, cashierName: "أحمد", input: null, kind: "payment" as const },
    ];
    const z = shiftReport({ openedAt: at, openingCashMinor: 50000 }, list, 61500, at);
    expect(z).toMatchObject({ sales: 3, salesMinor: 20000, byMethod: { cash: 11000, card: 6000, credit: 3000 }, returns: 1, returnsMinor: 1500, debtPaidCashMinor: 2500 });
    expect(z.expectedCashMinor).toBe(50000 + 10000 + 1000 - 1500 + 2500);
    expect(z.items[0]).toMatchObject({ name: "مياه", qtyMilli: 6000, totalMinor: 20000 });
    const rows = receiptRows({ storeName: "الرئيسي", deviceName: "كاشير 1", cashierName: "أحمد", shift: z });
    const text = rows.map((r) => ("text" in r ? r.text : "right" in r ? `${r.right} ${r.left}` : "")).join("\n");
    expect(text).toContain("تقرير قفل الوردية");
    expect(text).toContain("عجز");
  });
});

describe("spreadsheets from paper", async () => {
  const { mapSheet, parseCsv, readNumber, templateCsv } = await import("../src/admin/sheet");
  it("reads numbers the way people write them", () => {
    expect(readNumber("4.500")).toBe(4.5);
    expect(readNumber("12,5")).toBe(12.5);
    expect(readNumber("1,250.75")).toBe(1250.75);
    expect(readNumber("١٢٥٫٥ د.ل")).toBe(125.5);
    expect(readNumber("")).toBeNaN();
  });
  it("turns the filled template back into items, any column order, and points at bad lines", () => {
    const back = parseCsv(templateCsv("products"));
    expect(back[0][0]).toBe("اسم الصنف");
    const m = mapSheet("products", back);
    expect(m.rows[0]).toEqual({ name: "سكر 1 كيلو", barcode: "6281000000011", category: "المواد الغذائية", unit: "كيس", priceMinor: 4500, costMinor: 3800, qtyMilli: 24000, minStockMilli: 5000, weighted: false });
    expect(m.rows[1]).toMatchObject({ name: "طماطم", qtyMilli: 40500, weighted: true });
    expect(m.rows[1].barcode).toBeUndefined();
    const odd = mapSheet("products", [["دفتر البقالة"], ["الكمية", "السعر", "الاسم"], ["3", "abc", "بيبسي"], ["", "", ""], ["2", "1.5", "مياه"], ["1", "1", ""]]);
    expect(odd.rows).toEqual([expect.objectContaining({ name: "مياه", priceMinor: 1500, qtyMilli: 2000 })]);
    expect(odd.lines).toEqual([5]);
    expect(odd.errors).toEqual([{ row: 3, message: "السعر مش رقم: abc" }, { row: 6, message: "بدون اسم" }]);
    expect(mapSheet("customers", [["شي"], ["ثاني"]]).missing).toEqual(["اسم العميل"]);
  });
  it("reads the debt book, fixing phone numbers Excel stripped of their 0", () => {
    const m = mapSheet("customers", [["الاسم", "الهاتف", "الدين"], ["محمد", 912345678, "125.5"], ["علي", "", "-20"]]);
    expect(m.rows).toEqual([{ name: "محمد", phone: "0912345678", balanceMinor: 125500 }, { name: "علي", balanceMinor: -20000 }]);
  });
});

describe("reading an .xlsx file", async () => {
  const { readXlsx, mapSheet } = await import("../src/admin/sheet");
  it("reads shared strings, inline strings, numbers and blank cells", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const x = (s: string) => strToU8(`<?xml version="1.0"?>${s}`);
    const zip = zipSync({
      "xl/workbook.xml": x(`<workbook xmlns:r="r"><sheets><sheet name="ديون" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": x(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/sharedStrings.xml": x(`<sst><si><t>اسم العميل</t></si><si><t>الدين القديم</t></si><si><r><t>محمد </t></r><r><t>&amp; أولاده</t></r></si></sst>`),
      "xl/worksheets/sheet1.xml": x(`<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>912345678</v></c><c r="C2"><v>125.5</v></c></row>
        <row r="4"><c r="A4" t="inlineStr"></c><c r="B4"/></row>
        <row r="5"><c r="A5" t="inlineStr"><is><t>سالم</t></is></c><c r="C5" t="str"><v>40</v></c></row>
      </sheetData></worksheet>`),
    });
    const rows = readXlsx(zip);
    expect(rows[0]).toEqual(["اسم العميل", "", "الدين القديم"]);
    expect(rows[1]).toEqual(["محمد & أولاده", 912345678, 125.5]);
    expect(rows[2]).toEqual([]);
    expect(mapSheet("customers", rows).rows).toEqual([{ name: "محمد & أولاده", balanceMinor: 125500 }, { name: "سالم", balanceMinor: 40000 }]);
  });
});
