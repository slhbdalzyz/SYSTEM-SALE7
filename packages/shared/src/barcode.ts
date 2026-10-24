// EAN-13 helpers and decoding of in-store scale labels (prefix 20–29).

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error("EAN-13 needs 12 digits before the check digit");
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export interface ScaleBarcodeConfig {
  /** Two-digit prefixes the scale prints, e.g. ["20","21"]. */
  prefixes: string[];
  /** Digits of the item (PLU) code right after the prefix. */
  itemDigits: number;
  /** "weight": the value is grams. "price": the value is the price in minor units. */
  mode: "weight" | "price";
}

export const DEFAULT_SCALE_CONFIG: ScaleBarcodeConfig = {
  prefixes: ["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"],
  itemDigits: 5,
  mode: "weight",
};

export type ScaleBarcode =
  | { itemCode: string; mode: "weight"; qtyMilli: number }
  | { itemCode: string; mode: "price"; priceMinor: number };

/**
 * Decodes a scale label such as 20 01234 01250 C → item "01234", 1.250 kg.
 * Layout: 2-digit prefix, item code, value, check digit (13 digits total).
 * Returns null when the code is not a scale label.
 */
export function parseScaleBarcode(code: string, cfg: ScaleBarcodeConfig = DEFAULT_SCALE_CONFIG): ScaleBarcode | null {
  if (!isValidEan13(code)) return null;
  if (!cfg.prefixes.includes(code.slice(0, 2))) return null;
  const itemCode = code.slice(2, 2 + cfg.itemDigits);
  const value = Number(code.slice(2 + cfg.itemDigits, 12));
  if (cfg.mode === "weight") return { itemCode, mode: "weight", qtyMilli: value };
  return { itemCode, mode: "price", priceMinor: value };
}

export function makeScaleBarcode(prefix: string, itemCode: string, value: number, valueDigits = 12 - 2 - itemCode.length): string {
  const body = prefix + itemCode + String(value).padStart(valueDigits, "0");
  return body + ean13CheckDigit(body);
}
