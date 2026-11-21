import { useEffect, useMemo, useRef, useState } from "react";
import type { ReceiptData } from "../pos/Receipt";
import { Modal } from "../pos/dialogs";
import { pageHtml } from "./pageInvoice";
import { listScalePorts, loadScaleSettings, readScaleWeight, saveScaleSettings, webSerialSupported, type ScaleSettings } from "../scale";
import { isDesktopApp, listSystemPrinters, loadKitchenPrinter, loadPrinterSettings, openDrawer, paperDots, printReceipt, receiptBitmap, saveKitchenPrinter, savePrinterSettings, serialSupported, type KitchenPrinterSettings, type PrinterMode, type PrinterSettings } from "./printer";

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

const KITCHEN_SAMPLE: ReceiptData = {
  storeName: "تجربة الطابعة",
  deviceName: "كاشير",
  cashierName: "تجربة",
  kitchen: {
    label: "طاولة 4",
    orderType: "dine_in",
    at: new Date().toISOString(),
    lines: [
      { name: "شاورما دجاج", qtyMilli: 2000, note: "بدون ثوم" },
      { name: "عصير برتقال", qtyMilli: 1000 },
    ],
  },
};

const SIZES: [number, string][] = [[0.85, "صغير"], [1, "عادي"], [1.15, "كبير"], [1.3, "كبير جداً"]];

type Tab = "receipt" | "kitchen" | "scale";

/**
 * This device's printers, the way the shop wants them: how each is reached, the paper, how big and
 * dark the print is, the edges, the cut, a beep, the drawer; the kitchen's own printer; and the scale.
 * Lives on the device (each till has its own printer), so it is set from the till itself.
 */
export function PrinterSetup({ onSaved }: { onSaved?: () => void }) {
  const [tab, setTab] = useState<Tab>("receipt");
  const [receipt, setReceipt] = useState<PrinterSettings>(loadPrinterSettings);
  const [kitchen, setKitchen] = useState<KitchenPrinterSettings>(loadKitchenPrinter);
  const [scale, setScale] = useState<ScaleSettings>(loadScaleSettings);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  function save() {
    savePrinterSettings(receipt);
    saveKitchenPrinter(kitchen);
    saveScaleSettings(scale);
    setMsg({ text: "تم حفظ إعدادات الطابعات على هذا الجهاز ✓" });
    onSaved?.();
  }

  return (
    <div className="stack printer-setup">
      <div className="tabs">
        <button className={tab === "receipt" ? "active" : ""} onClick={() => setTab("receipt")}>🧾 طابعة الفواتير</button>
        <button className={tab === "kitchen" ? "active" : ""} onClick={() => setTab("kitchen")}>👨‍🍳 طابعة المطبخ</button>
        <button className={tab === "scale" ? "active" : ""} onClick={() => setTab("scale")}>⚖️ الميزان</button>
      </div>
      {tab === "receipt" && <PrinterForm s={receipt} set={setReceipt} sample={SAMPLE} drawer />}
      {tab === "kitchen" && (
        <>
          <div className="tabs">
            <button className={!kitchen.separate ? "active" : ""} onClick={() => setKitchen({ ...kitchen, separate: false })}>نفس طابعة الفواتير</button>
            <button className={kitchen.separate ? "active" : ""} onClick={() => setKitchen({ ...kitchen, separate: true })}>طابعة خاصة بالمطبخ</button>
          </div>
          {kitchen.separate ? (
            <>
              <PrinterForm s={kitchen} set={(k) => setKitchen({ ...kitchen, ...k })} sample={KITCHEN_SAMPLE} />
              <div className="row">
                <span>نسخ ورقة المطبخ</span>
                <div className="tabs">
                  {[1, 2, 3].map((n) => <button key={n} className={kitchen.copies === n ? "active" : ""} onClick={() => setKitchen({ ...kitchen, copies: n })}>{n}</button>)}
                </div>
              </div>
            </>
          ) : (
            <div className="muted">ورقة المطبخ تطلع من طابعة الفواتير. لو عندك طابعة تانية في المطبخ (مثلاً طابعة شبكة)، اختار «طابعة خاصة بالمطبخ». تشغيل الطباعة مع كل إرسال للمطبخ من زر المطبخ في الكاشير.</div>
          )}
        </>
      )}
      {tab === "scale" && <ScaleSection s={scale} set={setScale} />}
      <div className="row">
        {msg && <span className={msg.bad ? "error" : "badge ok"}>{msg.text}</span>}
        <span className="spacer" />
        <button className="primary" onClick={save}>💾 حفظ إعدادات الطابعات</button>
      </div>
    </div>
  );
}

