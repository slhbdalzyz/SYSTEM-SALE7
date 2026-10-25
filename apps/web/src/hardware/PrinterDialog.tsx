import { useEffect, useState } from "react";
import type { ReceiptData } from "../pos/Receipt";
import { Modal } from "../pos/dialogs";
import { listScalePorts, loadScaleSettings, readScaleWeight, saveScaleSettings, webSerialSupported, type ScaleSettings } from "../scale";
import { isDesktopApp, listSystemPrinters, loadPrinterSettings, openDrawer, printReceipt, savePrinterSettings, serialSupported, type PrinterMode, type PrinterSettings } from "./printer";

const SAMPLE: ReceiptData = {
  storeName: "تجربة الطابعة",
  deviceName: "كاشير",
  cashierName: "—",
  footer: "إذا قريت هذا السطر، الطابعة جاهزة ✓",
  sale: {
    id: "00000000-0000-4000-8000-000000000000",
    number: "TEST-1",
    createdAt: new Date().toISOString(),
    lines: [
      { productId: "", unitId: "", name: "حليب طازج 1 لتر", qtyMilli: 2000, priceMinor: 3500, discountMinor: 0, promoMinor: 0, taxBp: 0 },
      { productId: "", unitId: "", name: "طماطم", qtyMilli: 1250, priceMinor: 3500, discountMinor: 0, promoMinor: 0, taxBp: 0 },
    ],
    invoiceDiscountMinor: 0,
    payments: [{ method: "cash", amountMinor: 20000 }],
    totalMinor: 11375,
  },
  changeMinor: 8625,
};

export function PrinterDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<PrinterSettings>(loadPrinterSettings);
  const [printers, setPrinters] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [scale, setScale] = useState<ScaleSettings>(loadScaleSettings);
  const desktop = isDesktopApp();

  useEffect(() => {
    if (desktop) void listSystemPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [desktop]);

  const modes: { id: PrinterMode; label: string; ok: boolean; why?: string }[] = [
    { id: "browser", label: "نافذة الطباعة في المتصفح", ok: true },
    { id: "system", label: "طابعة مثبتة على ويندوز", ok: desktop, why: "يحتاج تطبيق ويندوز" },
    { id: "network", label: "طابعة شبكة (IP)", ok: desktop, why: "يحتاج تطبيق ويندوز" },
    { id: "serial", label: "منفذ تسلسلي / USB-Serial", ok: serialSupported(), why: "يحتاج Chrome أو Edge" },
  ];

  async function run(fn: () => Promise<unknown>, ok: string) {
    savePrinterSettings(s);
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok });
    } catch (e) {
      setMsg({ text: `ما نجحتش: ${(e as Error).message ?? e}`, bad: true });
    }
  }

  return (
    <Modal title="الطابعة والدرج والميزان" onClose={onClose}>
      <div className="stack" style={{ gap: 6 }}>
        {modes.map((m) => (
          <label key={m.id} className="row" style={{ color: m.ok ? "var(--ink)" : "var(--muted)" }}>
            <input type="radio" style={{ width: "auto" }} disabled={!m.ok} checked={s.mode === m.id} onChange={() => setS({ ...s, mode: m.id })} />
            {m.label}
            {!m.ok && <span className="muted"> ({m.why})</span>}
          </label>
        ))}
      </div>
      {s.mode === "system" && (
        <label>الطابعة
          <select value={s.printerName} onChange={(e) => setS({ ...s, printerName: e.target.value })}>
            <option value="">—</option>
            {printers.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      )}
      {s.mode === "network" && (
        <div className="row">
          <label style={{ flex: 2 }}>عنوان IP<input className="num" value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} /></label>
          <label style={{ flex: 1 }}>المنفذ<input className="num" value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) || 9100 })} /></label>
        </div>
      )}
      {s.mode === "serial" && (
        <label>السرعة (Baud)
          <select value={s.baudRate} onChange={(e) => setS({ ...s, baudRate: Number(e.target.value) })}>
            {[9600, 19200, 38400, 115200].map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
      )}
      {s.mode !== "browser" && (
        <>
          <div className="tabs">
            {([80, 58] as const).map((w) => (
              <button key={w} className={s.paper === w ? "active" : ""} onClick={() => setS({ ...s, paper: w })}>ورق {w} مم</button>
            ))}
          </div>
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={s.openDrawerOnCash} onChange={(e) => setS({ ...s, openDrawerOnCash: e.target.checked })} />
            افتح الدرج أوتوماتيك مع الدفع الكاش
          </label>
        </>
      )}
      <div className="row">
        <button onClick={() => run(() => printReceipt(SAMPLE, { openDrawer: false }, s), "تم إرسال صفحة التجربة")}>طباعة تجربة</button>
        {s.mode !== "browser" && <button onClick={() => run(() => openDrawer(s), "تم إرسال أمر فتح الدرج")}>تجربة الدرج</button>}
      </div>
      <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--line)" }} />
      <ScaleSection s={scale} set={setScale} />
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="row">
        <span className="spacer" />
        <button className="primary" onClick={() => { savePrinterSettings(s); saveScaleSettings(scale); onClose(); }}>حفظ</button>
      </div>
    </Modal>
  );
}

