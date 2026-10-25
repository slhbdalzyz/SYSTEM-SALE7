import { describe, expect, it } from "vitest";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { barcodeFor, CODE128_TABLE, ean13CheckDigit, ean8CheckDigit, tsplLabelJob } from "../src";

/** Draws the modules 3 dots wide with quiet zones, then lets zxing read it back. */
function decode(modules: boolean[]) {
  const scale = 3;
  const quiet = 12 * scale;
  const width = modules.length * scale + quiet * 2;
  const height = 60;
  const lum = new Uint8ClampedArray(width * height).fill(255);
  for (let y = 0; y < height; y++) modules.forEach((m, i) => {
    if (m) for (let k = 0; k < scale; k++) lum[y * width + quiet + i * scale + k] = 0;
  });
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  const r = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, width, height))));
  return { text: r.getText(), format: BarcodeFormat[r.getBarcodeFormat()] };
}

describe("printed barcodes scan back", () => {
  it("has a sound Code 128 table", () => {
    expect(CODE128_TABLE).toHaveLength(107);
    expect(new Set(CODE128_TABLE).size).toBe(107);
    CODE128_TABLE.slice(0, 106).forEach((w) => expect([...w].reduce((a, n) => a + Number(n), 0)).toBe(11));
  });

  it.each([
    ["619123450001" + ean13CheckDigit("619123450001"), "EAN_13"],
    ["6191234500011", "CODE_128"], // wrong check digit: still prints, just not as EAN
    ["2990000000123".slice(0, 12) + ean13CheckDigit("299000000012"), "EAN_13"],
    ["9638507" + ean8CheckDigit("9638507"), "EAN_8"],
    ["SKU-0042", "CODE_128"],
    ["12345678", "CODE_128"], // bad EAN-8 check digit, so it is just a number
    ["123456", "CODE_128"],
    ["123456789", "CODE_128"],
    ["123", "CODE_128"],
    ["A1b2 c3", "CODE_128"],
  ])("%s", (code, format) => {
    const r = decode(barcodeFor(code).modules);
    expect(r).toEqual({ text: code, format });
  });

  it("keeps a 13-digit code without a valid check digit compact", () => {
    expect(barcodeFor("6191234500011").modules.length).toBe(123);
  });

  it("prints a UPC-A code so it scans as the same 12 digits", () => {
    expect(decode(barcodeFor("036000291452").modules)).toEqual({ text: "036000291452", format: "UPC_A" });
  });
});

describe("TSPL label job", () => {
  it("sizes the label, flips the bits and sets copies", () => {
    const job = tsplLabelJob({ width: 16, height: 2, data: new Uint8Array([0xff, 0x00, 0x0f, 0xf0]) }, { widthMm: 40, heightMm: 30, gapMm: 2 }, 3);
    const text = new TextDecoder("latin1").decode(job);
    expect(text).toContain("SIZE 40 mm,30 mm\r\n");
    expect(text).toContain("BITMAP 0,0,2,2,0,");
    expect(text.endsWith("\r\nPRINT 1,3\r\n")).toBe(true);
    const start = text.indexOf("BITMAP 0,0,2,2,0,") + "BITMAP 0,0,2,2,0,".length;
    expect([...job.subarray(start, start + 4)]).toEqual([0x00, 0xff, 0xf0, 0x0f]);
  });
});
