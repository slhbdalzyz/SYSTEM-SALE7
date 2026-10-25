import { useEffect, useState } from "react";
import type { ReceiptData } from "../pos/Receipt";
import { Modal } from "../pos/dialogs";
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
      { productId: "", unitId: "", name: "حليب طازج 1 لتر", qtyMilli: 2000, priceMinor: 3500, discountMinor: 0, taxBp: 0 },
      { productId: "", unitId: "", name: "طماطم", qtyMilli: 1250, priceMinor: 3500, discountMinor: 0, taxBp: 0 },
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
    <Modal title="الطابعة والدرج" onClose={onClose}>
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
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="row">
        <button onClick={() => run(() => printReceipt(SAMPLE, { openDrawer: false }, s), "تم إرسال صفحة التجربة")}>طباعة تجربة</button>
        {s.mode !== "browser" && <button onClick={() => run(() => openDrawer(s), "تم إرسال أمر فتح الدرج")}>تجربة الدرج</button>}
        <span className="spacer" />
        <button className="primary" onClick={() => { savePrinterSettings(s); onClose(); }}>حفظ</button>
      </div>
    </Modal>
  );
}
