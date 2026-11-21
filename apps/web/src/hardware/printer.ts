// Sends receipts and drawer pulses to the till's printer. Three ways to reach it:
// the Windows app (an installed printer, or a network printer on port 9100), Web Serial in
// Chrome/Edge, or the browser's own print dialog as the fallback that always works.
import { PAPER_DOTS, receiptJob, toMonochrome, trimBottom, type PaperWidth } from "@pos/shared";
import type { ReceiptData } from "../pos/Receipt";
import { drawReceipt, loadReceiptImages, receiptRows } from "./receiptImage";
import { printPage, type PageSize } from "./pageInvoice";

export type PrinterMode = "browser" | "system" | "network" | "serial";

export interface PrinterSettings {
  mode: PrinterMode;
  printerName: string;
  host: string;
  port: number;
  paper: PaperWidth;
  openDrawerOnCash: boolean;
  baudRate: number;
  /** Dots across the paper when the printer is not the usual 384/576 (some 80 mm printers print 512). 0 = by the paper. */
  dots: number;
  /** Text size on the paper: 1 is normal. */
  textScale: number;
  /** How dark the print is: the grey level (0–255) under which a dot turns black. Higher = darker. */
  darkness: number;
  /** Blank edge on each side, in millimetres. */
  marginMm: number;
  /** Blank lines fed before the cut, for printers that cut too close to the text. */
  feed: number;
  cut: boolean;
  beep: boolean;
  /** "roll" for a receipt printer; A4 or A5 prints a full invoice on an ordinary printer. */
  sheet: Sheet;
}

export type Sheet = "roll" | PageSize;

/** The kitchen's own printer, for restaurants: when `separate` is off, kitchen slips go to the receipt printer. */
export interface KitchenPrinterSettings extends PrinterSettings {
  separate: boolean;
  copies: number;
}

const KEY = "pos.printer";
const KITCHEN_KEY = "pos.printer.kitchen";
export const PRINTER_DEFAULTS: PrinterSettings = {
  mode: "browser", printerName: "", host: "192.168.1.100", port: 9100, paper: 80, openDrawerOnCash: true, baudRate: 9600,
  dots: 0, textScale: 1, darkness: 160, marginMm: 1, feed: 0, cut: true, beep: false, sheet: "roll",
};
const KITCHEN_DEFAULTS: KitchenPrinterSettings = { ...PRINTER_DEFAULTS, host: "192.168.1.101", openDrawerOnCash: false, textScale: 1.15, separate: false, copies: 1 };

function read<T>(key: string, defaults: T): T {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return defaults;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}

export const loadPrinterSettings = (): PrinterSettings => read(KEY, PRINTER_DEFAULTS);
export const savePrinterSettings = (s: PrinterSettings) => write(KEY, s);
export const loadKitchenPrinter = (): KitchenPrinterSettings => read(KITCHEN_KEY, KITCHEN_DEFAULTS);
export const saveKitchenPrinter = (s: KitchenPrinterSettings) => write(KITCHEN_KEY, s);

/** Dots across the paper for these settings. */
export const paperDots = (s: Pick<PrinterSettings, "paper" | "dots">) => (s.dots >= 200 ? s.dots : PAPER_DOTS[s.paper]);

export const isDesktopApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listSystemPrinters(): Promise<string[]> {
  if (!isDesktopApp()) return [];
  return invoke<string[]>("list_printers", {});
}

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
}
let serialPort: SerialPortLike | null = null;

async function sendSerial(bytes: Uint8Array, baudRate: number) {
  const serial = (navigator as unknown as { serial: { getPorts(): Promise<SerialPortLike[]>; requestPort(): Promise<SerialPortLike> } }).serial;
  if (!serialPort) {
    // A port chosen before is remembered by the browser; ask only the first time.
    serialPort = (await serial.getPorts())[0] ?? (await serial.requestPort());
    await serialPort.open({ baudRate });
  }
  const w = serialPort.writable!.getWriter();
  try {
    await w.write(bytes);
  } finally {
    w.releaseLock();
  }
}

export async function send(bytes: Uint8Array, s: Pick<PrinterSettings, "mode" | "printerName" | "host" | "port" | "baudRate">) {
  if (s.mode === "system") return invoke("print_raw", { printer: s.printerName, data: Array.from(bytes) });
  if (s.mode === "network") return invoke("print_tcp", { host: s.host, port: s.port, data: Array.from(bytes) });
  if (s.mode === "serial") return sendSerial(bytes, s.baudRate);
}

type Look = Pick<PrinterSettings, "paper" | "dots" | "textScale" | "darkness" | "marginMm">;

/** The receipt drawn as the printer will put it on paper, before it is turned into dots. */
export async function receiptCanvas(data: ReceiptData, s: Look) {
  const rows = receiptRows(data);
  const dots = paperDots(s);
  // Thermal printers are 8 dots to the millimetre.
  return drawReceipt(rows, dots, await loadReceiptImages(rows), s.textScale || 1, Math.round((s.marginMm ?? 1) * 8));
}

export async function receiptBitmap(data: ReceiptData, s: Look) {
  const canvas = await receiptCanvas(data, s);
  const img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return trimBottom(toMonochrome(img.data, canvas.width, canvas.height, s.darkness || 160));
}

/** The browser's print dialog follows the paper and text size too. */
function browserLook(s: Look) {
  const root = document.documentElement.style;
  root.setProperty("--rc-width", `${s.paper === 58 ? 54 : 76}mm`);
  root.setProperty("--rc-scale", String(s.textScale || 1));
  root.setProperty("--rc-pad", `${s.marginMm ?? 2}mm`);
}

/**
 * Prints a receipt. Kitchen slips go to the kitchen's printer when it has its own.
 * Returns false when the browser dialog was used (it cannot pulse the drawer).
 */
export async function printReceipt(data: ReceiptData, opts: { openDrawer?: boolean } = {}, given?: PrinterSettings): Promise<boolean> {
  const kitchen = data.kitchen && !given ? loadKitchenPrinter() : null;
  const s = given ?? (kitchen?.separate ? kitchen : loadPrinterSettings());
  const copies = data.copy ? 1 : data.kitchen ? Math.max(1, kitchen?.separate ? kitchen.copies : 1) : Math.max(1, data.shop?.settings.receipt.copies ?? 1);
  if (s.sheet && s.sheet !== "roll") {
    await printPage(data, { size: s.sheet, textScale: s.textScale, marginMm: s.marginMm }, copies);
    return false;
  }
  if (s.mode === "browser") {
    browserLook(s);
    window.print();
    return false;
  }
  await document.fonts?.ready;
  for (let i = 0; i < copies; i++) {
    const bitmap = await receiptBitmap(i ? { ...data, copy: true } : data, s);
    await send(receiptJob(bitmap, { openDrawer: !i && opts.openDrawer && s.openDrawerOnCash, cut: s.cut, feed: s.feed, beep: !i && s.beep }), s);
  }
  return true;
}

export async function openDrawer(s = loadPrinterSettings()) {
  if (s.mode === "browser" || (s.sheet && s.sheet !== "roll")) throw new Error("فتح الدرج يحتاج طابعة موصولة (تطبيق ويندوز أو منفذ تسلسلي)");
  await send(receiptJob(null, { openDrawer: true }), s);
}

/** The second screen facing the customer: its own window, full screen on the other monitor in the Windows app. */
export async function openCustomerDisplay() {
  if (isDesktopApp()) return invoke("open_display", {});
  window.open(`${location.pathname}?screen=display`, "pos-display", "popup,width=900,height=600");
}
