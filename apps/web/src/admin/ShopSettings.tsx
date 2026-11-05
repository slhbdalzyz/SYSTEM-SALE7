import { useEffect, useState, type ReactNode } from "react";
import { fillTemplate, formatMoney, readShopSettings, type SaleInput, type ShopSettings as Settings } from "@pos/shared";
import type { Call } from "./Admin";
import { Receipt, type ReceiptData } from "../pos/Receipt";
import { PrinterDialog } from "../hardware/PrinterDialog";
import { loadPrinterSettings } from "../hardware/printer";

/** Shrinks a picked image to a small logo (at most 360 px wide) as a data: URL. */
async function toLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 360 / img.width, 200 / img.height);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    let out = c.toDataURL("image/png");
    if (out.length > 190_000) out = c.toDataURL("image/jpeg", 0.8);
    if (out.length > 190_000) throw new Error("الصورة كبيرة، اختار صورة أصغر");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const sample = (): SaleInput => ({
  id: SAMPLE_ID, number: "A-000123", createdAt: new Date().toISOString(), invoiceDiscountMinor: 0, totalMinor: 9500,
  lines: [
    { productId: SAMPLE_ID, unitId: SAMPLE_ID, name: "بيبسي علبة", qtyMilli: 3000, priceMinor: 1500, discountMinor: 0, promoMinor: 500, offerName: "عرض الصيف", taxBp: 0 },
    { productId: SAMPLE_ID, unitId: SAMPLE_ID, name: "رز بسمتي 5 كيلو", qtyMilli: 1000, priceMinor: 5500, discountMinor: 0, promoMinor: 0, taxBp: 0 },
  ],
  payments: [{ method: "cash", amountMinor: 10000 }],
});

