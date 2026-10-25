import { useEffect, useState } from "react";
import { formatMoney } from "@pos/shared";
import { api } from "../api";
import { METHOD_LABEL, STATE_BADGE, STATE_LABEL, date, type Plan, type SubState } from "../billing";
import type { Call } from "./Admin";

export interface Sub {
  state: SubState;
  reason: string | null;
  paidUntil: string;
  daysLeft: number;
  graceDays: number;
  plan: Plan;
  usage: { stores: number; devices: number; users: number };
  payments: { months: number; amount_minor: number; method: string; period_from: string; period_to: string; created_at: string; plan_code: string }[];
  paymentInstructions: string;
}

/** One line at the top of the admin screens when the bill needs attention. */
export function subNotice(s: Sub): { text: string; bad: boolean } | null {
  if (s.state === "trial" && s.daysLeft <= 5) return { text: `باقيلك ${Math.max(s.daysLeft, 0)} أيام في الفترة التجريبية. اشترك باش ما يتوقفش النظام.`, bad: false };
  if (s.state === "active" && s.daysLeft <= 5) return { text: `الاشتراك ينتهي بعد ${s.daysLeft} أيام.`, bad: false };
  if (s.state === "grace") return { text: `انتهى الاشتراك من ${-s.daysLeft} أيام. جدّد قبل ما يتقفل النظام بعد ${s.graceDays + s.daysLeft} أيام.`, bad: true };
  if (s.state === "locked") return { text: "انتهى الاشتراك والنظام مقفول: الكاشير ما يقدرش يدخل. جدّد الاشتراك.", bad: true };
  if (s.state === "suspended") return { text: `الحساب موقوف${s.reason ? `: ${s.reason}` : ""}.`, bad: true };
  if (s.state === "cancelled") return { text: "الحساب ملغي.", bad: true };
  return null;
}

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row"><span>{label}</span><span className="spacer" /><span className="num">{used} / {max}</span></div>
      <div className="meter"><div style={{ width: `${pct}%`, background: pct >= 100 ? "var(--danger)" : "var(--brand)" }} /></div>
    </div>
  );
}

const RETURN_MSG: Record<string, { text: string; bad: boolean }> = {
  ok: { text: "تم الدفع ✓ اشتراكك تجدد. شكراً!", bad: false },
  canceled: { text: "ألغيت عملية الدفع. ما تخصم منك شي.", bad: true },
  failed: { text: "ما نجحتش عملية الدفع. جرّب مرة ثانية أو بطريقة ثانية.", bad: true },
  invalid: { text: "ما قدرناش نتأكدوا من عملية الدفع. لو انخصم منك مبلغ تواصل معانا.", bad: true },
};

