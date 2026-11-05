import { useEffect, useState } from "react";
import { PAYROLL_KINDS, ROLE_NAMES, formatMoney, type PayrollKind } from "@pos/shared";
import { api } from "../api";

export const KIND_ICON: Record<PayrollKind, string> = {
  bonus: "🎁", return: "↩️", purchase: "🛒", advance: "💵", late: "⏰", absence: "🚫", unpaid_leave: "🌙", deduction: "⚠️", paid_leave: "🏖️", payment: "✅",
};

export interface PayEntry {
  id: string; kind: PayrollKind; amount_minor: number; days: number | null; minutes: number | null; on_date: string; note: string | null; sale_number: string | null; created_by: string | null;
}

interface Mine {
  month: string;
  user: { name: string; job_title: string | null; role: string; hired_on: string | null };
  salaryMinor: number; additionsMinor: number; deductionsMinor: number; netMinor: number; paidMinor: number; remainingMinor: number; takenMinor: number;
  byKind: Partial<Record<PayrollKind, number>>;
  paidLeaveDays: number; unpaidLeaveDays: number; absenceDays: number; lateMinutes: number;
  entries: PayEntry[];
  months: { month: string; netMinor: number; paidMinor: number; remainingMinor: number; deductionsMinor: number }[];
}

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** One line of a pay sheet: what it is, and what it does to the salary. */
export function entryText(e: PayEntry) {
  const k = PAYROLL_KINDS[e.kind];
  const detail = e.kind === "late" ? `${e.minutes} دقيقة` : e.days ? `${e.days} ${e.days > 2 && e.days < 11 ? "أيام" : "يوم"}` : "";
  const sign = k.sign > 0 ? "+" : k.sign < 0 ? "−" : "";
  return { label: k.label, detail, sign, tone: k.sign > 0 ? "ok" : k.sign < 0 ? "bad" : e.kind === "payment" ? "info" : "" };
}

/**
 * "My salary": what a member of staff sees about their own pay. Read-only, and the server only
 * ever answers with the signed-in person's own sheet.
 */
export function MyPay({ token }: { token: string | null }) {
  const [month, setMonth] = useState<string | null>(null);
  const [d, setD] = useState<Mine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api<Mine>(`/me/payroll${month ? `?month=${month}` : ""}`, { token }).then(setD).catch((e) => setError((e as Error).message));
  }, [month, token]);
  if (error) return <div className="error">{error}</div>;
  if (!d) return <div className="muted">جاري التحميل…</div>;

  // What the month earned (salary, bonuses, less lateness, absence and penalties), and what of it
  // has already been had: goods taken on the salary, advances and payments.
  const goods = (d.byKind.purchase ?? 0) - (d.byKind.return ?? 0);
  const penalties = d.deductionsMinor - (d.byKind.purchase ?? 0) - (d.byKind.advance ?? 0);
  const earned = d.remainingMinor + d.takenMinor;
  const used = earned > 0 ? Math.min(100, Math.round((d.takenMinor / earned) * 100)) : 0;
  return (
    <div className="stack mypay">
      <div className="hello">
        <div>
          <h2>{d.user.name}</h2>
          <span className="muted">{d.user.job_title || ROLE_NAMES[d.user.role as keyof typeof ROLE_NAMES]}{d.user.hired_on && ` · من ${d.user.hired_on.split("-").reverse().join("/")}`}</span>
        </div>
        <span className="spacer" />
        <select value={d.month} onChange={(e) => setMonth(e.target.value)} aria-label="الشهر" style={{ width: "auto" }}>
          {d.months.map((m) => <option key={m.month} value={m.month}>{monthName(m.month)}</option>)}
        </select>
      </div>

      {d.salaryMinor === 0 && d.entries.length === 0 ? (
        <div className="notice">ما فيش راتب مسجل لك لسه. صاحب المحل يحدده من صفحة الموظفين.</div>
      ) : (
        <>
          <div className="card pay-hero">
            <span>المتبقي من راتبك — {monthName(d.month)}</span>
            <b className={`num ${d.remainingMinor < 0 ? "bad" : ""}`}>{formatMoney(d.remainingMinor)}</b>
            <div className="meter" role="img" aria-label={`استلمت وصرفت ${used}% من صافي الراتب`}>
              <i style={{ width: `${used}%` }} />
            </div>
            <small>مستحق لك {formatMoney(earned)} · أخذت منه {formatMoney(d.takenMinor)} ({used}%)</small>
          </div>

          <div className="kpis">
            <div className="kpi"><span className="muted">الراتب الأساسي</span><b className="num">{formatMoney(d.salaryMinor)}</b></div>
            <div className="kpi"><span className="muted">مكافآت وإضافات</span><b className="num ok">+{formatMoney(d.byKind.bonus ?? 0)}</b></div>
            <div className="kpi"><span className="muted">خصومات (تأخير، غياب، جزاءات)</span><b className="num bad">−{formatMoney(penalties)}</b></div>
            <div className="kpi"><span className="muted">مشترياتك من المحل</span><b className="num">{formatMoney(goods)}</b></div>
            <div className="kpi"><span className="muted">استلمت نقدا</span><b className="num">{formatMoney(d.paidMinor + (d.byKind.advance ?? 0))}</b><small className="muted">منها سلف {formatMoney(d.byKind.advance ?? 0)}</small></div>
          </div>

          <div className="chips">
            <span className="chip">🏖️ إجازة براتب: <b className="num">{d.paidLeaveDays}</b> يوم</span>
            <span className="chip">🌙 بدون راتب: <b className="num">{d.unpaidLeaveDays}</b> يوم</span>
            <span className="chip">🚫 غياب: <b className="num">{d.absenceDays}</b> يوم</span>
            <span className="chip">⏰ تأخير: <b className="num">{d.lateMinutes}</b> دقيقة</span>
          </div>
        </>
      )}

      <div className="grid-2">
        <div className="card panel">
          <div className="panel-head"><b>آخر الحركات</b></div>
          {d.entries.length === 0 ? <div className="muted">ما فيش حركات في الشهر هذا.</div> : (
            <ul className="pay-list">
              {d.entries.map((e) => {
                const t = entryText(e);
                return (
                  <li key={e.id}>
                    <span className="pay-icon">{KIND_ICON[e.kind]}</span>
                    <div>
                      <b>{t.label}</b>{t.detail && <span className="muted"> · {t.detail}</span>}
                      <div className="muted">{e.on_date.split("-").reverse().join("/")}{e.note && ` · ${e.note}`}</div>
                    </div>
                    <b className={`num ${t.tone}`}>{e.amount_minor ? `${t.sign}${formatMoney(e.amount_minor)}` : "—"}</b>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="card panel">
          <div className="panel-head"><b>الشهور</b></div>
          <table>
            <thead><tr><th>الشهر</th><th>الصافي</th><th>استلمت</th><th>المتبقي</th></tr></thead>
            <tbody>
              {d.months.map((m) => (
                <tr key={m.month} className={m.month === d.month ? "sel" : ""} onClick={() => setMonth(m.month)} style={{ cursor: "pointer" }}>
                  <td>{monthName(m.month)}</td>
                  <td className="num">{formatMoney(m.netMinor)}</td>
                  <td className="num">{formatMoney(m.paidMinor)}</td>
                  <td className="num">{formatMoney(m.remainingMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="muted privacy">🔒 الصفحة هذي للعرض فقط، وما يشوفهاش غيرك وصاحب المحل ومن عنده صلاحية الرواتب. لو فيه غلط كلم صاحب المحل.</div>
    </div>
  );
}
