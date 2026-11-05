import { useEffect, useState } from "react";
import { PAYROLL_KINDS, ROLE_NAMES, dayRate, formatMoney, lateAmount, toMinor, type PayrollKind } from "@pos/shared";
import type { Call } from "./Admin";
import { KIND_ICON, entryText, monthName, type PayEntry } from "./MyPay";

interface SheetRow {
  user: { id: string; name: string; role: string; job_title: string | null; salary_minor: number; day_minutes: number; active: boolean };
  salaryMinor: number; additionsMinor: number; deductionsMinor: number; netMinor: number; paidMinor: number; remainingMinor: number; takenMinor: number;
  byKind: Partial<Record<PayrollKind, number>>;
  paidLeaveDays: number; unpaidLeaveDays: number; absenceDays: number; lateMinutes: number;
}
interface Month { month: string; sheets: SheetRow[]; totals: { salaryMinor: number; netMinor: number; paidMinor: number; remainingMinor: number; deductionsMinor: number; additionsMinor: number } }

const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date()).slice(0, 7);

/** The owner's (or the accountant's) payroll: everyone's month, and each person's sheet. */
export function Payroll({ call, storeId }: { call: Call; storeId: string }) {
  const [month, setMonth] = useState(thisMonth);
  const [d, setD] = useState<Month | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<Month>(`/payroll?month=${month}`).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), [month]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="error">{error}</div>;
  if (!d) return <div className="muted">جاري التحميل…</div>;
  if (open) return <Sheet call={call} storeId={storeId} userId={open} month={month} onBack={() => { setOpen(null); void load(); }} />;

  return (
    <div className="stack">
      <div className="row">
        <label style={{ maxWidth: 220 }}>الشهر<input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <span className="spacer" />
        <span className="muted">مشتريات الموظفين من الكاشير تنخصم تلقائيا لما تختار «موظف: يخصم من راتبه» عند الدفع.</span>
      </div>
      <div className="kpis">
        <div className="kpi"><span className="muted">الرواتب الأساسية</span><b className="num">{formatMoney(d.totals.salaryMinor)}</b></div>
        <div className="kpi"><span className="muted">الخصومات والمسحوبات</span><b className="num bad">−{formatMoney(d.totals.deductionsMinor)}</b><small className="muted">إضافات +{formatMoney(d.totals.additionsMinor)}</small></div>
        <div className="kpi"><span className="muted">صرفنا</span><b className="num">{formatMoney(d.totals.paidMinor)}</b></div>
        <div className="kpi hero"><span>باقي علينا للموظفين</span><b className="num">{formatMoney(d.totals.remainingMinor)}</b><small>{monthName(d.month)}</small></div>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>الموظف</th><th>الراتب</th><th>إضافات</th><th>خصومات ومسحوبات</th><th>الصافي</th><th>صرفنا</th><th>المتبقي</th><th /></tr></thead>
          <tbody>
            {d.sheets.map((s) => (
              <tr key={s.user.id} onClick={() => setOpen(s.user.id)} style={{ cursor: "pointer" }}>
                <td><b>{s.user.name}</b><div className="muted">{s.user.job_title || ROLE_NAMES[s.user.role as keyof typeof ROLE_NAMES]}{!s.user.active && " · موقوف"}</div></td>
                <td className="num">{s.salaryMinor ? formatMoney(s.salaryMinor) : <span className="muted">بدون راتب</span>}</td>
                <td className="num ok">{s.additionsMinor ? `+${formatMoney(s.additionsMinor)}` : "—"}</td>
                <td className="num bad">{s.deductionsMinor ? `−${formatMoney(s.deductionsMinor)}` : "—"}</td>
                <td className="num"><b>{formatMoney(s.netMinor)}</b></td>
                <td className="num">{formatMoney(s.paidMinor)}</td>
                <td><span className={`badge ${s.remainingMinor > 0 ? "off" : s.remainingMinor < 0 ? "bad" : "ok"}`}><span className="num">{formatMoney(s.remainingMinor)}</span></span></td>
                <td><button className="ghost">التفاصيل ←</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.sheets.every((s) => !s.salaryMinor) && <div className="notice">حدد راتب كل موظف من صفحة «الموظفين والصلاحيات» (زر تعديل).</div>}
      </div>
    </div>
  );
}

const FORM_KINDS: PayrollKind[] = ["late", "absence", "paid_leave", "unpaid_leave", "bonus", "deduction", "advance", "payment"];

function Sheet({ call, storeId, userId, month, onBack }: { call: Call; storeId: string; userId: string; month: string; onBack: () => void }) {
  const [s, setS] = useState<(SheetRow & { entries: PayEntry[] }) | null>(null);
  const [kind, setKind] = useState<PayrollKind>("late");
  const [f, setF] = useState({ amount: "", days: "1", minutes: "15", date: "", note: "", fromCash: true, method: "cash" });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => call<SheetRow & { entries: PayEntry[] }>(`/payroll/${userId}?month=${month}`).then(setS);
  useEffect(() => void load(), [userId, month]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="muted">جاري التحميل…</div>;

  const byDays = kind === "absence" || kind === "unpaid_leave" || kind === "paid_leave";
  const byAmount = kind === "bonus" || kind === "deduction" || kind === "advance" || kind === "payment";
  const cash = kind === "advance" || kind === "payment";
  const suggested = kind === "late" ? lateAmount(s.salaryMinor, Number(f.minutes) || 0, s.user.day_minutes) : kind === "paid_leave" ? 0 : byDays ? dayRate(s.salaryMinor) * (Number(f.days) || 0) : null;
  const goods = (s.byKind.purchase ?? 0) - (s.byKind.return ?? 0);

  async function add(k = kind, amountMinor?: number) {
    setMsg(null);
    try {
      await call("/payroll/entries", {
        body: {
          userId, month, kind: k,
          amountMinor: amountMinor ?? (f.amount ? toMinor(Number(f.amount.replace(",", "."))) : undefined),
          days: byDays && k === kind ? Number(f.days) : undefined,
          minutes: k === "late" ? Number(f.minutes) : undefined,
          onDate: f.date || undefined,
          note: f.note || undefined,
          storeId: (k === "advance" || k === "payment") && f.fromCash ? storeId : undefined,
          method: k === "advance" || k === "payment" ? f.method : undefined,
        },
      });
      setF({ ...f, amount: "", note: "" });
      setMsg({ text: `تم: ${PAYROLL_KINDS[k].label}` });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function remove(e: PayEntry) {
    if (!confirm(`نلغي «${PAYROLL_KINDS[e.kind].label}» ${e.amount_minor ? formatMoney(e.amount_minor) : ""}؟`)) return;
    try {
      await call(`/payroll/entries/${e.id}/delete`, { method: "POST" });
      await load();
    } catch (x) {
      setMsg({ text: (x as Error).message, bad: true });
    }
  }

  return (
    <div className="stack">
      <div className="hello">
        <button className="ghost" onClick={onBack}>→ رجوع</button>
        <div>
          <h2>{s.user.name}</h2>
          <span className="muted">{s.user.job_title || ROLE_NAMES[s.user.role as keyof typeof ROLE_NAMES]} · {monthName(month)}</span>
        </div>
        <span className="spacer" />
        {s.remainingMinor > 0 && <button className="primary" onClick={() => confirm(`نصرف المتبقي ${formatMoney(s.remainingMinor)} لـ ${s.user.name}؟`) && void add("payment", s.remainingMinor)}>✅ صرف المتبقي {formatMoney(s.remainingMinor)}</button>}
      </div>

      <div className="kpis">
        <div className="kpi"><span className="muted">الراتب</span><b className="num">{formatMoney(s.salaryMinor)}</b></div>
        <div className="kpi"><span className="muted">إضافات</span><b className="num ok">+{formatMoney(s.additionsMinor)}</b></div>
        <div className="kpi"><span className="muted">خصومات ومسحوبات</span><b className="num bad">−{formatMoney(s.deductionsMinor)}</b><small className="muted">مشتريات {formatMoney(goods)} · سلف {formatMoney(s.byKind.advance ?? 0)}</small></div>
        <div className="kpi"><span className="muted">صرفنا</span><b className="num">{formatMoney(s.paidMinor)}</b><small className="muted">الصافي {formatMoney(s.netMinor)}</small></div>
        <div className="kpi hero"><span>المتبقي</span><b className="num">{formatMoney(s.remainingMinor)}</b><small>إجازة {s.paidLeaveDays} · بدون راتب {s.unpaidLeaveDays} · غياب {s.absenceDays} · تأخير {s.lateMinutes} د</small></div>
      </div>

      <div className="card stack">
        <b>إضافة حركة</b>
        <div className="seg wrap">
          {FORM_KINDS.map((k) => <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>{KIND_ICON[k]} {PAYROLL_KINDS[k].label}</button>)}
        </div>
        <div className="row" style={{ alignItems: "end" }}>
          {kind === "late" && <label style={{ maxWidth: 140 }}>دقائق التأخير<input className="num" inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value.replace(/\D/g, "") })} /></label>}
          {byDays && <label style={{ maxWidth: 140 }}>عدد الأيام<input className="num" inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value.replace(/\D/g, "") })} /></label>}
          {kind !== "paid_leave" && (
            <label style={{ maxWidth: 180 }}>المبلغ (د.ل)
              <input className="num" inputMode="decimal" value={f.amount} placeholder={suggested !== null ? String(suggested / 1000) : ""} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </label>
          )}
          <label style={{ maxWidth: 170 }}>التاريخ<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label style={{ flex: 1 }}>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={kind === "deduction" ? "سبب الخصم" : ""} /></label>
          <button className="primary" disabled={(byAmount && !f.amount) || (byDays && !Number(f.days)) || (kind === "late" && !Number(f.minutes))} onClick={() => void add()}>إضافة</button>
        </div>
        {suggested !== null && !f.amount && kind !== "paid_leave" && <small className="muted">محسوب من الراتب: {formatMoney(suggested)} (يوم = راتب ÷ 30، ويوم العمل {s.user.day_minutes / 60} ساعات). تقدر تكتب مبلغ ثاني.</small>}
        {kind === "paid_leave" && <small className="muted">الإجازة براتب تنحسب أيامها بدون أي خصم.</small>}
        {cash && (
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={f.fromCash} onChange={(e) => setF({ ...f, fromCash: e.target.checked })} /> تتسجل في المصروفات والخزينة</label>
            {f.fromCash && (
              <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} style={{ width: "auto" }} aria-label="طريقة الصرف">
                <option value="cash">💵 نقدي</option>
                <option value="card">💳 بطاقة مصرفية</option>
                <option value="transfer">🏦 تحويل مصرفي</option>
              </select>
            )}
          </div>
        )}
        {msg && <div className={msg.bad ? "error" : "notice"}>{msg.text}</div>}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>التاريخ</th><th>الحركة</th><th>ملاحظة</th><th>المبلغ</th><th>بواسطة</th><th /></tr></thead>
          <tbody>
            {s.entries.length === 0 && <tr><td colSpan={6} className="muted">ما فيش حركات في الشهر هذا.</td></tr>}
            {s.entries.map((e) => {
              const t = entryText(e);
              return (
                <tr key={e.id}>
                  <td className="num">{e.on_date.split("-").reverse().join("/")}</td>
                  <td>{KIND_ICON[e.kind]} {t.label}{t.detail && <span className="muted"> · {t.detail}</span>}</td>
                  <td className="muted">{e.note}</td>
                  <td className={`num ${t.tone}`}>{e.amount_minor ? `${t.sign}${formatMoney(e.amount_minor)}` : "—"}</td>
                  <td className="muted">{e.created_by}</td>
                  <td>{e.sale_number ? <span className="muted">من الكاشير</span> : <button className="ghost danger" onClick={() => void remove(e)}>إلغاء</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
