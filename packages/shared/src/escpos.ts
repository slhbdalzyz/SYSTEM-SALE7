// ESC/POS for thermal receipt printers. Receipts are sent as a picture (raster), not text:
// cheap printers rarely carry Arabic fonts or shaping, but every one of them prints a bitmap.

/** One bit per pixel, rows packed left to right, 1 = black. width is a multiple of 8. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

const ESC = 0x1b;
const GS = 0x1d;

export const PAPER_DOTS = { 58: 384, 80: 576 } as const;
export type PaperWidth = keyof typeof PAPER_DOTS;

/** RGBA pixels (as from canvas getImageData) to a 1-bit bitmap. Transparent counts as white. */
export function toMonochrome(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, threshold = 160): Bitmap {
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
      if (lum < threshold) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: bytesPerRow * 8, height, data };
}

/** Drops blank rows at the bottom so the paper isn't wasted. */
export function trimBottom(b: Bitmap, margin = 8): Bitmap {
  const row = b.width / 8;
  let last = b.height - 1;
  while (last > 0 && b.data.subarray(last * row, (last + 1) * row).every((v) => v === 0)) last--;
  const h = Math.min(b.height, last + 1 + margin);
  return { width: b.width, height: h, data: b.data.slice(0, h * row) };
}

/** GS v 0, sent in bands: some printers choke on one very tall image. */
export function rasterCommands(b: Bitmap, band = 256): Uint8Array[] {
  const row = b.width / 8;
  const out: Uint8Array[] = [];
  for (let y = 0; y < b.height; y += band) {
    const h = Math.min(band, b.height - y);
    const head = new Uint8Array([GS, 0x76, 0x30, 0x00, row & 0xff, row >> 8, h & 0xff, h >> 8]);
    out.push(head, b.data.subarray(y * row, (y + h) * row));
  }
  return out;
}

export const INIT = new Uint8Array([ESC, 0x40]);
/** Pulse on drawer pin 2 (the usual one): ESC p 0 t1 t2. */
export const OPEN_DRAWER = new Uint8Array([ESC, 0x70, 0x00, 0x19, 0xfa]);
/** Feed a little and partial-cut. */
export const CUT = new Uint8Array([GS, 0x56, 0x42, 0x03]);

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function receiptJob(b: Bitmap | null, opts: { cut?: boolean; openDrawer?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [INIT];
  if (opts.openDrawer) parts.push(OPEN_DRAWER);
  if (b) parts.push(...rasterCommands(b));
  if (b && opts.cut !== false) parts.push(CUT);
  return concatBytes(parts);
}
