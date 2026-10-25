// Barcode symbols for printed shelf and product labels. Each encoder returns the bars as
// modules (true = black), quiet zones not included; the label drawer scales them to dots.
import { ean13CheckDigit } from "./barcode";

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
// Which of L/G the left six digits use, chosen by the first digit.
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

const bits = (s: string) => [...s].map((c) => c === "1");

export function ean13Modules(code: string): boolean[] {
  if (!/^\d{13}$/.test(code)) throw new Error("EAN-13 needs 13 digits");
  const d = [...code].map(Number);
  const parity = PARITY[d[0]];
  let s = "101";
  for (let i = 1; i <= 6; i++) s += (parity[i - 1] === "L" ? L : G)[d[i]];
  s += "01010";
  for (let i = 7; i <= 12; i++) s += R[d[i]];
  return bits(s + "101");
}

export function ean8CheckDigit(first7: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(first7[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function ean8Modules(code: string): boolean[] {
  if (!/^\d{8}$/.test(code)) throw new Error("EAN-8 needs 8 digits");
  const d = [...code].map(Number);
  let s = "101";
  for (let i = 0; i < 4; i++) s += L[d[i]];
  s += "01010";
  for (let i = 4; i < 8; i++) s += R[d[i]];
  return bits(s + "101");
}

// Code 128 bar/space widths for values 0–106 (106 is the stop, with its final bar).
const C128 = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 " +
  "221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 " +
  "231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
  "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 " +
  "114131 311141 411131 211412 211214 211232 2331112"
).split(" ");
export const CODE128_TABLE = C128;

function widths(w: string): boolean[] {
  const out: boolean[] = [];
  [...w].forEach((n, i) => {
    for (let k = 0; k < Number(n); k++) out.push(i % 2 === 0);
  });
  return out;
}

/** Code 128: set C for runs of digits (shorter bars), set B for anything else printable. */
export function code128Modules(text: string): boolean[] {
  if (!text || ![...text].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127)) throw new Error("Code 128 takes plain ASCII only");
  const values: number[] = [];
  if (/^\d{4,}$/.test(text)) {
    // Digits go two per symbol in set C; an odd one out switches to set B for the last digit.
    values.push(105);
    const even = text.length - (text.length % 2);
    for (let i = 0; i < even; i += 2) values.push(Number(text.slice(i, i + 2)));
    if (even < text.length) values.push(100, text.charCodeAt(even) - 32);
  } else {
    values.push(104);
    for (const c of text) values.push(c.charCodeAt(0) - 32);
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  values.push(check, 106);
  return values.flatMap((v) => widths(C128[v]));
}

export type Symbology = "ean13" | "ean8" | "code128";

/** Picks the symbol a code should print as: retail codes stay EAN, anything else is Code 128. */
export function barcodeFor(code: string): { kind: Symbology; modules: boolean[] } {
  if (/^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12])) return { kind: "ean13", modules: ean13Modules(code) };
  if (/^\d{12}$/.test(code) && ean13CheckDigit("0" + code.slice(0, 11)) === Number(code[11])) return { kind: "ean13", modules: ean13Modules("0" + code) }; // UPC-A
  if (/^\d{8}$/.test(code) && ean8CheckDigit(code.slice(0, 7)) === Number(code[7])) return { kind: "ean8", modules: ean8Modules(code) };
  return { kind: "code128", modules: code128Modules(code) };
}
