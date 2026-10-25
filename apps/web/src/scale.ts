// The counter scale. Two ways to reach it: the Windows app reads the COM port itself, or
// Chrome/Edge use Web Serial. Most scales send a line like "ST,GS,+  1.250kg", either when
// asked (a "W" or ENQ request) or all the time; we take the weight from a stable line.

export type ScaleMode = "off" | "browser" | "desktop";

export interface ScaleSettings {
  mode: ScaleMode;
  port: string; // COM port name, for the Windows app
  baudRate: number;
  /** Sent before reading; empty for scales that stream on their own. \r and \n are written as text. */
  request: string;
}

const KEY = "pos.scale";
const DEFAULTS: ScaleSettings = { mode: "off", port: "", baudRate: 9600, request: "W\\r\\n" };

export const isDesktopApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const webSerialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

export function loadScaleSettings(): ScaleSettings {
  let s: Partial<ScaleSettings> = {};
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    /* storage blocked */
  }
  const merged = { ...DEFAULTS, ...s };
  // Before the setting existed, the button showed whenever the browser could do serial.
  if (!s.mode) merged.mode = isDesktopApp() ? "off" : webSerialSupported() ? "browser" : "off";
  return merged;
}

export function saveScaleSettings(s: ScaleSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}

export function scaleSupported(s = loadScaleSettings()) {
  if (s.mode === "desktop") return isDesktopApp();
  if (s.mode === "browser") return webSerialSupported();
  return false;
}

/** Grams from one line of scale output, or null when the line has no usable, stable weight. */
export function parseScaleLine(line: string): number | null {
  if (/\bUS\b|unstable|motion/i.test(line)) return null; // the pan is still moving
  const m = line.match(/([+-]?\s*\d+(?:[.,]\d+)?)\s*(kg|g|lb)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === "lb") return Math.round(n * 453.59237);
  // A bare number without a decimal point is grams on most scales; with one, kilograms.
  if (unit === "g" || (!unit && !/[.,]/.test(m[1]))) return Math.round(n);
  return Math.round(n * 1000);
}

/** The last stable, positive weight in a chunk of scale output. */
export function parseScaleOutput(text: string): number | null {
  const lines = text.split(/[\r\n\x02\x03]+/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const g = parseScaleLine(lines[i]);
    if (g !== null && g > 0) return g;
  }
  return null;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listScalePorts(): Promise<{ name: string; label: string }[]> {
  if (!isDesktopApp()) return [];
  return invoke("list_serial_ports", {});
}

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
let port: SerialPortLike | null = null;

const unescape = (s: string) => s.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\x05/g, "\x05");

async function readWebSerial(s: ScaleSettings, timeoutMs: number): Promise<number> {
  const serial = (navigator as unknown as { serial: { getPorts(): Promise<SerialPortLike[]>; requestPort(): Promise<SerialPortLike> } }).serial;
  if (!port) {
    port = (await serial.getPorts())[0] ?? (await serial.requestPort());
    await port.open({ baudRate: s.baudRate });
  }
  if (s.request) {
    const w = port.writable?.getWriter();
    await w?.write(new TextEncoder().encode(unescape(s.request)));
    w?.releaseLock();
  }
  const reader = port.readable!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const complete = buf.slice(0, Math.max(buf.lastIndexOf("\n"), buf.lastIndexOf("\r")) + 1);
      const g = complete ? parseScaleOutput(complete) : null;
      if (g !== null) return g;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  throw new Error("ما وصلش وزن ثابت من الميزان");
}

/** Returns grams. */
export async function readScaleWeight(s = loadScaleSettings(), timeoutMs = 3000): Promise<number> {
  if (s.mode === "desktop") {
    const text = await invoke<string>("read_scale", { port: s.port, baud: s.baudRate, request: s.request || null, timeoutMs });
    const g = parseScaleOutput(text);
    if (g === null) throw new Error(`الميزان رد بشي ما فهمناهوش: ${text.slice(0, 40)}`);
    return g;
  }
  if (s.mode === "browser") {
    if (!webSerialSupported()) throw new Error("المتصفح ما يدعمش ربط الميزان");
    return readWebSerial(s, timeoutMs);
  }
  throw new Error("الميزان مش مربوط. اربطه من «الطابعة والميزان»");
}
