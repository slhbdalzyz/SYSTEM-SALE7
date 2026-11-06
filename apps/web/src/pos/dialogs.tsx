import { useEffect, useRef, useState, type ReactNode } from "react";
import { METHOD_LABELS, OTHER_METHODS, creditRoom, formatMoney, maxPointsPayment, pointsFor, toMinor, type CatalogCustomer, type LoyaltySettings, type PaymentMethod } from "@pos/shared";
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

export interface Employee { id: string; name: string }

type Other = (typeof OTHER_METHODS)[number] | "credit";

/**
 * Paying: cash with ready banknote buttons (each tap adds that note), any of the Libyan ways of
 * paying for all or part of the bill, or on the customer's account. The change shows big.
 */
export function PayDialog({ totalMinor, customer, employees, rules, onPay, onClose }: {
  totalMinor: number; customer: CatalogCustomer | null; employees: Employee[]; rules?: LoyaltySettings | null;
  onPay: (p: { method: PaymentMethod; amountMinor: number }[], employeeId: string | null) => void; onClose: () => void;
}) {
  const [cash, setCash] = useState(String(totalMinor / 1000));
  /** Until the cashier types or taps a note, the cash box holds the exact amount. */
  const [fresh, setFresh] = useState(true);
  const [others, setOthers] = useState<Partial<Record<Other, string>>>({});
  const [staff, setStaff] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const cashRef = useRef<HTMLInputElement>(null);
  const num = (v: string | undefined) => toMinor(Number((v ?? "").replace(",", ".")) || 0);
  const cashM = num(cash);
  const otherM = (Object.keys(others) as Other[]).reduce((a, k) => a + (k === "credit" && !customer ? 0 : num(others[k])), 0);
  const creditM = customer ? num(others.credit) : 0;
  const room = customer ? creditRoom(customer) : 0;
  const salaryM = staff && employeeId ? totalMinor : 0;
  // Points: the most this customer can pay with what they hold, in whole points.
  const [usePoints, setUsePoints] = useState(false);
  const pointsMax = customer && rules ? maxPointsPayment(rules, customer.points ?? 0, totalMinor) : 0;
  const pointsM = usePoints && !staff ? pointsMax : 0;
  const paid = staff ? salaryM : cashM + otherM + pointsM;
  const change = paid - totalMinor;
  const overLimit = !staff && creditM > 0 && room !== null && creditM > room;
  const valid = staff ? !!employeeId : paid >= totalMinor && change <= cashM && otherM + pointsM <= totalMinor && !overLimit;
  const notes = [5000, 10000, 20000, 50000];
  const choices: Other[] = [...OTHER_METHODS, ...(customer && room !== 0 ? (["credit"] as const) : [])];

  function addNote(n: number) {
    setCash(String(((fresh ? 0 : cashM) + n) / 1000));
    setFresh(false);
    cashRef.current?.focus();
  }

  function useMethod(m: Other) {
    if (others[m] !== undefined) return;
    const rest = Math.max(0, totalMinor - otherM - pointsM - (fresh ? 0 : cashM));
    if (fresh) setCash("0");
    setFresh(false);
    setOthers({ ...others, [m]: String((m === "credit" && room !== null ? Math.min(rest, room) : rest) / 1000) });
  }

  function spendPoints(on: boolean) {
    setUsePoints(on);
    // While the cash box still holds the exact amount, it follows what is left to pay.
    if (fresh) setCash(String(Math.max(0, totalMinor - otherM - (on ? pointsMax : 0)) / 1000));
  }

  function pay() {
    if (!valid) return;
    if (staff) return onPay([{ method: "payroll", amountMinor: totalMinor }], employeeId);
    const p: { method: PaymentMethod; amountMinor: number }[] = [];
    if (cashM > 0) p.push({ method: "cash", amountMinor: cashM });
    for (const k of Object.keys(others) as Other[]) {
      const v = k === "credit" && !customer ? 0 : num(others[k]);
      if (v > 0) p.push({ method: k, amountMinor: v });
    }
    if (pointsM > 0) p.push({ method: "points", amountMinor: pointsM });
    if (!p.length) p.push({ method: "cash", amountMinor: 0 });
    onPay(p, null);
  }

  return (
    <Modal title="الدفع" onClose={onClose}>
      <div className="pay-total"><span>المطلوب</span><b className="num">{formatMoney(totalMinor)}</b></div>
      {employees.length > 0 && (
        <div className="seg" role="tablist">
          <button className={!staff ? "active" : ""} onClick={() => setStaff(false)}>زبون</button>
          <button className={staff ? "active" : ""} onClick={() => setStaff(true)}>موظف: يخصم من راتبه</button>
        </div>
      )}
      {staff ? (
        <>
          <label>
            الموظف
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} autoFocus>
              <option value="">— اختار الموظف —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <div className="notice">الفاتورة كاملة <b className="num">{formatMoney(totalMinor)}</b> تنخصم من راتب الموظف تلقائيا، ويشوفها في صفحة «راتبي».</div>
        </>
      ) : <>
        <label>
          كاش من الزبون
          <input ref={cashRef} className="num pay-cash" inputMode="decimal" value={cash} autoFocus onFocus={(e) => e.target.select()}
            onChange={(e) => { setCash(e.target.value); setFresh(false); }} onKeyDown={(e) => e.key === "Enter" && pay()} />
        </label>
        <div className="pay-notes">
          <button className={fresh ? "active" : ""} onClick={() => { setCash(String(Math.max(0, totalMinor - otherM - pointsM) / 1000)); setFresh(true); }}>بالضبط</button>
          {notes.map((n) => <button key={n} className="num" onClick={() => addNote(n)}>+{n / 1000}</button>)}
          <button className="ghost" onClick={() => { setCash("0"); setFresh(false); cashRef.current?.focus(); }}>مسح</button>
        </div>
        <div className="pay-methods">
          {choices.map((m) => (
            <button key={m} className={others[m] !== undefined ? "active" : ""} onClick={() => useMethod(m)}>{m === "credit" ? `آجل على ${customer?.name}` : METHOD_LABELS[m]}</button>
          ))}
        </div>
        {(Object.keys(others) as Other[]).map((m) => (
          <div className="pay-row" key={m}>
            <span>{m === "credit" ? `آجل${room !== null ? ` (متاح ${formatMoney(room)})` : ""}` : METHOD_LABELS[m]}</span>
            <input className="num" inputMode="decimal" value={others[m]} onFocus={(e) => e.target.select()} autoFocus
              onChange={(e) => setOthers({ ...others, [m]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && pay()} />
            <button className="ghost" aria-label="شيل" onClick={() => { const n = { ...others }; delete n[m]; setOthers(n); }}>✕</button>
          </div>
        ))}
        {customer && rules?.enabled && (
          <div className="points-box">
            <span>⭐ <b className="num">{customer.points ?? 0}</b> نقطة{(customer.points ?? 0) > 0 && <span className="muted"> (تسوى {formatMoney((customer.points ?? 0) * rules.pointValueMinor)})</span>}</span>
            <span className="spacer" />
            {pointsMax > 0 ? (
              <label className="check">
                <input type="checkbox" checked={usePoints} onChange={(e) => spendPoints(e.target.checked)} />
                <span>{`ادفع ${formatMoney(pointsMax)} بالنقاط (${pointsFor(rules, pointsMax)} نقطة)`}</span>
              </label>
            ) : (
              <span className="muted small">{(customer.points ?? 0) > 0 ? `يقدر يصرف من ${rules.minRedeemPoints} نقطة وفوق` : "يكسب نقاط على هالفاتورة"}</span>
            )}
          </div>
        )}
        <div className={`pay-change ${change >= 0 ? "ok" : "short"}`}>
          <span>{change >= 0 ? "الباقي للزبون" : "ناقص"}</span>
          <b className="num">{formatMoney(Math.abs(change))}</b>
        </div>
      </>}
      {!valid && !staff && paid >= totalMinor && <div className="error">{overLimit ? "الآجل أكبر من المتاح للعميل" : "الباقي يكون من الكاش بس"}</div>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>رجوع</button>
        <button className="primary big" disabled={!valid} onClick={pay}>تأكيد وطباعة</button>
      </div>
    </Modal>
  );
}

/** Money put into or taken out of the drawer during the shift, always with a reason. */
export function DrawerDialog({ onDone, onClose }: { onDone: (kind: "in" | "out", amountMinor: number, reason: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const reasons = kind === "out"
    ? ["دفع لمورد", "مصروف للمحل", "سحب لصاحب المحل", "إيداع في المصرف", "سلفة لموظف"]
    : ["فكة للدرج", "صاحب المحل زاد كاش", "رجوع سلفة"];
  const m = toMinor(Number(amount.replace(",", ".")) || 0);
  const ok = m > 0 && reason.trim().length > 0;
  return (
    <Modal title="💵 إيداع أو سحب من الدرج" onClose={onClose}>
      <div className="seg">
        <button className={kind === "out" ? "active" : ""} onClick={() => { setKind("out"); setReason(""); }}>➖ سحب من الدرج</button>
        <button className={kind === "in" ? "active" : ""} onClick={() => { setKind("in"); setReason(""); }}>➕ إيداع في الدرج</button>
      </div>
      <label>المبلغ (د.ل)
        <input className="num" inputMode="decimal" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && onDone(kind, m, reason.trim())} />
      </label>
      <div className="pay-methods">
        {reasons.map((r) => <button key={r} className={reason === r ? "active" : ""} onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <label>السبب
        <input value={reason} placeholder="اكتب السبب" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && onDone(kind, m, reason.trim())} />
      </label>
      <div className="muted">يتسجل باسمك في الوردية، ويطلع في تقرير قفل الوردية وعند صاحب المحل.</div>
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!ok} onClick={() => onDone(kind, m, reason.trim())}>تسجيل وفتح الدرج</button></div>
    </Modal>
  );
}
