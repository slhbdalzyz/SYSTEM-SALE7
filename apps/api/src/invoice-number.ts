/**
 * Invoice numbers are the till's prefix and a running count: P1-123 (older ones were padded,
 * P1-000123). People type them however they remember them, so searching compares the numbers
 * with the padding taken out, and a bare count ("123") finds that invoice on any till.
 */

/** The stored number in SQL with the padding taken out: P1-000123 → P1-123. */
export const plainNumber = (col: string) => `regexp_replace(${col}, '-0+([0-9])', '-\\1')`;
/** Just the running count of a stored number, in SQL: P1-000123 → 123. */
export const numberSeq = (col: string) => `regexp_replace(${col}, '^.*-0*([0-9]+)$', '\\1')`;

const ARABIC = "٠١٢٣٤٥٦٧٨٩";
const DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** What someone typed, read as an invoice number: a full one, a bare count, or neither. */
export function readNumber(raw: string): { full: string } | { seq: string } | null {
  const s = raw.trim().toUpperCase()
    .replace(/[٠-٩]/g, (d) => String(ARABIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(DIGITS.indexOf(d)))
    .replace(/\s+/g, "").replace(/[–—_/]/g, "-");
  const full = /^([A-Z]+\d*)-?0*(\d+)$/.exec(s);
  if (full && /[A-Z]/.test(s)) return { full: `${full[1]}-${full[2]}` };
  const seq = /^#?0*(\d+)$/.exec(s);
  if (seq) return { seq: seq[1] };
  return null;
}
