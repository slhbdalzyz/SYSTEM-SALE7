import { useEffect, useState, type FormEvent } from "react";
import { formatMoney, toMinor } from "@pos/shared";
import type { Call } from "./Admin";

interface Row { id: string; category: string; amount_minor: number; note: string | null; spent_on: string; store_name: string; user_name: string | null }
interface List { expenses: Row[]; byCategory: Record<string, number>; totalMinor: number }

const CATEGORIES = ["إيجار", "كهرباء", "رواتب", "نقل", "صيانة", "أكياس وتغليف", "أخرى"];
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());

/** Money that leaves the shop outside of buying stock, so the profit figure tells the truth. */
export function Expenses({ call, storeId, stores }: { call: Call; storeId: string | null; stores: { id: string; name: string }[] }) {
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [list, setList] = useState<List | null>(null);
  const [f, setF] = useState({ category: CATEGORIES[0], amount: "", note: "", spentOn: today(), storeId: storeId ?? stores[0]?.id ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    call<List>(`/expenses?month=${month}${storeId ? `&storeId=${storeId}` : ""}`).then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), [month, storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/expenses", { body: { storeId: storeId ?? f.storeId, category: f.category.trim(), amountMinor: toMinor(Number(f.amount)), note: f.note || undefined, spentOn: f.spentOn } });
      setF({ ...f, amount: "", note: "" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Row) {
    if (!confirm(`نمسحوا مصروف ${r.category} بقيمة ${formatMoney(r.amount_minor)}؟`)) return;
    await call(`/expenses/${r.id}/delete`, { method: "POST" }).catch((e) => setError((e as Error).message));
    await load();
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={add}>
        <b>مصروف جديد</b>
        <div className="form-grid">
          <label>النوع
            <input list="expense-categories" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} required maxLength={40} />
            <datalist id="expense-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label>المبلغ (د.ل)<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} required placeholder="0.000" /></label>
          <label>التاريخ<input type="date" value={f.spentOn} max={today()} onChange={(e) => setF({ ...f, spentOn: e.target.value })} required /></label>
          {!storeId && stores.length > 1 && (
            <label>الفرع
              <select value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </label>
          )}
          <label style={{ gridColumn: "1 / -1" }}>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} placeholder="اختياري" /></label>
        </div>
        <button className="primary" disabled={busy || !(Number(f.amount) > 0)}>إضافة</button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="card stack">
        <div className="row">
          <b>مصروفات الشهر</b>
          <span className="spacer" />
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: "auto" }} aria-label="الشهر" />
        </div>
        {list && (
          <>
            <div className="row">
              <span className="muted">المجموع</span>
              <b className="num">{formatMoney(list.totalMinor)}</b>
            </div>
            {Object.keys(list.byCategory).length > 0 && (
              <div className="chips">
                {Object.entries(list.byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
                  <span key={c} className="chip">{c} <b className="num">{formatMoney(n)}</b></span>
                ))}
              </div>
            )}
            {list.expenses.length === 0 && <span className="muted">ما فيش مصروفات في الشهر هذا</span>}
            <div className="list">
              {list.expenses.map((r) => (
                <div key={r.id} className="list-row">
                  <div>
                    <b>{r.category}</b>
                    <div className="muted small">
                      <span className="num">{r.spent_on}</span>
                      {stores.length > 1 && !storeId ? ` · ${r.store_name}` : ""}
                      {r.note ? ` · ${r.note}` : ""}
                    </div>
                  </div>
                  <b className="num">{formatMoney(r.amount_minor)}</b>
                  <button className="danger small-btn" onClick={() => remove(r)} aria-label="مسح">✕</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
