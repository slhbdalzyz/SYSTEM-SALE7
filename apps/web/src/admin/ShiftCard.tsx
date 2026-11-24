import { useEffect, useState } from "react";
import { DEFAULT_NOTES, formatMoney, readShopSettings, toMinor, type ShiftSettings } from "@pos/shared";
import type { Call } from "./Admin";

const money = (m: number) => String(m / 1000);
const parse = (v: string) => {
  const n = Number(v.replace(",", ".").trim() || "0");
  return Number.isFinite(n) && n >= 0 ? toMinor(n) : null;
};

/**
 * «🧾 قفل الوردية»: how a shift closes on this shop's tills. Every option is off until the owner
 * turns it on, and each one saves as soon as it changes.
 */
export function ShiftCard({ call }: { call: Call }) {
  const [s, setS] = useState<ShiftSettings | null>(null);
  const [notesText, setNotesText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    call<{ settings: unknown }>("/settings").then((r) => {
      const sh = readShopSettings(r.settings).shift;
      setS(sh);
      setNotesText(sh.notes.join("، "));
    }).catch((e) => setError((e as Error).message));
  }, [call]);

  async function save(next: ShiftSettings) {
    setError(null);
    setSaved(false);
    setS(next);
    try {
      const r = await call<{ shift: ShiftSettings }>("/settings/shift", { method: "PATCH", body: next });
      setS(r.shift);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s) return error ? <div className="error">{error}</div> : null;
  const on = (k: keyof ShiftSettings, title: string, text: string, extra?: React.ReactNode) => (
    <div className="stack" style={{ gap: 4 }}>
      <label className="check" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={!!s[k]} onChange={(e) => void save({ ...s, [k]: e.target.checked })} />
        <span><b>{title}</b><br /><span className="muted small">{text}</span></span>
      </label>
      {s[k] && extra && <div style={{ paddingInlineStart: 28 }}>{extra}</div>}
    </div>
  );
  const moneyInput = (k: "diffLimitMinor" | "floatMinor", label: string) => (
    <label className="row" style={{ gap: 8 }}>{label}
      <input className="num" inputMode="decimal" style={{ width: 110 }} defaultValue={money(s[k])}
        onBlur={(e) => { const v = parse(e.target.value); if (v !== null && v !== s[k]) void save({ ...s, [k]: v }); }} />
      د.ل
    </label>
  );

  return (
    <section className="card stack">
      <b>🧾 قفل الوردية</b>
      <small className="muted">فعّل اللي يناسب محلك. كل اختيار يتحفظ أول ما تبدّله، وأجهزة الكاشير تاخذه في المزامنة الجاية.</small>
      {on("countNotes", "1. عدّ الكاش بالورقة", "الكاشير يكتب كم ورقة من كل فئة، والمجموع يطلع بروحه وينطبع في التقرير.",
        <label>الفئات (د.ل، مفصولة بفاصلة)
          <input value={notesText} onChange={(e) => setNotesText(e.target.value)}
            onBlur={() => {
              const list = [...new Set(notesText.split(/[،,\s]+/).map((x) => Number(x)).filter((x) => x > 0 && x <= 1000))].sort((a, b) => b - a);
              const notes = list.length ? list : DEFAULT_NOTES;
              setNotesText(notes.join("، "));
              void save({ ...s, notes });
            }} />
        </label>)}
      {on("blind", "2. قفل أعمى", "الكاشير ما يشوفش المبلغ المتوقع ولا الفرق، لا على الشاشة ولا في التقرير المطبوع. الفرق يوصلك انت بس.")}
      {on("preChecks", "3. فحص قبل القفل", "ينبّه الكاشير لو فيه فواتير معلّقة، أو زباين مفتوحين، أو طاولات، أو مبيعات ما توصلتش للسيرفر.")}
      {on("diffCheck", "4. سبب الفرق وموافقة المدير", "لو الفرق في الدرج أكبر من الحد، الكاشير ما يقفلش إلا بالشروط اللي تختارها.",
        <div className="stack" style={{ gap: 6 }}>
          {moneyInput("diffLimitMinor", "الحد المسموح")}
          <label className="check"><input type="checkbox" checked={s.needReason} onChange={(e) => void save({ ...s, needReason: e.target.checked })} /> يكتب سبب الفرق</label>
          <label className="check"><input type="checkbox" checked={s.needManager} onChange={(e) => void save({ ...s, needManager: e.target.checked })} /> يحتاج الرقم السري متاع المدير (الجهاز لازم يكون متصل)</label>
        </div>)}
      {on("handover", "5. تسليم الدرج", "الكاشير يخلّي فكّة في الدرج للوردية الجاية، والباقي ينحسب للخزنة. الوردية الجاية على نفس الجهاز تفتح بالفكّة هذي.",
        moneyInput("floatMinor", "الفكّة المعتادة"))}
      {on("cardCheck", "6. مطابقة البطاقة والتحويلات", "الكاشير يكتب مجموع جهاز البطاقة والتحويلات، والتقرير يبيّن الفرق في كل وحدة بروحها.")}
      <div className="stack" style={{ gap: 4 }}>
        <label className="check" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={!!s.autoCloseAt} onChange={(e) => void save({ ...s, autoCloseAt: e.target.checked ? "23:59" : "" })} />
          <span><b>7. قفل تلقائي آخر اليوم</b><br /><span className="muted small">أي وردية تنسات مفتوحة تتسكّر بروحها في الساعة هذي. وتقدر دايماً تقفل أي وردية من «الرئيسية» أو من التلفون.</span></span>
        </label>
        {s.autoCloseAt && (
          <label className="row" style={{ gap: 8, paddingInlineStart: 28 }}>الساعة
            <input type="time" value={s.autoCloseAt} style={{ width: 130 }} onChange={(e) => e.target.value && void save({ ...s, autoCloseAt: e.target.value })} />
          </label>
        )}
      </div>
      {on("xReport", "8. تقرير X", "زر في الكاشير يطبع حالة الوردية لين توا من غير ما يقفلها.")}
      {on("whatsappZ", "9. تقرير القفل على الواتساب", "أول ما تتسكّر الوردية، يفتح الواتساب بالتقرير جاهز للرقم هذا (فيه الفرق دايماً، حتى لو القفل أعمى).",
        <label>رقم الواتساب
          <input className="num" inputMode="tel" placeholder="رقم المحل في الإعدادات" defaultValue={s.whatsappPhone}
            onBlur={(e) => e.target.value.trim() !== s.whatsappPhone && void save({ ...s, whatsappPhone: e.target.value.trim() })} />
        </label>)}
      {on("shortageToPayroll", "10. العجز على الكاشير", "أي عجز في الدرج ينسجّل خصم على راتب الكاشير في «الرواتب»، وتقدر تشيله من هناك.")}
      {s.diffCheck && <span className="muted small">الحد توا {formatMoney(s.diffLimitMinor)}.</span>}
      {saved && <span className="badge ok">تم الحفظ ✓</span>}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/**
 * The owner closes a shift left open, from the dashboard or the phone. The cash counted is
 * optional: without it the shift closes with no difference worked out.
 */
export function CloseShiftButton({ call, id, onDone }: { call: Call; id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setError(null);
    const v = cash.trim() ? parse(cash) : null;
    if (cash.trim() && v === null) return setError("رقم غير صحيح");
    setBusy(true);
    try {
      await call(`/shifts/${id}/owner-close`, { body: { countedCashMinor: v } });
      setOpen(false);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <button className="small" onClick={() => setOpen(true)}>قفل</button>;
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <input className="num" inputMode="decimal" placeholder="الكاش اللي لقيته (اختياري)" value={cash} onChange={(e) => setCash(e.target.value)} style={{ width: 170 }} />
      <button className="danger" onClick={() => void run()} disabled={busy}>{busy ? "…" : "قفل الوردية"}</button>
      <button onClick={() => setOpen(false)} disabled={busy}>إلغاء</button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}
