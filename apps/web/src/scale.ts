// Reads one weight from a cashier scale over the Web Serial API (Chrome/Edge on Windows).
// Most counter scales send a line like "ST,GS,+  1.250kg" when asked or continuously; we take the first number.

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

let port: SerialPortLike | null = null;

export function scaleSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function parseScaleLine(line: string): number | null {
  const m = line.match(/([+-]?\d+(?:[.,]\d+)?)\s*(kg|g)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2]?.toLowerCase() === "g" ? n : n * 1000);
}

/** Returns grams. */
export async function readScaleWeight(baudRate = 9600, timeoutMs = 3000): Promise<number> {
  if (!scaleSupported()) throw new Error("المتصفح ما يدعمش ربط الميزان");
  const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
  if (!port) {
    port = await serial.requestPort();
    await port.open({ baudRate });
  }
  // Many scales answer a weight request; harmless for scales that stream on their own.
  const w = port.writable?.getWriter();
  await w?.write(new TextEncoder().encode("W\r\n"));
  w?.releaseLock();
  const reader = port.readable!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      const lines = buf.split(/\r?\n/);
      for (const l of lines.slice(0, -1)) {
        const g = parseScaleLine(l);
        if (g !== null && g > 0) return g;
      }
      buf = lines[lines.length - 1];
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  throw new Error("ما وصلش وزن من الميزان");
}