export function Subscription({ call }: { call: Call }) {
  const [s, setS] = useState<Sub | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [back] = useState(() => {
    const r = new URLSearchParams(location.search).get("payment");
    if (r) history.replaceState(null, "", location.pathname);
    return r ? RETURN_MSG[r] ?? null : null;
  });
  const load = () => call<Sub>("/subscription").then(setS).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    api<Plan[]>("/plans").then(setPlans).catch(() => setPlans([]));
  }, [call]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const notice = subNotice(s);
  return (
    <div className="stack">
      {back && <div className={back.bad ? "error" : "badge ok"} style={{ padding: 12 }}>{back.text}</div>}
      {notice && <div className={notice.bad ? "error" : "notice"}>{notice.text}</div>}
      <div className="kpis">
        <div className="kpi"><span className="muted">الحالة</span><b><span className={`badge ${STATE_BADGE[s.state]}`}>{STATE_LABEL[s.state]}</span></b></div>
        <div className="kpi"><span className="muted">الباقة</span><b>{s.plan.name}</b></div>
        <div className="kpi"><span className="muted">{s.state === "trial" ? "تنتهي التجربة" : "مدفوع لين"}</span><b className="num">{date(s.paidUntil)}</b></div>
        <div className="kpi"><span className="muted">السعر الشهري</span><b className="num">{formatMoney(s.plan.price_minor)}</b></div>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>الاستهلاك</h3>
        <Meter label="الفروع" used={s.usage.stores} max={s.plan.max_stores} />
        <Meter label="الأجهزة" used={s.usage.devices} max={s.plan.max_devices} />
        <Meter label="المستخدمين" used={s.usage.users} max={s.plan.max_users} />
      </div>
      <PayOnline call={call} current={s.plan.code} onPaid={load} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>كيف تدفع</h3>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{s.paymentInstructions}</p>
        <div className="plans">
          {plans.map((p) => (
            <div key={p.code} className={`plan ${p.code === s.plan.code ? "current" : ""}`}>
              <b>{p.name}</b>
              <div className="num plan-price">{formatMoney(p.price_minor)}<span className="muted"> / شهر</span></div>
              <div className="muted">{p.max_stores} فرع · {p.max_devices} أجهزة · {p.max_users} مستخدم</div>
              {p.code === s.plan.code && <span className="badge ok">باقتك</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>الدفعات</h3>
        {s.payments.length === 0 ? (
          <p className="muted">ما فيش دفعات لتوا.</p>
        ) : (
          <table>
            <thead><tr><th>التاريخ</th><th>المدة</th><th>الفترة</th><th>الطريقة</th><th>المبلغ</th></tr></thead>
            <tbody>
              {s.payments.map((p, i) => (
                <tr key={i}>
                  <td className="num">{date(p.created_at)}</td>
                  <td>{p.months} شهر</td>
                  <td className="num">{date(p.period_from)} ← {date(p.period_to)}</td>
                  <td>{METHOD_LABEL[p.method] ?? p.method}</td>
                  <td className="num">{formatMoney(p.amount_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

type PayMethod = "localbankcards" | "sadad" | "edfali";
const PAY_LABEL: Record<PayMethod, string> = { localbankcards: "بطاقة مصرفية محلية", sadad: "سداد (المدار)", edfali: "إدفع لي (التجارة والتنمية)" };

/** Paying the subscription from inside the system, when the server has a payment gateway. */
function PayOnline({ call, current, onPaid }: { call: Call; current: string; onPaid: () => void }) {
  const [opts, setOpts] = useState<{ methods: PayMethod[]; test: boolean; plans: { code: string; name: string; price_minor: number }[] } | null>(null);
  const [plan, setPlan] = useState(current);
  const [months, setMonths] = useState(1);
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [mobile, setMobile] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [intent, setIntent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    call<NonNullable<typeof opts>>("/subscription/pay/options")
      .then((o) => {
        setOpts(o);
        setMethod(o.methods[0] ?? null);
      })
      .catch(() => setOpts(null));
  }, [call]);
  if (!opts || !opts.methods.length || !method) return null;
  const price = opts.plans.find((p) => p.code === plan)?.price_minor ?? 0;
  const total = price * months;
  const wallet = method !== "localbankcards";
  const ready = !wallet || (/^09\d{8}$/.test(mobile) && (method !== "sadad" || /^(19|20)\d{2}$/.test(birthYear)));

  async function start() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ id: string; redirectUrl?: string; needsCode?: boolean }>("/subscription/pay/start", {
        body: { planCode: plan, months, method, mobile: wallet ? mobile : undefined, birthYear: method === "sadad" ? birthYear : undefined },
      });
      if (r.redirectUrl) {
        location.href = r.redirectUrl;
        return;
      }
      setIntent(r.id);
      setMsg({ text: "بعتنالك رمز في رسالة على الهاتف. اكتبه هنا." });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setMsg(null);
    try {
      await call(`/subscription/pay/${intent}/confirm`, { body: { code } });
      setIntent(null);
      setCode("");
      setMsg({ text: "تم الدفع ✓ اشتراكك تجدد. شكراً!" });
      onPaid();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>ادفع أونلاين</h3>
        {opts.test && <span className="badge off">تجريبي: ما فيش فلوس حقيقية</span>}
      </div>
      {!intent ? (
        <>
          <div className="row">
            <label>الباقة
              <select value={plan} onChange={(e) => setPlan(e.target.value)} style={{ width: "auto" }}>
                {opts.plans.map((p) => <option key={p.code} value={p.code}>{p.name} · {formatMoney(p.price_minor)}</option>)}
              </select>
            </label>
            <label>المدة
              <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: "auto" }}>
                {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} شهر</option>)}
              </select>
            </label>
            <div className="kpi"><span className="muted">المبلغ</span><b className="num">{formatMoney(total)}</b></div>
          </div>
          <div className="row">
            {opts.methods.map((m) => (
              <label key={m} className="check"><input type="radio" checked={method === m} onChange={() => setMethod(m)} /> {PAY_LABEL[m]}</label>
            ))}
          </div>
          {wallet && (
            <div className="row">
              <label>رقم الهاتف<input className="num" inputMode="numeric" placeholder="09XXXXXXXX" value={mobile} onChange={(e) => setMobile(e.target.value.trim())} style={{ width: 160 }} /></label>
              {method === "sadad" && <label>سنة الميلاد<input className="num" inputMode="numeric" placeholder="1990" value={birthYear} onChange={(e) => setBirthYear(e.target.value.trim())} style={{ width: 100 }} /></label>}
            </div>
          )}
          <div className="row">
            <span className="muted">{wallet ? "يوصلك رمز تأكيد في رسالة." : "تنتقل لصفحة الدفع الآمنة وترجع هنا بعد الدفع."}</span>
            <span className="spacer" />
            <button className="primary" disabled={busy || !ready || !total} onClick={start}>ادفع {formatMoney(total)}</button>
          </div>
        </>
      ) : (
        <div className="row">
          <label>رمز التأكيد<input className="num" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.trim())} autoFocus style={{ width: 140 }} /></label>
          <button className="primary" disabled={busy || code.length < 4} onClick={confirm}>تأكيد الدفع</button>
          <button onClick={() => { setIntent(null); setMsg(null); }}>رجوع</button>
        </div>
      )}
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
    </div>
  );
}
