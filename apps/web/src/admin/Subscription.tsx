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

export function Subscription({ call }: { call: Call }) {
  const [s, setS] = useState<Sub | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call<Sub>("/subscription").then(setS).catch((e) => setError((e as Error).message));
    api<Plan[]>("/plans").then(setPlans).catch(() => setPlans([]));
  }, [call]);
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const notice = subNotice(s);
  return (
    <div className="stack">
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
