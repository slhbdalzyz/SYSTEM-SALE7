import { useEffect, useState } from "react";
import { formatMoney, toMinor, type CatalogCustomer } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Entry { at: string; type: "sale" | "return" | "payment"; ref: string; amount_minor: number; balance_minor: number }
const TYPE = { sale: "فاتورة آجل", return: "مرتجع", payment: "تسديد" } as const;

export function Customers({ call }: { call: Call }) {
  const [list, setList] = useState<CatalogCustomer[]>([]);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<{ id?: string; name: string; phone: string; limit: string; noLimit: boolean } | null>(null);
  const [statement, setStatement] = useState<{ customer: CatalogCustomer; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => call<CatalogCustomer[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setList);
  useEffect(() => void load(), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalDebt = list.reduce((a, c) => a + Math.max(c.balanceMinor, 0), 0);

  async function save() {
    if (!edit) return;
    setError(null);
    const body = { name: edit.name, phone: edit.phone || null, creditLimitMinor: edit.noLimit ? null : toMinor(Number(edit.limit) || 0) };
    try {
      await call(edit.id ? `/customers/${edit.id}` : "/customers", { method: edit.id ? "PATCH" : "POST", body });
      setEdit(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <input placeholder="بحث بالاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <span className="muted">إجمالي الديون: <b className="num">{formatMoney(totalDebt)}</b></span>
        <span className="spacer" />
        <button className="primary" onClick={() => setEdit({ name: "", phone: "", limit: "0", noLimit: false })}>+ عميل</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>العميل</th><th>الهاتف</th><th>الرصيد</th><th>حد الآجل</th><th /></tr></thead>
          <tbody>
            {list.map((c) => {
              const over = c.creditLimitMinor !== null && c.balanceMinor > c.creditLimitMinor;
              return (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                  <td>{c.name}</td>
                  <td className="num">{c.phone ?? "—"}</td>
                  <td><span className={over ? "badge bad" : ""}><span className="num">{formatMoney(c.balanceMinor)}</span></span></td>
                  <td className="num">{c.creditLimitMinor === null ? "بدون حد" : c.creditLimitMinor === 0 ? "بدون آجل" : formatMoney(c.creditLimitMinor)}</td>
                  <td className="row">
                    <button onClick={async () => setStatement(await call(`/customers/${c.id}/statement`))}>كشف حساب</button>
                    <button onClick={() => setEdit({ id: c.id, name: c.name, phone: c.phone ?? "", limit: String((c.creditLimitMinor ?? 0) / 1000), noLimit: c.creditLimitMinor === null })}>تعديل</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edit && (
        <Modal title={edit.id ? "تعديل عميل" : "عميل جديد"} onClose={() => setEdit(null)}>
          <label>الاسم<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <label>الهاتف<input className="num" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={edit.noLimit} onChange={(e) => setEdit({ ...edit, noLimit: e.target.checked })} />
            آجل بدون حد
          </label>
          {!edit.noLimit && <label>حد الآجل (د.ل) — صفر يعني بدون آجل<input className="num" value={edit.limit} onChange={(e) => setEdit({ ...edit, limit: e.target.value })} /></label>}
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setEdit(null)}>إلغاء</button><button className="primary" disabled={edit.name.length < 2} onClick={save}>حفظ</button></div>
        </Modal>
      )}

      {statement && (
        <Modal title={`كشف حساب: ${statement.customer.name}`} onClose={() => setStatement(null)}>
          <table>
            <thead><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
            <tbody>
              {statement.entries.map((e, i) => (
                <tr key={i}>
                  <td className="num">{new Date(e.at).toLocaleDateString("en-GB")}</td>
                  <td>{TYPE[e.type]} <span className="num muted">{e.type === "payment" ? (e.ref === "cash" ? "كاش" : "بطاقة") : e.ref}</span></td>
                  <td className="num">{formatMoney(e.amount_minor)}</td>
                  <td className="num">{formatMoney(e.balance_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {statement.entries.length === 0 && <span className="muted">ما فيش حركات</span>}
          <div className="row"><b>الرصيد الحالي</b><span className="spacer" /><b className="num">{formatMoney(statement.customer.balanceMinor)}</b></div>
        </Modal>
      )}
    </div>
  );
}
