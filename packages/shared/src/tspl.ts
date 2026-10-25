// TSPL, the command language of most cheap thermal label printers (Xprinter, TSC, Gprinter…).
// Like receipts, labels go as one picture so Arabic names print right on any model.
import type { Bitmap } from "./escpos";

export interface LabelSize {
  widthMm: number;
  heightMm: number;
  gapMm: number;
}

/** Common roll sizes in shops here. 203 dpi printers put 8 dots in a millimetre. */
export const LABEL_SIZES: Record<string, LabelSize> = {
  "40x30": { widthMm: 40, heightMm: 30, gapMm: 2 },
  "50x30": { widthMm: 50, heightMm: 30, gapMm: 2 },
  "50x25": { widthMm: 50, heightMm: 25, gapMm: 2 },
  "58x40": { widthMm: 58, heightMm: 40, gapMm: 2 },
  "30x20": { widthMm: 30, heightMm: 20, gapMm: 2 },
};
export const DOTS_PER_MM = 8;

const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * One label design printed `copies` times. TSPL bitmaps print a dot where the bit is 0, the
 * opposite of ESC/POS, so the bits are flipped unless `invert` says the printer does it the other way.
 */
export function tsplLabelJob(b: Bitmap, size: LabelSize, copies: number, opts: { invert?: boolean; density?: number } = {}): Uint8Array {
  const row = b.width / 8;
  const data = opts.invert ? b.data : b.data.map((v) => v ^ 0xff);
  const head = ascii(
    `SIZE ${size.widthMm} mm,${size.heightMm} mm\r\nGAP ${size.gapMm} mm,0 mm\r\nDIRECTION 1,0\r\nREFERENCE 0,0\r\n` +
      `DENSITY ${opts.density ?? 8}\r\nCLS\r\nBITMAP 0,0,${row},${b.height},0,`,
  );
  const tail = ascii(`\r\nPRINT 1,${Math.max(1, Math.floor(copies))}\r\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}