function PrinterForm<T extends PrinterSettings>({ s, set, sample, drawer }: { s: T; set: (s: T) => void; sample: ReceiptData; drawer?: boolean }) {
  const [printers, setPrinters] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const desktop = isDesktopApp();
  const up = (patch: Partial<PrinterSettings>) => set({ ...s, ...patch });

  useEffect(() => {
    if (desktop) void listSystemPrinters().then(setPrinters).catch(() => setPrinters([]));
  }, [desktop]);

  const modes: { id: PrinterMode; label: string; ok: boolean; why?: string }[] = [
    { id: "browser", label: "نافذة الطباعة في المتصفح", ok: true },
    { id: "system", label: "طابعة مثبتة على ويندوز", ok: desktop, why: "يحتاج تطبيق ويندوز" },
    { id: "network", label: "طابعة شبكة (IP)", ok: desktop, why: "يحتاج تطبيق ويندوز" },
    { id: "serial", label: "منفذ تسلسلي / USB-Serial", ok: serialSupported(), why: "يحتاج Chrome أو Edge" },
  ];
  const page = s.sheet === "A4" || s.sheet === "A5";
  const direct = s.mode !== "browser";
  const custom = s.dots >= 200;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok });
    } catch (e) {
      setMsg({ text: `ما نجحتش: ${(e as Error).message ?? e}`, bad: true });
    }
  }

  return (
    <div className="printer-form">
      <div className="stack">
        {!page && <>
        <b>التوصيل</b>
        <div className="stack" style={{ gap: 6 }}>
          {modes.map((m) => (
            <label key={m.id} className="row" style={{ color: m.ok ? "var(--ink)" : "var(--muted)" }}>
              <input type="radio" style={{ width: "auto" }} disabled={!m.ok} checked={s.mode === m.id} onChange={() => up({ mode: m.id })} />
              {m.label}
              {!m.ok && <span className="muted"> ({m.why})</span>}
            </label>
          ))}
        </div>
        {s.mode === "system" && (
          <label>الطابعة
            <select value={s.printerName} onChange={(e) => up({ printerName: e.target.value })}>
              <option value="">—</option>
              {printers.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
        )}
        {s.mode === "network" && (
          <div className="row">
            <label style={{ flex: 2 }}>عنوان IP<input className="num" value={s.host} onChange={(e) => up({ host: e.target.value.trim() })} /></label>
            <label style={{ flex: 1 }}>المنفذ<input className="num" value={s.port} onChange={(e) => up({ port: Number(e.target.value) || 9100 })} /></label>
          </div>
        )}
        {s.mode === "serial" && (
          <label>السرعة (Baud)
            <select value={s.baudRate} onChange={(e) => up({ baudRate: Number(e.target.value) })}>
              {[9600, 19200, 38400, 115200].map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
        )}
        </>}

        <b>الورق</b>
        <div className="tabs">
          {([80, 58] as const).map((w) => (
            <button key={w} className={!page && s.paper === w && !custom ? "active" : ""} onClick={() => up({ sheet: "roll", paper: w, dots: 0 })}>رول {w} مم</button>
          ))}
          {direct && !page && <button className={custom ? "active" : ""} onClick={() => up({ dots: custom ? 0 : 512, paper: 80 })}>عرض خاص</button>}
          {(["A4", "A5"] as const).map((z) => (
            <button key={z} className={s.sheet === z ? "active" : ""} onClick={() => up({ sheet: z })}>📄 {z}</button>
          ))}
        </div>
        {page && <div className="hint">فاتورة كاملة بجدول على ورق {s.sheet}، تنطبع على أي طابعة عادية (ليزر أو حبر) من نافذة الطباعة. أول مرة اختار الطابعة وحجم الورق {s.sheet} في النافذة، والمتصفح يتذكرهم.</div>}
        {direct && !page && custom && (
          <label>عدد النقاط في السطر <small className="muted">(من كتيب الطابعة: 80 مم غالباً 576 أو 512، و58 مم 384)</small>
            <input className="num" type="number" min={200} max={832} step={8} value={s.dots} onChange={(e) => up({ dots: Math.max(200, Math.min(832, Math.round((Number(e.target.value) || 512) / 8) * 8)) })} />
          </label>
        )}

        <b>شكل الطباعة</b>
        <div className="row">
          <span>حجم الكتابة</span>
          <div className="tabs">
            {SIZES.map(([v, l]) => <button key={v} className={s.textScale === v ? "active" : ""} onClick={() => up({ textScale: v })}>{l}</button>)}
          </div>
        </div>
        <label>الهامش على الجنبين: <b className="num">{s.marginMm} مم</b>
          <input type="range" min={0} max={6} step={0.5} value={s.marginMm} onChange={(e) => up({ marginMm: Number(e.target.value) })} />
        </label>
        {direct && !page && (
          <>
            <label>غمق الطباعة: <b>{s.darkness < 140 ? "فاتح" : s.darkness > 185 ? "غامق" : "عادي"}</b>
              <input type="range" min={110} max={220} step={10} value={s.darkness} onChange={(e) => up({ darkness: Number(e.target.value) })} />
            </label>
            <label>سطور فاضية قبل القص: <b className="num">{s.feed}</b>
              <input type="range" min={0} max={8} step={1} value={s.feed} onChange={(e) => up({ feed: Number(e.target.value) })} />
            </label>
            <div className="checks col">
              <label className="row" style={{ color: "var(--ink)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={s.cut} onChange={(e) => up({ cut: e.target.checked })} />
                قص الورقة أوتوماتيك بعد كل فاتورة
              </label>
              <label className="row" style={{ color: "var(--ink)" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={s.beep} onChange={(e) => up({ beep: e.target.checked })} />
                صفّارة مع كل طباعة <small className="muted">(للطابعات اللي فيها صفّارة)</small>
              </label>
              {drawer && (
                <label className="row" style={{ color: "var(--ink)" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={s.openDrawerOnCash} onChange={(e) => up({ openDrawerOnCash: e.target.checked })} />
                  افتح الدرج أوتوماتيك مع الدفع الكاش
                </label>
              )}
            </div>
          </>
        )}
        {!direct && !page && <div className="hint">الغمق والقص والصفّارة والدرج تشتغل لما الطابعة تكون موصولة مباشرة (تطبيق ويندوز أو منفذ تسلسلي).</div>}
        <div className="row">
          <button onClick={() => run(() => printReceipt(sample, { openDrawer: false }, s), "تم إرسال صفحة التجربة")}>🖨️ طباعة تجربة</button>
          {drawer && direct && !page && <button onClick={() => run(() => openDrawer(s), "تم إرسال أمر فتح الدرج")}>تجربة الدرج</button>}
        </div>
        {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      </div>
      {page ? <PagePreview s={s} sample={sample} /> : <PaperPreview s={s} sample={sample} />}
    </div>
  );
}

/** The sample drawn in the printer's own black and white dots, so size, darkness and edges show before printing. */
function PaperPreview({ s, sample }: { s: PrinterSettings; sample: ReceiptData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { paper, dots, textScale, darkness, marginMm } = s;
  useEffect(() => {
    let live = true;
    void (async () => {
      await document.fonts?.ready;
      const b = await receiptBitmap(sample, { paper, dots, textScale, darkness, marginMm });
      const c = ref.current;
      if (!live || !c) return;
      c.width = b.width;
      c.height = b.height;
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(b.width, b.height);
      const row = b.width / 8;
      for (let y = 0; y < b.height; y++) {
        for (let x = 0; x < b.width; x++) {
          const on = b.data[y * row + (x >> 3)] & (0x80 >> (x & 7));
          const i = (y * b.width + x) * 4;
          const v = on ? 20 : 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sample, paper, dots, textScale, darkness, marginMm]);
  const mm = Math.round(paperDots(s) / 8);
  return (
    <div className="paper-preview" aria-label="معاينة الورقة">
      <small className="muted">معاينة · عرض الطباعة {mm} مم</small>
      <canvas ref={ref} style={{ width: `${Math.round(mm * 3.4)}px` }} />
    </div>
  );
}

/** An A4/A5 page drawn small, from the very document that will be printed. */
function PagePreview({ s, sample }: { s: PrinterSettings; sample: ReceiptData }) {
  const size = s.sheet === "A5" ? "A5" : "A4";
  const [wMm, hMm] = size === "A5" ? [148, 210] : [210, 297];
  const html = useMemo(() => pageHtml(sample, { size, textScale: s.textScale, marginMm: s.marginMm }), [sample, size, s.textScale, s.marginMm]);
  // Shown 260 px wide; the frame is laid out at the page's real width (96 px to the inch) and scaled down.
  const pageW = Math.round((wMm / 25.4) * 96);
  const pageH = Math.round((hMm / 25.4) * 96);
  const k = 260 / pageW;
  const pad = Math.round((((size === "A5" ? 7 : 10) + (s.marginMm || 0)) / 25.4) * 96);
  return (
    <div className="paper-preview" aria-label="معاينة الصفحة">
      <small className="muted">معاينة · ورق {size}</small>
      <div className="page-preview" style={{ width: 260, height: Math.round(pageH * k) }}>
        <iframe title="معاينة" srcDoc={html} style={{ width: pageW, height: pageH, padding: pad, transform: `scale(${k})` }} tabIndex={-1} />
      </div>
    </div>
  );
}

/** The till's quick access: the same settings in a window. */
export function PrinterDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="الطابعات والدرج والميزان" onClose={onClose} wide>
      <PrinterSetup onSaved={onClose} />
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>إغلاق</button>
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
