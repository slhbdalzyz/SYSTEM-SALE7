// Sends receipts and drawer pulses to the till's printer. Three ways to reach it:
// the Windows app (an installed printer, or a network printer on port 9100), Web Serial in
// Chrome/Edge, or the browser's own print dialog as the fallback that always works.
import { PAPER_DOTS, receiptJob, toMonochrome, trimBottom, type PaperWidth } from "@pos/shared";
import type { ReceiptData } from "../pos/Receipt";
import { drawReceipt, receiptRows } from "./receiptImage";

export type PrinterMode = "browser" | "system" | "network" | "serial";

export interface PrinterSettings {
  mode: PrinterMode;
  printerName: string;
  host: string;
  port: number;
  paper: PaperWidth;
  openDrawerOnCash: boolean;
  baudRate: number;
}

const KEY = "pos.printer";
const DEFAULTS: PrinterSettings = { mode: "browser", printerName: "", host: "192.168.1.100", port: 9100, paper: 80, openDrawerOnCash: true, baudRate: 9600 };

export function loadPrinterSettings(): PrinterSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function savePrinterSettings(s: PrinterSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}

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

async function send(bytes: Uint8Array, s: PrinterSettings) {
  if (s.mode === "system") return invoke("print_raw", { printer: s.printerName, data: Array.from(bytes) });
  if (s.mode === "network") return invoke("print_tcp", { host: s.host, port: s.port, data: Array.from(bytes) });
  if (s.mode === "serial") return sendSerial(bytes, s.baudRate);
}

export function receiptBitmap(data: ReceiptData, paper: PaperWidth) {
  const canvas = drawReceipt(receiptRows(data), PAPER_DOTS[paper]);
  const img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return trimBottom(toMonochrome(img.data, canvas.width, canvas.height));
}

/** Prints a receipt. Returns false when the browser dialog was used (it cannot pulse the drawer). */
export async function printReceipt(data: ReceiptData, opts: { openDrawer?: boolean } = {}, s = loadPrinterSettings()): Promise<boolean> {
  if (s.mode === "browser") {
    window.print();
    return false;
  }
  await document.fonts?.ready;
  await send(receiptJob(receiptBitmap(data, s.paper), { openDrawer: opts.openDrawer && s.openDrawerOnCash }), s);
  return true;
}

export async function openDrawer(s = loadPrinterSettings()) {
  if (s.mode === "browser") throw new Error("فتح الدرج يحتاج طابعة موصولة (تطبيق ويندوز أو منفذ تسلسلي)");
  await send(receiptJob(null, { openDrawer: true }), s);
}

/** The second screen facing the customer: its own window, full screen on the other monitor in the Windows app. */
export async function openCustomerDisplay() {
  if (isDesktopApp()) return invoke("open_display", {});
  window.open(`${location.pathname}?screen=display`, "pos-display", "popup,width=900,height=600");
}
