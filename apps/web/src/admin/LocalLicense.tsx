// The local edition's yearly licence: this computer's ID to send to the seller, the key they send
// back, and how long it has left. Works with no internet.
import { useEffect, useState } from "react";
import { formatMoney, type LicensePlans } from "@pos/shared";
import type { SubState } from "../billing";
import type { Call } from "./Admin";

export interface Lic {
  machineId: string;
  canActivate: boolean;
  license: { shop: string; from: string; until: string; devices: number; plan?: string | null } | null;
  /** Cashier tills in use, and how many the licence or the trial allows (kitchen screens and price checkers are free). */
  tills?: number;
  tillLimit?: number | null;
  /** The packages on sale, as last fetched from the seller (null before the computer was ever online). */
  plans?: LicensePlans | null;
  state: SubState;
  paidUntil: string | null;
  daysLeft: number;
  reason: string | null;
}

/** One line at the top of the owner's screens when the licence needs attention. */
export function licNotice(l: Lic): { text: string; bad: boolean } | null {
  if (l.state === "trial") return { text: l.daysLeft > 0 ? `فترة تجريبية: باقيلك ${l.daysLeft} يوم. فعّل الترخيص السنوي قبل ما تخلص.` : "خلصت الفترة التجريبية.", bad: l.daysLeft <= 3 };
  if (l.state === "active" && l.daysLeft <= 30) return { text: `الترخيص السنوي ينتهي بعد ${l.daysLeft} يوم. جدّده من صفحة الترخيص.`, bad: false };
  if (l.state === "grace") return { text: `انتهى الترخيص من ${-l.daysLeft} يوم. جدّده قبل ما تتقفل الإدارة (البيع يكمل عادي).`, bad: true };
  if (l.state === "locked") return { text: "انتهى الترخيص: الإدارة مقفولة والبيع يكمل عادي. فعّل مفتاح جديد.", bad: true };
  if (l.state === "suspended") return { text: l.reason ?? "النظام موقوف.", bad: true };
  return null;
}

const STATE: Record<string, [string, string]> = {
  trial: ["فترة تجريبية", "off"],
  active: ["مفعّل", "ok"],
  grace: ["مهلة بعد الانتهاء", "bad"],
  locked: ["منتهي", "bad"],
  suspended: ["موقوف", "bad"],
};

