import { useEffect, useState } from "react";
import { formatMoney, formatQty, toMinor, type RefundMethod } from "@pos/shared";
import { api } from "../api";
import { getMeta } from "../localdb";
import { session, tokenClaims } from "../session";
import { Modal } from "./dialogs";

interface LookupLine {
  id: string;
  name: string;
  qty_milli: number;
  returned_milli: number;
  price_minor: number;
  total_minor: number;
}
interface Lookup {
  id: string;
  number: string;
  created_at: string;
  total_minor: number;
  customer_id: string | null;
  customer_name: string | null;
  cashier: string;
  lines: LookupLine[];
}
export interface ReturnDone {
  number: string;
  originalNumber: string;
  customerName: string | null;
  method: RefundMethod;
  totalMinor: number;
  reason: string;
  lines: { name: string; qtyMilli: number; totalMinor: number }[];
}

const METHODS: Record<RefundMethod, string> = { cash: "كاش من الدرج", card: "على البطاقة", credit: "يخصم من حساب العميل" };

export function ReturnDialog({ shiftId, newNumber, onDone, onClose }: {
  shiftId: string | null;
  newNumber: () => Promise<string>;
  onDone: (r: ReturnDone) => void;
  onClose: () => void;
}) {
  const [number, setNumber] = useState("");
  const [sale, setSale] = useState<Lookup | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<RefundMethod>("cash");
  const [reason, setReason] = useState("");
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [approver, setApprover] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCashier = tokenClaims(session.staffToken)?.role === "cashier";

  useEffect(() => {
    void getMeta<{ id: string; name: string; role: string }[]>("staff").then((s) => setManagers((s ?? []).filter((u) => u.role !== "cashier")));
  }, []);

  async function find() {
    setError(null);
    setBusy(true);
    try {
      const s = await api<Lookup>(`/sales/lookup?number=${encodeURIComponent(number.trim())}`, { token: session.staffToken });
      setSale(s);
      setQty({});
      setMethod(s.customer_id ? "credit" : "cash");
    } catch (e) {
      setError((e as { status?: number }).status === 0 ? "المرتجع يحتاج اتصال بالسيرفر" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = (sale?.lines ?? [])
    .map((l) => ({ l, milli: toMinor(Number((qty[l.id] ?? "0").replace(",", ".")) || 0) }))
    .filter((x) => x.milli > 0);
  const tooMuch = chosen.some((x) => x.milli > x.l.qty_milli - x.l.returned_milli);

  async function submit() {
    if (!sale) return;
    setError(null);
    setBusy(true);
    try {
      const returnNumber = await newNumber();
      const r = await api<{ status: string; totalMinor: number; lines: { name: string; qtyMilli: number; totalMinor: number }[] }>("/returns", {
        token: session.staffToken,
        body: {
          id: crypto.randomUUID(),
          number: returnNumber,
          originalSaleId: sale.id,
          shiftId,
          lines: chosen.map((x) => ({ saleLineId: x.l.id, qtyMilli: x.milli })),
          refundMethod: method,
          reason,
          approval: isCashier ? { userId: approver, pin } : undefined,
        },
      });
      onDone({ number: returnNumber, originalNumber: sale.number, customerName: sale.customer_name, method, totalMinor: r.totalMinor, reason, lines: r.lines });
    } catch (e) {
      setError((e as { status?: number }).status === 0 ? "المرتجع يحتاج اتصال بالسيرفر" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="مرتجع" onClose={onClose}>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input className="num" placeholder="رقم الفاتورة مثل P1-000123" value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} autoFocus />
        <button onClick={find} disabled={busy || !number.trim()}>بحث</button>
      </div>
      {sale && (
        <>
          <div className="muted">
            فاتورة <span className="num">{sale.number}</span> · <span className="num">{new Date(sale.created_at).toLocaleString("en-GB")}</span> · {sale.cashier}
            {sale.customer_name && <> · العميل: {sale.customer_name}</>}
          </div>
          <table>
            <thead><tr><th>الصنف</th><th>المباع</th><th>رجع قبل</th><th>يرجع الآن</th></tr></thead>
            <tbody>
              {sale.lines.map((l) => {
                const left = l.qty_milli - l.returned_milli;
                const weighted = l.qty_milli % 1000 !== 0;
                return (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="num">{formatQty(l.qty_milli, weighted)}</td>
                    <td className="num">{l.returned_milli ? formatQty(l.returned_milli, weighted) : "—"}</td>
                    <td className="row" style={{ flexWrap: "nowrap" }}>
                      <input className="num" style={{ width: 80 }} disabled={left <= 0} value={qty[l.id] ?? ""} placeholder="0" onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} />
                      <button disabled={left <= 0} onClick={() => setQty({ ...qty, [l.id]: String(left / 1000) })}>الكل</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label>طريقة الإرجاع
            <select value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
              {(Object.keys(METHODS) as RefundMethod[]).filter((m) => m !== "credit" || sale.customer_id).map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
            </select>
          </label>
          <label>السبب<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="منتهي، مكسور، غلط في الصنف…" /></label>
          {isCashier && (
            <div className="row" style={{ alignItems: "end" }}>
              <label style={{ flex: 1 }}>موافقة المدير
                <select value={approver} onChange={(e) => setApprover(e.target.value)}>
                  <option value="">—</option>
                  {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <label style={{ width: 140 }}>الرقم السري<input type="password" className="num" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label>
            </div>
          )}
          {tooMuch && <div className="error">الكمية أكبر من المتبقي</div>}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <span className="muted">المبلغ تقريباً: <span className="num">{formatMoney(chosen.reduce((a, x) => a + Math.round((x.l.total_minor * x.milli) / x.l.qty_milli), 0))}</span></span>
            <span className="spacer" />
            <button onClick={onClose}>إلغاء</button>
            <button className="primary" disabled={busy || !chosen.length || tooMuch || reason.length < 2 || (isCashier && (!approver || pin.length < 4))} onClick={submit}>تأكيد المرتجع</button>
          </div>
        </>
      )}
      {!sale && error && <div className="error">{error}</div>}
    </Modal>
  );
}
