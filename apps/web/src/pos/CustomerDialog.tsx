import { useEffect, useState } from "react";
import { creditRoom, formatMoney, toMinor, type CatalogCustomer } from "@pos/shared";
import { api } from "../api";
import { db } from "../localdb";
import { session } from "../session";
import { Modal } from "./dialogs";

/** Pick the customer for this sale, add a new one, or take a payment on their balance. */
export function CustomerDialog({ current, shiftId, onPick, onClose, onPaid }: {
  current: CatalogCustomer | null;
  shiftId: string | null;
  onPick: (c: CatalogCustomer | null) => void;
  onClose: () => void;
  onPaid: (c: CatalogCustomer, amountMinor: number, method: "cash" | "card") => void;
}) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<CatalogCustomer[]>([]);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<CatalogCustomer | null>(null);
  const [f, setF] = useState({ name: "", phone: "" });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = q.trim();
    void db.customers
      .filter((c) => c.active && (!s || c.name.includes(s) || (c.phone ?? "").includes(s)))
      .limit(30)
      .toArray()
      .then(setList);
  }, [q]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const c = await api<CatalogCustomer>("/customers", { token: session.staffToken, body: { name: f.name, phone: f.phone || null } });
      await db.customers.put(c);
      onPick(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!paying) return;
    const m = toMinor(Number(amount.replace(",", ".")) || 0);
    if (m <= 0) return setError("المبلغ غير صحيح");
    setBusy(true);
    setError(null);
    try {
      const c = await api<CatalogCustomer>(`/customers/${paying.id}/payments`, {
        token: session.staffToken,
        body: { id: crypto.randomUUID(), method, amountMinor: m, shiftId },
      });
      await db.customers.put(c);
      onPaid(c, m, method);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (paying) {
    return (
      <Modal title={`تسديد: ${paying.name}`} onClose={onClose}>
        <div className="row"><span>الرصيد الحالي</span><span className="spacer" /><b className="num">{formatMoney(paying.balanceMinor)}</b></div>
        <label>المبلغ (د.ل)<input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && pay()} /></label>
        <div className="tabs">
          <button className={method === "cash" ? "active" : ""} onClick={() => setMethod("cash")}>كاش</button>
          <button className={method === "card" ? "active" : ""} onClick={() => setMethod("card")}>بطاقة</button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row"><span className="spacer" /><button onClick={() => setPaying(null)}>رجوع</button><button className="primary" disabled={busy} onClick={pay}>تسجيل التسديد</button></div>
      </Modal>
    );
  }

  return (
    <Modal title="العميل" onClose={onClose}>
      {adding ? (
        <>
          <label>الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
          <label>الهاتف<input className="num" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <p className="muted" style={{ margin: 0 }}>العميل الجديد ما عندهش آجل لين المدير يحددله حد.</p>
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setAdding(false)}>رجوع</button><button className="primary" disabled={busy || f.name.length < 2} onClick={add}>حفظ واختيار</button></div>
        </>
      ) : (
        <>
          <input placeholder="بحث بالاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="stack" style={{ gap: 6 }}>
            {list.map((c) => {
              const room = creditRoom(c);
              return (
                <div key={c.id} className="row" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 6 }}>
                  <div>
                    <b>{c.name}</b> <span className="muted num">{c.phone}</span>
                    <div className="muted">
                      الرصيد <span className="num">{formatMoney(c.balanceMinor)}</span>
                      {" · "}
                      {room === null ? "آجل بدون حد" : room === 0 && c.creditLimitMinor === 0 ? "بدون آجل" : <>متاح <span className="num">{formatMoney(room)}</span></>}
                    </div>
                  </div>
                  <span className="spacer" />
                  {c.balanceMinor > 0 && <button onClick={() => { setPaying(c); setAmount(String(c.balanceMinor / 1000)); }}>تسديد</button>}
                  <button className="primary" onClick={() => onPick(c)}>اختيار</button>
                </div>
              );
            })}
            {list.length === 0 && <span className="muted">ما فيش عملاء بهذا الاسم</span>}
          </div>
          <div className="row">
            <button onClick={() => { setAdding(true); setF({ name: /^\d/.test(q) ? "" : q, phone: /^\d/.test(q) ? q : "" }); }}>+ عميل جديد</button>
            <span className="spacer" />
            {current && <button className="danger" onClick={() => onPick(null)}>إزالة العميل من الفاتورة</button>}
          </div>
        </>
      )}
    </Modal>
  );
}
