// Closing a shift with the options the owner turned on in «🧾 قفل الوردية»: checks first, the
// drawer counted note by note, the card machine's total, change left for the next shift, and a
// reason (and a manager's PIN) when the difference is over the shop's limit.
import { useEffect, useMemo, useState } from "react";
import { formatMoney, toMinor, type ShiftSettings } from "@pos/shared";
import { api } from "../api";
import { getMeta } from "../localdb";
import { session } from "../session";
import { syncNow } from "../sync";
import { Modal } from "./dialogs";

export interface CloseResult {
  countedMinor: number;
  notes: Record<string, number> | null;
  cardMinor: number | null;
  transferMinor: number | null;
  floatMinor: number | null;
  reason: string | null;
  approvedBy: string | null;
}

/** What is still open on the till: each line is shown before the cashier closes. */
export interface OpenThings { held: number; tabs: number; tables: number; pending: number; failed: number }

const num = (v: string) => {
  const n = Number(v.replace(",", ".").trim() || "0");
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function CloseShiftDialog({ shiftId, set, expected, card, transfer, open, onDone, onClose }: {
  shiftId: string;
  set: ShiftSettings;
  /** What the drawer, the card machine and transfers should show, from this till's own sales. */
  expected: number;
  card: number;
  transfer: number;
  open: OpenThings;
  onDone: (r: CloseResult) => void;
  onClose: () => void;
}) {
  const issues = [
    open.held ? `${open.held} فاتورة معلّقة` : "",
    open.tabs ? `${open.tabs} زبون مفتوح في التبويبات` : "",
    open.tables ? `${open.tables} طاولة مفتوحة` : "",
    open.pending ? `${open.pending} عملية ما توصلتش للسيرفر بعد` : "",
    open.failed ? `${open.failed} عملية مرفوضة تحتاج مراجعة` : "",
  ].filter(Boolean);
  const [step, setStep] = useState<"check" | "count" | "diff">(set.preChecks && issues.length ? "check" : "count");
  const [cash, setCash] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [cardV, setCardV] = useState("");
  const [transferV, setTransferV] = useState("");
  const [floatV, setFloatV] = useState(set.floatMinor ? String(set.floatMinor / 1000) : "");
  const [reason, setReason] = useState("");
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [approver, setApprover] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void getMeta<{ id: string; name: string; role: string }[]>("staff").then((s) => setManagers((s ?? []).filter((u) => u.role !== "cashier")));
  }, []);

  const notesTotal = useMemo(() => set.notes.reduce((a, d) => a + toMinor(d) * (Number(notes[String(d)]) || 0), 0), [notes, set.notes]);
  const counted = set.countNotes ? notesTotal : toMinor(num(cash) || 0);
  const diff = counted - expected;
  const over = set.diffCheck && Math.abs(diff) > set.diffLimitMinor;

  function result(approvedBy: string | null): CloseResult {
    const floatMinor = set.handover ? Math.min(counted, toMinor(num(floatV) || 0)) : null;
    const used = set.countNotes ? Object.fromEntries(Object.entries(notes).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Math.floor(Number(v))])) : null;
    return {
      countedMinor: counted, notes: used, floatMinor,
      cardMinor: set.cardCheck ? toMinor(num(cardV) || 0) : null,
      transferMinor: set.cardCheck ? toMinor(num(transferV) || 0) : null,
      reason: reason.trim() || null, approvedBy,
    };
  }

  function counting() {
    setErr(null);
    if (!set.countNotes && Number.isNaN(num(cash))) return setErr("رقم الكاش غير صحيح");
    if (set.cardCheck && (Number.isNaN(num(cardV)) || Number.isNaN(num(transferV)))) return setErr("رقم البطاقة أو التحويلات غير صحيح");
    if (set.handover && Number.isNaN(num(floatV))) return setErr("رقم الفكّة غير صحيح");
    if (over && (set.needReason || set.needManager)) return setStep("diff");
    onDone(result(null));
  }

  async function approve() {
    setErr(null);
    if (set.needReason && reason.trim().length < 3) return setErr("اكتب سبب الفرق");
    if (!set.needManager) return onDone(result(null));
    if (!approver || pin.length < 4) return setErr("اختار المدير واكتب رقمه السري");
    setBusy(true);
    try {
      // The shift has to be on the server for the manager to sign it.
      await syncNow();
      await api(`/shifts/${shiftId}/approve`, { token: session.staffToken, body: { userId: approver, pin, reason: reason.trim() || undefined } });
      onDone(result(managers.find((m) => m.id === approver)?.name ?? null));
    } catch (e) {
      setErr((e as Error).message === "Failed to fetch" ? "موافقة المدير تحتاج اتصال بالإنترنت" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "check") {
    return (
      <Modal title="قبل ما تقفل الوردية" onClose={onClose}>
        <div className="notice">فيه حاجات مازالت مفتوحة:</div>
        <ul>{issues.map((i) => <li key={i}>{i}</li>)}</ul>
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>رجوع نكمّلهم</button>
          <button className="primary" onClick={() => setStep("count")}>كمّل القفل</button>
        </div>
      </Modal>
    );
  }

  if (step === "diff") {
    return (
      <Modal title="فرق في الدرج" onClose={onClose}>
        <div className="error">
          {set.blind ? "فيه فرق في الدرج أكبر من المسموح. عاود العدّ، أو اكتب السبب." : `الدرج ${diff < 0 ? "ناقص" : "زايد"} ${formatMoney(Math.abs(diff))}، أكبر من المسموح (${formatMoney(set.diffLimitMinor)}).`}
        </div>
        {set.needReason && (
          <label>سبب الفرق<textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} /></label>
        )}
        {set.needManager && (
          <div className="row" style={{ alignItems: "end" }}>
            <label>المدير
              <select value={approver} onChange={(e) => setApprover(e.target.value)}>
                <option value="">اختار</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <label style={{ width: 140 }}>الرقم السري<input type="password" className="num" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} /></label>
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <div className="row">
          <button onClick={() => setStep("count")} disabled={busy}>عاود العدّ</button>
          <span className="spacer" />
          <button className="primary" onClick={() => void approve()} disabled={busy}>{busy ? "…" : "قفل الوردية"}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="قفل الوردية" onClose={onClose}>
      {set.countNotes ? (
        <div className="stack" style={{ gap: 4 }}>
          <span>عدّ الكاش في الدرج، كم ورقة من كل فئة:</span>
          <table>
            <tbody>
              {set.notes.map((d) => (
                <tr key={d}>
                  <td className="num">{d >= 1 ? `${d} د.ل` : `${Math.round(d * 1000)} درهم`}</td>
                  <td>×</td>
                  <td><input className="num" inputMode="numeric" style={{ width: 90 }} value={notes[String(d)] ?? ""} onChange={(e) => setNotes({ ...notes, [String(d)]: e.target.value.replace(/\D/g, "") })} /></td>
                  <td className="num muted">{formatMoney(toMinor(d) * (Number(notes[String(d)]) || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <b>المجموع: <span className="num">{formatMoney(notesTotal)}</span></b>
        </div>
      ) : (
        <label>عدّ الكاش الموجود في الدرج (د.ل)
          <input className="num" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} onKeyDown={(e) => e.key === "Enter" && counting()} autoFocus />
        </label>
      )}
      {set.cardCheck && (
        <div className="row">
          <label>مجموع جهاز البطاقة (د.ل){!set.blind && <span className="muted small"> المبيعات تقول {formatMoney(card)}</span>}
            <input className="num" inputMode="decimal" value={cardV} onChange={(e) => setCardV(e.target.value)} />
          </label>
          <label>مجموع التحويلات (د.ل){!set.blind && <span className="muted small"> المبيعات تقول {formatMoney(transfer)}</span>}
            <input className="num" inputMode="decimal" value={transferV} onChange={(e) => setTransferV(e.target.value)} />
          </label>
        </div>
      )}
      {set.handover && (
        <label>الفكّة اللي تخليها في الدرج للوردية الجاية (د.ل)
          <input className="num" inputMode="decimal" value={floatV} onChange={(e) => setFloatV(e.target.value)} />
          <span className="muted small">الباقي ({formatMoney(Math.max(0, counted - Math.min(counted, toMinor(num(floatV) || 0))))}) يمشي للخزنة.</span>
        </label>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onClose}>إلغاء</button>
        <button className="primary" onClick={counting}>تم</button>
      </div>
    </Modal>
  );
}
