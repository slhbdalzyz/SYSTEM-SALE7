import { useEffect, useRef, useState, type ReactNode } from "react";
import { creditRoom, formatMoney, toMinor, type CatalogCustomer, type PaymentMethod } from "@pos/shared";
import { readScaleWeight, scaleSupported } from "../scale";

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Asks for a number in major units (LYD or kg) and returns it in thousandths. */
export function AmountDialog({ title, label, initial = "", onDone, onClose, scale }: {
  title: string; label: string; initial?: string; onDone: (milli: number) => void; onClose: () => void; scale?: boolean;
}) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  function ok() {
    const n = Number(v.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return setErr("رقم غير صحيح");
    onDone(toMinor(n));
  }
  async function fromScale() {
    try {
      const grams = await readScaleWeight();
      setV((grams / 1000).toFixed(3));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <label>
        {label}
        <input ref={ref} className="num" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} autoFocus />
      </label>
      {err && <div className="error">{err}</div>}
      <div className="row">
        {scale && scaleSupported() && <button onClick={fromScale}>قراءة من الميزان</button>}
        <span className="spacer" />
        <button onClick={onClose}>إلغاء</button>
        <button className="primary" onClick={ok}>تم</button>
      </div>
    </Modal>
  );
}

export function PayDialog({ totalMinor, customer, onPay, onClose }: {
  totalMinor: number; customer: CatalogCustomer | null; onPay: (p: { method: PaymentMethod; amountMinor: number }[]) => void; onClose: () => void;
}) {
  const [cash, setCash] = useState(String(totalMinor / 1000));
  const [card, setCard] = useState("0");
  const [credit, setCredit] = useState("0");
  const num = (v: string) => toMinor(Number(v.replace(",", ".")) || 0);
  const cashM = num(cash);
  const cardM = num(card);
  const creditM = customer ? num(credit) : 0;
  const room = customer ? creditRoom(customer) : 0;
  const paid = cashM + cardM + creditM;
  const change = paid - totalMinor;
  const overLimit = creditM > 0 && room !== null && creditM > room;
  const valid = paid >= totalMinor && change <= cashM && cardM + creditM <= totalMinor && !overLimit;
  const quick = [totalMinor, ...[5000, 10000, 20000, 50000].filter((n) => n > totalMinor).slice(0, 3)];

  function pay() {
    if (!valid) return;
    const p: { method: PaymentMethod; amountMinor: number }[] = [];
    if (cashM > 0) p.push({ method: "cash", amountMinor: cashM });
    if (cardM > 0) p.push({ method: "card", amountMinor: cardM });
    if (creditM > 0) p.push({ method: "credit", amountMinor: creditM });
    if (!p.length) p.push({ method: "cash", amountMinor: 0 });
    onPay(p);
  }

  return (
    <Modal title="الدفع" onClose={onClose}>
      <div className="totals" style={{ border: 0, padding: 0 }}>
        <div className="grand num">{formatMoney(totalMinor)}</div>
      </div>
      <label>
        كاش
        <input className="num" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} onKeyDown={(e) => e.key === "Enter" && pay()} autoFocus onFocus={(e) => e.target.select()} />
      </label>
      <div className="row">
        {quick.map((q) => (
          <button key={q} onClick={() => setCash(String(q / 1000))} className="num">{formatMoney(q)}</button>
        ))}
      </div>
      <label>
        بطاقة
        <input className="num" inputMode="decimal" value={card} onChange={(e) => setCard(e.target.value)} onFocus={(e) => e.target.select()} />
      </label>
      {customer && (
        <label>
          آجل على {customer.name}
          <span className="muted"> (متاح {room === null ? "بدون حد" : formatMoney(room)})</span>
          <input className="num" inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
      )}
      <div className="row">
        <button onClick={() => { setCard(String(totalMinor / 1000)); setCash("0"); setCredit("0"); }}>الكل بطاقة</button>
        {customer && room !== 0 && <button onClick={() => { setCredit(String(totalMinor / 1000)); setCash("0"); setCard("0"); }}>الكل آجل</button>}
        <span className="spacer" />
        <span>الباقي:</span>
        <b className="num" style={{ fontSize: "1.4rem", color: change >= 0 ? "var(--ok)" : "var(--danger)" }}>{formatMoney(Math.max(change, 0))}</b>
      </div>
      {!valid && <div className="error">{overLimit ? "الآجل أكبر من المتاح للعميل" : paid < totalMinor ? "المبلغ ناقص" : "الباقي يكون من الكاش بس"}</div>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>رجوع</button>
        <button className="primary big" disabled={!valid} onClick={pay}>تأكيد وطباعة</button>
      </div>
    </Modal>
  );
}
