// All money is stored as integer minor units. For LYD that is the dirham (1 LYD = 1000 dirham).
// All quantities are stored as integer thousandths ("milli"): 1 piece = 1000, 1.250 kg = 1250.

export const MINOR_PER_MAJOR = 1000;
export const MILLI = 1000;

export function toMinor(major: number): number {
  return Math.round(major * MINOR_PER_MAJOR);
}

export function fromMinor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

export function formatMoney(minor: number, currency = "د.ل"): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_PER_MAJOR);
  const rest = String(abs % MINOR_PER_MAJOR).padStart(3, "0");
  return `${sign}${major.toLocaleString("en-US")}.${rest} ${currency}`;
}

export function formatQty(milli: number, weighted: boolean): string {
  if (weighted) return (milli / MILLI).toFixed(3);
  return Number.isInteger(milli / MILLI) ? String(milli / MILLI) : (milli / MILLI).toFixed(3);
}

/** price (per 1 unit) × quantity (milli) → line amount, rounded to the nearest minor unit. */
export function lineAmount(priceMinor: number, qtyMilli: number): number {
  return Math.round((priceMinor * qtyMilli) / MILLI);
}