export function LocalLicense({ call, onChange }: { call: Call; onChange?: () => void }) {
  const [l, setL] = useState<Lic | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = () => call<Lic>("/local/license").then(setL).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function activate() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await call<{ until: string }>("/local/license", { body: { key } });
      setKey("");
      setMsg(`تم التفعيل ✓ الترخيص صالح لين ${r.until}`);
      await load();
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await call<{ updated: boolean }>("/local/license/check", { body: {} });
      setMsg(r.updated ? "وصل ترخيص جديد وتفعّل ✓" : "ما فيش ترخيص جديد لين توا. لو دفعت، كلّم البائع يصدره.");
      await load();
      if (r.updated) onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!l) return error ? <div className="error">{error}</div> : <div className="muted">جاري التحميل…</div>;
  const [label, tone] = STATE[l.state] ?? [l.state, "off"];
  const note = licNotice(l);
  const ask = `السلام عليكم، نبي ترخيص سنوي لنظام نقاط البيع.\nرقم الجهاز: ${l.machineId}`;
  const seller = l.plans?.sellerPhone?.replace(/\D/g, "").replace(/^0/, "218") ?? "";
  const wa = (text: string) => `https://wa.me/${seller}?text=${encodeURIComponent(text)}`;
  const limit = l.tillLimit ?? l.license?.devices ?? null;
  const full = limit !== null && (l.tills ?? 0) >= limit;
  const money = (m: number) => formatMoney(m).replace(".000", "");
  const want = (name: string) => `السلام عليكم، نبي باقة أكبر لنظام نقاط البيع.\nالمحل: ${l.license?.shop ?? ""}\nرقم الجهاز: ${l.machineId}\nالباقة الحالية: ${l.license?.plan ?? (l.state === "trial" ? "تجربة" : "")} (${limit ?? "?"} كاشير)\nالباقة اللي نبيها: ${name}`;
  return (
    <div className="stack">
      {note && <div className={note.bad ? "error" : "notice"}>{note.text}</div>}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>⭐ الترخيص السنوي</h3>
        <div className="row">
          <span className={`badge ${tone}`}>{label}</span>
          {l.license ? <span>{l.license.shop} · من <b className="num">{l.license.from}</b> لين <b className="num">{l.license.until}</b></span> : l.state === "trial" && <span>التجربة تنتهي بعد <b className="num">{Math.max(l.daysLeft, 0)}</b> يوم</span>}
          {l.license?.plan && <span>· باقة <b>{l.license.plan}</b></span>}
        </div>
        {limit !== null && (
          <div className="row">
            <span>أجهزة الكاشير: <b className="num">{l.tills ?? 0}</b> من <b className="num">{limit}</b></span>
            <span style={{ flex: 1, maxWidth: 220, height: 8, borderRadius: 4, background: "var(--line, #ddd)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.min(100, ((l.tills ?? 0) / Math.max(limit, 1)) * 100)}%`, background: full ? "var(--bad, #c0392b)" : "var(--accent, #2e7d32)" }} />
            </span>
            {full && <span className="badge bad">وصلت للحد</span>}
          </div>
        )}
        <div className="muted small">{l.state === "trial" ? "التجربة تسمح بـ 3 أجهزة كاشير. " : ""}شاشة المطبخ وقارئ الأسعار وتلفون المالك ما يتحسبوش من الأجهزة.</div>
        <div className="row">
          <button disabled={busy} onClick={check}>{busy ? "جاري التحقق…" : "🔄 تحقق من ترخيص جديد"}</button>
          <span className="muted small">بعد ما تدفع للترقية أو التجديد، اضغط هنا والجهاز متصل بالنت.</span>
        </div>
        {msg && <div className="notice">{msg}</div>}
        {error && <div className="error">{error}</div>}
      </div>

      {l.plans && l.plans.plans.length > 0 && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>📦 الباقات</h3>
          <div className="row" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
            {l.plans.plans.map((p) => {
              const mine = l.license?.plan === p.name;
              const bigger = limit === null || p.devices > limit;
              return (
                <div key={p.id} className="card stack" style={{ minWidth: 160, flex: 1, borderColor: mine ? "var(--accent, #2e7d32)" : undefined }}>
                  <b>{p.name}{mine && " ✓"}</b>
                  <span><b className="num">{p.devices}</b> {p.devices === 1 ? "جهاز كاشير" : "أجهزة كاشير"}</span>
                  <span><b className="num">{money(p.priceMinor)}</b> في السنة</span>
                  {!mine && bigger && <a className="button" href={wa(want(p.name))} target="_blank" rel="noopener">أبي هذي الباقة</a>}
                </div>
              );
            })}
          </div>
          <div className="muted small">
            {l.plans.extraDeviceMinor > 0 && `جهاز كاشير زيادة فوق الباقة: ${money(l.plans.extraDeviceMinor)} في السنة. `}
            {Object.entries(l.plans.yearDiscounts).filter(([, v]) => v > 0).map(([y, v]) => `خصم ${v}% لو دفعت ${y} سنين`).join(" · ")}
            {l.license && " · الترقية في نص السنة تدفع فيها الفرق على الأيام اللي باقية بس، وتبقى نهاية الترخيص نفسها."}
          </div>
        </div>
      )}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>1. ابعت رقم الجهاز</h3>
        <div className="muted">الترخيص مربوط بهذا الكمبيوتر. ابعت الرقم هذا للبائع، ويرجعلك مفتاح التفعيل.</div>
        <div className="row">
          <b className="num" dir="ltr" style={{ fontSize: "1.6rem", letterSpacing: 2 }}>{l.machineId}</b>
          <button onClick={() => navigator.clipboard?.writeText(l.machineId).then(() => setCopied(true)).catch(() => undefined)}>{copied ? "تم النسخ ✓" : "نسخ"}</button>
          <a className="button" href={wa(ask)} target="_blank" rel="noopener">ابعته على الواتساب</a>
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>2. الصق مفتاح التفعيل</h3>
        {!l.canActivate && <div className="error">هذه النسخة من البرنامج ما تقدرش تتحقق من المفاتيح. حمّل آخر نسخة من البرنامج.</div>}
        <textarea dir="ltr" rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder="S7L1...." style={{ fontFamily: "monospace" }} />
        <button className="primary" disabled={busy || key.trim().length < 20 || !l.canActivate} onClick={activate}>{busy ? "جاري التفعيل…" : "تفعيل"}</button>
        <div className="muted small">التفعيل ما يحتاجش نت. لو الجهاز متصل، التجديد يوصل وحده لما البائع يصدره.</div>
      </div>
    </div>
  );
}