const REQUESTS: [string, string][] = [["W\\r\\n", "يرسل W (أغلب الموازين)"], ["\\x05", "يرسل ENQ"], ["", "الميزان يرسل لحاله باستمرار"]];

function ScaleSection({ s, set }: { s: ScaleSettings; set: (s: ScaleSettings) => void }) {
  const desktop = isDesktopApp();
  const [ports, setPorts] = useState<{ name: string; label: string }[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (desktop) void listScalePorts().then(setPorts).catch(() => setPorts([]));
  }, [desktop]);
  const modes: { id: ScaleSettings["mode"]; label: string; ok: boolean; why?: string }[] = [
    { id: "off", label: "بدون ميزان (الوزن يتكتب أو من ملصق الميزان)", ok: true },
    { id: "desktop", label: "ميزان على منفذ COM", ok: desktop, why: "يحتاج تطبيق ويندوز" },
    { id: "browser", label: "ميزان عن طريق المتصفح", ok: webSerialSupported(), why: "يحتاج Chrome أو Edge" },
  ];
  async function test() {
    saveScaleSettings(s);
    setMsg(null);
    try {
      const g = await readScaleWeight(s);
      setMsg({ text: `الوزن: ${(g / 1000).toFixed(3)} كغ ✓` });
    } catch (e) {
      setMsg({ text: (e as Error).message ?? String(e), bad: true });
    }
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <b>الميزان</b>
      {modes.map((m) => (
        <label key={m.id} className="row" style={{ color: m.ok ? "var(--ink)" : "var(--muted)" }}>
          <input type="radio" style={{ width: "auto" }} disabled={!m.ok} checked={s.mode === m.id} onChange={() => set({ ...s, mode: m.id })} />
          {m.label}
          {!m.ok && <span className="muted"> ({m.why})</span>}
        </label>
      ))}
      {s.mode !== "off" && (
        <div className="row">
          {s.mode === "desktop" && (
            <label>المنفذ
              <select value={s.port} onChange={(e) => set({ ...s, port: e.target.value })} style={{ width: "auto" }}>
                <option value="">—</option>
                {ports.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
              </select>
            </label>
          )}
          <label>السرعة (Baud)
            <select value={s.baudRate} onChange={(e) => set({ ...s, baudRate: Number(e.target.value) })} style={{ width: "auto" }}>
              {[2400, 4800, 9600, 19200].map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
          <label>طريقة القراءة
            <select value={s.request} onChange={(e) => set({ ...s, request: e.target.value })} style={{ width: "auto" }}>
              {REQUESTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <button onClick={test}>اقرأ الوزن</button>
        </div>
      )}
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
    </div>
  );
}