function Check({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/**
 * The shop's settings: its name and contact details (printed on every receipt), its bank
 * account, what the receipt shows, how the till behaves, and this device's printer.
 */
export function ShopSettings({ call, storeName, onSaved, openAlerts }: { call: Call; storeName: string; onSaved: () => void; openAlerts: () => void }) {
  const [name, setName] = useState("");
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [printer, setPrinter] = useState(false);
  const [, bump] = useState(0);

  useEffect(() => {
    call<{ name: string; settings: Settings }>("/settings")
      .then((r) => {
        setName(r.name);
        setS(readShopSettings(r.settings));
        setSaved(JSON.stringify([r.name, readShopSettings(r.settings)]));
      })
      .catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  }, [call]);

  if (!s) return msg ? <div className="error">{msg.text}</div> : <div className="muted">جاري التحميل…</div>;
  const dirty = JSON.stringify([name, s]) !== saved;
  const up = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const bank = (patch: Partial<Settings["bank"]>) => up({ bank: { ...s.bank, ...patch } });
  const rc = (patch: Partial<Settings["receipt"]>) => up({ receipt: { ...s.receipt, ...patch } });
  const till = (patch: Partial<Settings["till"]>) => up({ till: { ...s.till, ...patch } });
  const wa = (patch: Partial<Settings["whatsapp"]>) => up({ whatsapp: { ...s.whatsapp, ...patch } });
  const field = (label: string, value: string, set: (v: string) => void, extra: { max?: number; ph?: string; wide?: boolean; num?: boolean } = {}) => (
    <label style={extra.wide ? { gridColumn: "1 / -1" } : undefined}>
      {label}
      <input className={extra.num ? "num" : undefined} value={value} onChange={(e) => set(e.target.value)} maxLength={extra.max ?? 80} placeholder={extra.ph} />
    </label>
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ name: string; settings: Settings }>("/settings", { method: "PUT", body: { name: name.trim(), settings: s } });
      setSaved(JSON.stringify([r.name, readShopSettings(r.settings)]));
      setMsg({ text: "تم حفظ الإعدادات. الكاشير ياخذها أول ما يدخل أو يتزامن." });
      onSaved();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function pickLogo(f: File | undefined) {
    if (!f) return;
    try {
      up({ logo: await toLogo(f) });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  const preview: ReceiptData = { storeName, deviceName: "كاشير 1", cashierName: "أحمد", shop: { name: name || storeName, settings: s }, sale: sample(), changeMinor: 500 };
  const p = loadPrinterSettings();
  const MODE: Record<string, string> = { browser: "نافذة الطباعة في المتصفح", system: "طابعة ويندوز", network: "طابعة شبكة", serial: "منفذ تسلسلي" };

  return (
    <div className="stack settings-page">
      <section className="card stack">
        <b>🏪 بيانات المحل</b>
        <div className="form-grid">
          {field("اسم المحل", name, setName, { max: 120 })}
          {field("رقم الهاتف", s.phone, (v) => up({ phone: v }), { max: 40, num: true, ph: "09x-xxxxxxx" })}
          {field("هاتف آخر", s.phone2, (v) => up({ phone2: v }), { max: 40, num: true, ph: "اختياري" })}
          {field("البريد الإلكتروني", s.email, (v) => up({ email: v }), { max: 120, ph: "اختياري" })}
          {field("المدينة", s.city, (v) => up({ city: v }))}
          {field("العنوان", s.address, (v) => up({ address: v }), { max: 200, wide: true, ph: "الشارع، المنطقة، أقرب معلم" })}
          {field("الرقم الضريبي", s.taxNumber, (v) => up({ taxNumber: v }), { max: 60, num: true, ph: "اختياري" })}
          {field("السجل التجاري", s.commercialReg, (v) => up({ commercialReg: v }), { max: 60, num: true, ph: "اختياري" })}
        </div>
        <div className="row logo-row">
          <div className="logo-box">{s.logo ? <img src={s.logo} alt="شعار المحل" /> : <span className="muted">بدون شعار</span>}</div>
          <label className="button">
            🖼️ {s.logo ? "تغيير الشعار" : "رفع شعار"}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pickLogo(e.target.files?.[0])} />
          </label>
          {s.logo && <button className="danger" onClick={() => up({ logo: "" })}>شيل الشعار</button>}
          <span className="muted">يتصغّر تلقائياً، والأفضل صورة بخلفية بيضاء.</span>
        </div>
      </section>

      <section className="card stack">
        <b>🏦 الحساب المصرفي</b>
        <div className="muted">يطلع في الفاتورة لو فعّلت «الحساب المصرفي» تحت، عشان الزبون أو الشركات يحولولك.</div>
        <div className="form-grid">
          {field("المصرف", s.bank.name, (v) => bank({ name: v }), { ph: "مثلاً مصرف الجمهورية" })}
          {field("الفرع", s.bank.branch, (v) => bank({ branch: v }))}
          {field("اسم صاحب الحساب", s.bank.accountName, (v) => bank({ accountName: v }), { max: 120 })}
          {field("رقم الحساب", s.bank.accountNumber, (v) => bank({ accountNumber: v.replace(/\s/g, "") }), { max: 60, num: true })}
          {field("IBAN", s.bank.iban, (v) => bank({ iban: v.replace(/\s/g, "").toUpperCase() }), { max: 60, num: true, ph: "LY..", wide: true })}
        </div>
      </section>

      <section className="card settings-receipt">
        <div className="stack">
          <b>🧾 الفاتورة المطبوعة</b>
          <div className="form-grid">
            {field("سطر تحت اسم المحل", s.receipt.header, (v) => rc({ header: v }), { max: 120, ph: "مثلاً: مفتوح من 8 الصبح لـ 12 الليل", wide: true })}
            {field("رسالة آخر الفاتورة", s.receipt.footer, (v) => rc({ footer: v }), { max: 200, ph: "شكراً لزيارتكم", wide: true })}
          </div>
          <div className="checks">
            <Check on={s.receipt.showLogo} set={(v) => rc({ showLogo: v })}>الشعار</Check>
            <Check on={s.receipt.showBranch} set={(v) => rc({ showBranch: v })}>اسم الفرع</Check>
            <Check on={s.receipt.showAddress} set={(v) => rc({ showAddress: v })}>العنوان</Check>
            <Check on={s.receipt.showPhone} set={(v) => rc({ showPhone: v })}>الهاتف</Check>
            <Check on={s.receipt.showTaxNumber} set={(v) => rc({ showTaxNumber: v })}>الرقم الضريبي والسجل</Check>
            <Check on={s.receipt.showBank} set={(v) => rc({ showBank: v })}>الحساب المصرفي</Check>
            <Check on={s.receipt.showCashier} set={(v) => rc({ showCashier: v })}>اسم الكاشير</Check>
            <Check on={s.receipt.showSavings} set={(v) => rc({ showSavings: v })}>«وفّرت من العروض»</Check>
          </div>
          <label className="row" style={{ color: "var(--ink)" }}>
            عدد النسخ لكل فاتورة
            <div className="seg">
              {[1, 2, 3].map((n) => <button key={n} type="button" className={s.receipt.copies === n ? "active" : ""} onClick={() => rc({ copies: n })}>{n}</button>)}
            </div>
          </label>
          {s.receipt.copies > 1 && <div className="hint">النسخ بعد الأولى يتكتب فوقها «نسخة»، والدرج يفتح مرة وحدة بس.</div>}
          {s.receipt.showBank && !s.bank.accountNumber && !s.bank.iban && <div className="notice">عبّي رقم الحساب أو الـIBAN فوق عشان يطلع في الفاتورة.</div>}
        </div>
        <div className="receipt-preview" aria-label="معاينة الفاتورة">
          <small className="muted">معاينة</small>
          <Receipt data={preview} preview />
        </div>
      </section>

      <section className="card stack">
        <b>🛒 الكاشير</b>
        <div className="checks col">
          <Check on={s.till.autoPrint} set={(v) => till({ autoPrint: v })}>اطبع الفاتورة تلقائياً بعد كل بيعة <small className="muted">(لو مقفولة: الدرج يفتح، والطباعة بزر «إعادة طباعة» أو F7)</small></Check>
          <Check on={s.till.confirmClear} set={(v) => till({ confirmClear: v })}>اسأل قبل إلغاء فاتورة فيها أصناف</Check>
          <Check on={s.till.askPriceWhenZero} set={(v) => till({ askPriceWhenZero: v })}>صنف بدون سعر: اسأل الكاشير على السعر <small className="muted">(لو مقفولة: يرفض بيعه)</small></Check>
          <Check on={s.till.cashierPriceChange} set={(v) => till({ cashierPriceChange: v })}>الكاشير يقدر يعدّل سعر الصنف <small className="muted">(المالك والمدير دايماً يقدروا)</small></Check>
        </div>
        <label className="row" style={{ color: "var(--ink)" }}>
          أقصى خصم يعطيه الكاشير على الفاتورة
          <input className="num" type="number" min={0} max={100} value={s.till.cashierMaxDiscountPct} style={{ width: 80 }}
            onChange={(e) => till({ cashierMaxDiscountPct: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) })} aria-label="أقصى خصم" />
          %
          <span className="muted">{s.till.cashierMaxDiscountPct === 0 ? "ما يقدرش يعطي خصم" : ""}</span>
        </label>
      </section>

      <section className="card stack">
        <b>📲 رسائل الواتساب</b>
        <div className="muted">الكاشير يبعت الفاتورة للزبون، وانت تذكّر العملاء بديونهم من صفحة العملاء. الكلمات بين القوسين تتعبى تلقائياً: {"{shop}"} اسم المحل، {"{number}"} رقم الفاتورة، {"{total}"} المبلغ، {"{link}"} رابط الفاتورة، {"{name}"} اسم العميل، {"{balance}"} الدين.</div>
        <div className="wa-grid">
          <label>رسالة الفاتورة
            <textarea rows={4} value={s.whatsapp.invoiceMessage} maxLength={600} onChange={(e) => wa({ invoiceMessage: e.target.value })} />
            <span className="wa-bubble">{fillTemplate(s.whatsapp.invoiceMessage, { shop: name, number: "A-000123", total: formatMoney(9500), link: `${location.origin}/?r=…` })}</span>
          </label>
          <label>رسالة تذكير الدين
            <textarea rows={4} value={s.whatsapp.debtMessage} maxLength={600} onChange={(e) => wa({ debtMessage: e.target.value })} />
            <span className="wa-bubble">{fillTemplate(s.whatsapp.debtMessage, { shop: name, name: "محمد", balance: formatMoney(45000) })}</span>
          </label>
        </div>
        <Check on={s.whatsapp.offerAfterSale} set={(v) => wa({ offerAfterSale: v })}>بعد كل بيعة يطلع للكاشير زر «أرسل الفاتورة على الواتساب»</Check>
      </section>

      <section className="card stack">
        <b>🖨️ الطابعة والدرج على هذا الجهاز</b>
        <div className="row">
          <span>الطباعة: <b>{MODE[p.mode] ?? p.mode}</b>{p.mode !== "browser" && ` · ورق ${p.paper} مم`}</span>
          <span className="spacer" />
          <button onClick={() => setPrinter(true)}>إعدادات الطابعة والميزان</button>
        </div>
        <div className="muted">إعدادات الطابعة تخص كل جهاز لوحده، فاضبطها من جهاز الكاشير نفسه.</div>
      </section>

      <section className="card row">
        <span>🔔 تنبيهات التلفون (نقص المخزون، الصلاحية، فرق الدرج…)</span>
        <span className="spacer" />
        <button onClick={openAlerts}>إعدادات التنبيهات</button>
      </section>

      <div className="save-bar">
        {msg && <span className={msg.bad ? "error" : "badge ok"}>{msg.text}</span>}
        <span className="spacer" />
        {dirty && <span className="muted">فيه تعديلات ما تحفظتش</span>}
        <button className="primary" disabled={!dirty || busy || name.trim().length < 2} onClick={save}>💾 حفظ الإعدادات</button>
      </div>

      {printer && <PrinterDialog onClose={() => { setPrinter(false); bump((n) => n + 1); }} />}
    </div>
  );
}
