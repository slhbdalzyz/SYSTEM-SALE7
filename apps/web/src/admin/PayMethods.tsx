import { useEffect, useState } from "react";
import { METHOD_LABELS, OTHER_METHODS, readShopSettings, type PayMethod } from "@pos/shared";
import type { Call } from "./Admin";
import { bankLabel, useBanks } from "./banks";

const ACCOUNT: Record<PayMethod["account"], string> = { card: "بطاقة (نقاط البيع)", transfer: "تحويل مصرفي" };
const newId = () => Math.random().toString(36).slice(2, 10).padEnd(6, "0");

/**
 * The shop's ways of paying: switch off the built-in ones it does not take, and add its own
 * (a new wallet, another bank's card) with the treasury account the money goes into.
 */
export function PayMethodsCard({ call }: { call: Call }) {
  const [list, setList] = useState<PayMethod[] | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ name: string; account: PayMethod["account"] }>({ name: "", account: "card" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const banks = useBanks(call);

  useEffect(() => {
    call<{ settings: unknown }>("/settings").then((r) => {
      const s = readShopSettings(r.settings);
      setList(s.payMethods);
      setHidden(s.hiddenMethods);
    }).catch((e) => setError((e as Error).message));
  }, [call]);

  async function save(payMethods: PayMethod[], hiddenMethods: string[]) {
    setError(null);
    setSaved(false);
    try {
      const r = await call<{ payMethods: PayMethod[]; hiddenMethods: string[] }>("/settings/pay-methods", { method: "PATCH", body: { payMethods, hiddenMethods } });
      setList(r.payMethods);
      setHidden(r.hiddenMethods);
      setSaved(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  if (!list) return error ? <div className="error">{error}</div> : null;
  const add = async () => {
    const name = draft.name.trim();
    if (!name) return;
    if (await save([...list, { id: newId(), name, account: draft.account, active: true }], hidden)) setDraft({ name: "", account: "card" });
  };
  const change = (id: string, patch: Partial<PayMethod>) => void save(list.map((m) => (m.id === id ? { ...m, ...patch } : m)), hidden);

  return (
    <section className="card stack">
      <b>💳 طرق الدفع</b>
      <small className="muted">الكاش والآجل دايماً موجودين. شيل العلامة على أي طريقة ما تتعاملش بيها، وضيف أي محفظة أو مصرف جديد. الطريقة الجديدة يطلع زرها في الكاشير طول، وفلوسها تنحسب في الخزينة مع البطاقة أو التحويل، وتطلع باسمها في الفاتورة والتقارير.</small>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        {OTHER_METHODS.map((m) => (
          <label key={m} className="check">
            <input type="checkbox" checked={!hidden.includes(m)}
              onChange={(e) => void save(list, e.target.checked ? hidden.filter((h) => h !== m) : [...hidden, m])} />
            {METHOD_LABELS[m]}
          </label>
        ))}
      </div>
      {list.length > 0 && (
        <table>
          <thead><tr><th>طريقة المحل</th><th>تنحسب في الخزينة كـ</th>{banks.length > 0 && <th>فلوسها تنزل في</th>}<th>الحالة</th><th /></tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b></td>
                <td>
                  <select value={m.account} onChange={(e) => change(m.id, { account: e.target.value as PayMethod["account"] })}>
                    {(Object.keys(ACCOUNT) as PayMethod["account"][]).map((a) => <option key={a} value={a}>{ACCOUNT[a]}</option>)}
                  </select>
                </td>
                {banks.length > 0 && (
                  <td>
                    <select value={m.bankId ?? ""} onChange={(e) => change(m.id, { bankId: e.target.value || null })}>
                      <option value="">الحساب الرئيسي</option>
                      {banks.map((b) => <option key={b.id} value={b.id}>🏦 {bankLabel(b)}</option>)}
                    </select>
                  </td>
                )}
                <td>{m.active ? <span className="badge ok">في الكاشير</span> : <span className="badge off">موقوفة</span>}</td>
                <td className="row">
                  <button onClick={() => change(m.id, { active: !m.active })}>{m.active ? "إيقاف" : "تشغيل"}</button>
                  <button className="danger" onClick={() => void save(list.filter((x) => x.id !== m.id), hidden)} title="الفواتير القديمة تقعد بنفس الاسم">حذف</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ flex: 1, minWidth: 180 }}>اسم الطريقة الجديدة
          <input value={draft.name} maxLength={40} placeholder="مثلاً: محفظة …، بطاقة مصرف …" onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void add()} />
        </label>
        <label>تنحسب كـ
          <select value={draft.account} onChange={(e) => setDraft({ ...draft, account: e.target.value as PayMethod["account"] })}>
            {(Object.keys(ACCOUNT) as PayMethod["account"][]).map((a) => <option key={a} value={a}>{ACCOUNT[a]}</option>)}
          </select>
        </label>
        <button className="primary" disabled={!draft.name.trim()} onClick={() => void add()}>➕ إضافة</button>
      </div>
      {error && <div className="error">{error}</div>}
      {saved && !error && <small className="muted">✓ انحفظ. الكاشير ياخذ التغيير أول ما يدخل الكاشير من جديد.</small>}
    </section>
  );
}
