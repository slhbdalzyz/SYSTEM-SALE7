// Shelf and product labels with a barcode. Drawn on a canvas like receipts (so Arabic names
// shape properly), then sent as TSPL to a label printer, as ESC/POS to a receipt printer, or
// through the browser's print dialog.
import { barcodeFor, concatBytes, CUT, DOTS_PER_MM, formatMoney, INIT, LABEL_SIZES, rasterCommands, toMonochrome, tsplLabelJob, type LabelSize } from "@pos/shared";
import { send } from "./printer";

export interface LabelSettings {
  mode: "browser" | "system" | "network" | "serial";
  language: "tspl" | "escpos";
  printerName: string;
  host: string;
  port: number;
  baudRate: number;
  size: keyof typeof LABEL_SIZES;
  invert: boolean;
  showStore: boolean;
}

export interface LabelItem {
  name: string;
  unitName: string;
  priceMinor: number;
  code: string;
  copies: number;
}

const KEY = "pos.labels";
const DEFAULTS: LabelSettings = { mode: "browser", language: "tspl", printerName: "", host: "192.168.1.101", port: 9100, baudRate: 9600, size: "40x30", invert: false, showStore: false };

export function loadLabelSettings(): LabelSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveLabelSettings(s: LabelSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

const FONT = '"Cairo", "Segoe UI", Tahoma, sans-serif';

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = "700", min = 12) {
  let s = size;
  for (; s > min; s--) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return s;
}

/** Splits a name into at most two lines that fit, shrinking the type if it must. */
function nameLines(ctx: CanvasRenderingContext2D, name: string, maxW: number, size: number): { lines: string[]; size: number } {
  for (let s = size; s >= 14; s -= 2) {
    ctx.font = `700 ${s}px ${FONT}`;
    if (ctx.measureText(name).width <= maxW) return { lines: [name], size: s };
    const words = name.split(" ");
    for (let i = words.length - 1; i > 0; i--) {
      const a = words.slice(0, i).join(" ");
      const b = words.slice(i).join(" ");
      if (ctx.measureText(a).width <= maxW && ctx.measureText(b).width <= maxW) return { lines: [a, b], size: s };
    }
  }
  return { lines: [name], size: 14 };
}

export function labelDots(size: LabelSize) {
  return { w: Math.floor((size.widthMm * DOTS_PER_MM) / 8) * 8, h: size.heightMm * DOTS_PER_MM };
}

/** One label at printer resolution (8 dots per mm). */
export function drawLabel(item: LabelItem, size: LabelSize, opts: { storeName?: string } = {}): HTMLCanvasElement {
  const { w, h } = labelDots(size);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.direction = "rtl";
  ctx.textBaseline = "top";
  const pad = 10;
  let y = 6;

  if (opts.storeName) {
    ctx.font = `600 ${fit(ctx, opts.storeName, w - pad * 2, 16, "600")}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(opts.storeName, w / 2, y);
    y += 20;
  }

  const big = h >= 280;
  const nl = nameLines(ctx, item.name, w - pad * 2, big ? 30 : 24);
  ctx.font = `700 ${nl.size}px ${FONT}`;
  ctx.textAlign = "center";
  for (const line of nl.lines) {
    ctx.fillText(line, w / 2, y);
    y += nl.size + 4;
  }

  // The barcode takes the bottom part; the price sits between name and bars.
  const bc = barcodeFor(item.code);
  const digits = 16;
  const barsH = Math.max(40, Math.round(h * 0.3));
  const barsTop = h - barsH - digits - 6;
  const priceText = formatMoney(item.priceMinor);
  const priceSize = fit(ctx, priceText, w - pad * 2, Math.min(big ? 52 : 40, barsTop - y - 2), "800", 16);
  ctx.font = `800 ${priceSize}px ${FONT}`;
  ctx.fillText(priceText, w / 2, Math.max(y, (y + barsTop - priceSize) / 2));
  if (item.unitName) {
    ctx.font = `500 13px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(item.unitName, w - pad, barsTop - 15);
  }

  // Whole dots per module keep bars crisp; ten modules of quiet zone on each side.
  const mw = Math.max(1, Math.floor(w / (bc.modules.length + 20)));
  const bw = mw * bc.modules.length;
  const x0 = Math.floor((w - bw) / 2);
  bc.modules.forEach((m, i) => m && ctx.fillRect(x0 + i * mw, barsTop, mw, barsH));
  ctx.font = `600 ${digits - 2}px "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.direction = "ltr";
  ctx.fillText(item.code, w / 2, barsTop + barsH + 2);
  return c;
}

/** Whether the bars come out at least two dots per module, the minimum most scanners like. */
export function barcodeFits(code: string, size: LabelSize) {
  return Math.floor(labelDots(size).w / (barcodeFor(code).modules.length + 20)) >= 2;
}

function bitmap(c: HTMLCanvasElement) {
  const img = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  return toMonochrome(img.data, c.width, c.height);
}

/** Through the browser: one page per label, page size set to the label. */
async function printInBrowser(items: LabelItem[], size: LabelSize, storeName?: string) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const pages = items.flatMap((it) => {
    const src = drawLabel(it, size, { storeName }).toDataURL();
    return Array.from({ length: it.copies }, () => `<img src="${src}">`);
  });
  doc.open();
  doc.write(`<!doctype html><html><head><style>
    @page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0 }
    html, body { margin: 0 } img { display: block; width: ${size.widthMm}mm; height: ${size.heightMm}mm; page-break-after: always; image-rendering: pixelated }
  </style></head><body>${pages.join("")}</body></html>`);
  doc.close();
  await new Promise((r) => setTimeout(r, 300));
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 60_000);
}

export async function printLabels(items: LabelItem[], s = loadLabelSettings(), storeName?: string) {
  const size = LABEL_SIZES[s.size];
  const list = items.filter((i) => i.copies > 0 && i.code);
  if (!list.length) throw new Error("ما فيش ملصقات للطباعة");
  await document.fonts?.ready;
  const store = s.showStore ? storeName : undefined;
  if (s.mode === "browser") return printInBrowser(list, size, store);
  if (s.language === "tspl") {
    const jobs = list.map((it) => tsplLabelJob(bitmap(drawLabel(it, size, { storeName: store })), size, it.copies, { invert: s.invert }));
    return send(concatBytes(jobs), s);
  }
  // A receipt printer: labels one after another on the roll, one cut at the end.
  const feed = new Uint8Array([0x1b, 0x64, 0x02]); // ESC d 2: a little space between labels
  const parts: Uint8Array[] = [INIT];
  for (const it of list) {
    const raster = rasterCommands(bitmap(drawLabel(it, size, { storeName: store })));
    for (let k = 0; k < it.copies; k++) parts.push(...raster, feed);
  }
  parts.push(CUT);
  return send(concatBytes(parts), s);
}
