// «🤝 سلف وأمانات» at the till: money lent from the drawer under a person's name, money a person
// leaves with the shop, and money back on either. Each one goes through the drawer and the shift,
// and a slip or a WhatsApp message is a tap away.
import { useEffect, useRef, useState } from "react";
import { fillTemplate, formatMoney, readShopSettings, toMinor, type CatalogCustomer, type ShopSettings } from "@pos/shared";
import { ApiError, api } from "../api";
import { db, getMeta, type LoanMoveKind } from "../localdb";
import { session, tokenClaims } from "../session";
import { sendText } from "../whatsapp";
import { Modal } from "./dialogs";
import type { LoanSlip } from "./Receipt";

export interface LoanRow {
  id: string; kind: "loan" | "deposit"; personName: string; phone: string | null; amountMinor: number; dueOn: string | null; note: string | null;
  status: "pending" | "approved" | "open" | "closed" | "rejected"; leftMinor: number; openedMinor: number; backMinor: number; overdue: boolean; createdAt: string;
}

type Step =
  | { kind: "form" }
  | { kind: "wait"; id: string; body: Record<string, unknown> }
  | { kind: "done"; slip: LoanSlip };

const dayAfter = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};
const showDay = (s: string) => s.split("-").reverse().join("/");

/** The WhatsApp message for a loan or deposit, filled from the shop's own wording. */
export function loanMessage(set: ShopSettings, shopName: string, s: LoanSlip) {
  const what = s.move === "open" ? (s.kind === "loan" ? "سلفة" : "أمانة") : s.kind === "loan" ? "رجوع من السلفة" : "رفع من الأمانة";
  return fillTemplate(set.loans.message, {
    name: s.personName, shop: shopName, what, amount: formatMoney(s.amountMinor),
    due: s.kind === "loan" && s.dueOn && s.leftMinor > 0 ? `، ترجع يوم ${showDay(s.dueOn)}` : "", left: formatMoney(s.leftMinor),
  });
}

export function LoanDialog({ shiftId, customer, shop, onMoved, onPrint, onClose }: {
  shiftId: string | null;
  customer: CatalogCustomer | null;
  shop: { name: string; settings: ShopSettings } | null;
  /** The drawer moved: the till records it for the shift and opens the drawer. */
  onMoved: (kind: LoanMoveKind, amountMinor: number, reason: string) => Promise<void>;
  onPrint: (slip: LoanSlip) => void;
  onClose: () => void;
}) {
  const set = shop?.settings ?? readShopSettings({});
  const isCashier = tokenClaims(session.staffToken)?.role === "cashier";
  const [tab, setTab] = useState<"loan" | "deposit" | "back">("loan");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(set.loans.defaultDays ? dayAfter(set.loans.defaultDays) : "");
  const [note, setNote] = useState("");
  const [managers, setManagers] = useState<{ id: string; name: string }[]>([]);
  const [approver, setApprover] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Money back: the open ones, found by name or phone.
  const [q, setQ] = useState("");
  const [list, setList] = useState<LoanRow[] | null>(null);
  const [pick, setPick] = useState<LoanRow | null>(null);
  const [back, setBack] = useState("");

  const m = toMinor(Number(amount.replace(",", ".")) || 0);
  const limit = set.loans.cashierLimitMinor;
  const overLimit = tab === "loan" && isCashier && limit > 0 && m > limit;

  useEffect(() => {
    void getMeta<{ id: string; name: string; role: string }[]>("staff").then((s) => setManagers((s ?? []).filter((u) => u.role !== "cashier")));
  }, []);

  // The list for money back: from the server, kept for when the line drops.
  useEffect(() => {
    if (tab !== "back") return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ rows: LoanRow[] }>(`/loans?status=open${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, { token: session.staffToken });
        setList(r.rows.filter((x) => x.status === "open"));
        if (!q.trim()) await db.meta.put({ key: "openLoans", value: r.rows });
      } catch {
        const cached = (await getMeta<LoanRow[]>("openLoans")) ?? [];
        const s = q.trim();
        setList(cached.filter((x) => x.status === "open" && (!s || x.personName.includes(s) || (x.phone ?? "").includes(s))));
      }
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, q]);

  // Waiting for the owner: asked every few seconds until they answer.
  const waiting = useRef(false);
  useEffect(() => {
    if (step.kind !== "wait") return;
    waiting.current = true;
    const tick = async () => {
      try {
        const l = await api<LoanRow>(`/loans/${step.id}`, { token: session.staffToken });
        if (l.status === "approved") {
          waiting.current = false;
          const done = await api<LoanRow>(`/loans/${step.id}/pay`, { token: session.staffToken, body: { shiftId } });
          await finishOpen(done);
          return;
        }
        if (l.status === "open") {
          waiting.current = false;
          return finishOpen(l);
        }
        if (l.status === "rejected") {
          waiting.current = false;
          setStep({ kind: "form" });
          setError("صاحب المحل رفض السلفة.");
          return;
        }
      } catch {
        /* the line dropped for a moment: try again */
      }
      if (waiting.current) timer = setTimeout(() => void tick(), 4000);
    };
    let timer = setTimeout(() => void tick(), 1500);
    return () => {
      waiting.current = false;
      clearTimeout(timer);
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function finishOpen(l: Pick<LoanRow, "kind" | "personName" | "phone" | "amountMinor" | "dueOn" | "note">) {
    const word = l.kind === "loan" ? "سلفة" : "أمانة";
    await onMoved(l.kind === "loan" ? "loan_out" : "deposit_in", l.amountMinor, `${word}: ${l.personName}`);
    const slip: LoanSlip = {
      kind: l.kind, move: "open", personName: l.personName, phone: l.phone, amountMinor: l.amountMinor, leftMinor: l.amountMinor,
      dueOn: l.dueOn, note: l.note, at: new Date().toISOString(), sign: set.loans.slipOverMinor > 0 && l.amountMinor >= set.loans.slipOverMinor,
    };
    if (slip.sign) onPrint(slip);
    setStep({ kind: "done", slip });
  }

  async function open(ask = false) {
    setError(null);
    const kind = tab === "deposit" ? "deposit" : "loan";
    const id = crypto.randomUUID();
    const body = {
      id, kind, personName: name.trim(), phone: phone.trim() || null, customerId: customer && customer.name === name.trim() ? customer.id : null,
      amountMinor: m, dueOn: kind === "loan" && due ? due : null, note: note.trim() || null, shiftId, at: new Date().toISOString(),
      ...(overLimit && !ask ? { approval: { userId: approver, pin } } : {}), ...(ask ? { ask: true } : {}),
    };
    setBusy(true);
    try {
      const l = await api<LoanRow>("/loans", { token: session.staffToken, body });
      if (l.status === "pending") setStep({ kind: "wait", id, body });
      else await finishOpen(l);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        if (ask) {
          setError("موافقة صاحب المحل من التلفون تحتاج إنترنت. استعمل رقم المدير السري، أو استنى لين يرجع الخط.");
        } else {
          // No line: kept on the till and sent with the sales when it is back.
          await db.outbox.add({ kind: "loan", refId: id, payload: { body }, createdAt: body.at });
          await finishOpen({ kind, personName: body.personName, phone: body.phone, amountMinor: m, dueOn: body.dueOn, note: body.note });
        }
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function takeBack() {
    if (!pick) return;
    setError(null);
    const amt = toMinor(Number(back.replace(",", ".")) || 0);
    const body = { id: crypto.randomUUID(), amountMinor: amt, shiftId, at: new Date().toISOString() };
    setBusy(true);
    let left = pick.leftMinor - amt;
    try {
      left = (await api<LoanRow>(`/loans/${pick.id}/moves`, { token: session.staffToken, body })).leftMinor;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) {
        setBusy(false);
        return setError((e as Error).message);
      }
      await db.outbox.add({ kind: "loan_move", refId: body.id, payload: { loanId: pick.id, body }, createdAt: body.at });
    }
    setBusy(false);
    await onMoved(pick.kind === "loan" ? "loan_back" : "deposit_out", amt, `${pick.kind === "loan" ? "رجوع سلفة" : "رفع أمانة"}: ${pick.personName}`);
    setStep({ kind: "done", slip: { kind: pick.kind, move: "back", personName: pick.personName, phone: pick.phone, amountMinor: amt, leftMinor: Math.max(0, left), dueOn: pick.dueOn, note: null, at: body.at, sign: false } });
  }

  if (step.kind === "wait") {
    return (
      <Modal title="⏳ نستنو موافقة صاحب المحل" onClose={onClose}>
        <p>بعتنا طلب سلفة <b>{formatMoney(m)}</b> لـ <b>{name}</b> لتلفون صاحب المحل. أول ما يوافق، يتفتح الدرج هنا.</p>
        <div className="muted">تقدر تقفل النافذة وتكمّل البيع. الطلب يقعد عنده في «🤝 السلف والأمانات».</div>
        <div className="row"><span className="spacer" /><button onClick={onClose}>قفل</button></div>
      </Modal>
    );
  }

  if (step.kind === "done") {
    const s = step.slip;
    const title = s.move === "open" ? (s.kind === "loan" ? "✅ تسجلت السلفة" : "✅ تسجلت الأمانة") : "✅ تسجل";
    return (
      <Modal title={title} onClose={onClose}>
        <p style={{ fontSize: "1.1em" }}>
          {s.move === "open" ? (s.kind === "loan" ? "طلّع من الدرج" : "حط في الدرج") : s.kind === "loan" ? "حط في الدرج" : "طلّع من الدرج"} <b>{formatMoney(s.amountMinor)}</b>
          {" "}· {s.personName}
        </p>
        <div className="muted">
          {s.kind === "loan" ? "الباقي عليه" : "الباقي عند المحل"}: {formatMoney(s.leftMinor)}
          {s.kind === "loan" && s.dueOn && s.leftMinor > 0 && <> · يرجّعها يوم {showDay(s.dueOn)}</>}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {s.phone && <button onClick={() => sendText(s.phone, loanMessage(set, shop?.name ?? "", s))}>📲 إيصال واتساب</button>}
          <button onClick={() => onPrint({ ...s, sign: s.move === "open" })}>🖨 {s.move === "open" ? "ورقة بالتوقيع" : "إيصال"}</button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>تم</button>
        </div>
      </Modal>
    );
  }

  const okNew = name.trim().length > 0 && m > 0 && (!overLimit || (approver && pin.length >= 4));
  const backMinor = toMinor(Number(back.replace(",", ".")) || 0);
  return (
    <Modal title="🤝 سلف وأمانات" onClose={onClose}>
      <div className="seg">
        <button className={tab === "loan" ? "active" : ""} onClick={() => { setTab("loan"); setError(null); }}>💵 سلفة</button>
        <button className={tab === "deposit" ? "active" : ""} onClick={() => { setTab("deposit"); setError(null); }}>🤝 أمانة</button>
        <button className={tab === "back" ? "active" : ""} onClick={() => { setTab("back"); setError(null); }}>↩️ رجوع / رفع</button>
      </div>
      {tab !== "back" ? (
        <>
          <div className="muted">{tab === "loan" ? "فلوس تطلع من الدرج باسم الشخص، ويرجّعها بعدين." : "فلوس يحطها الشخص عندك ويرفعها بعدين. ما تتحسبش مبيعات."}</div>
          <div className="row" style={{ gap: 8 }}>
            <label style={{ flex: 2 }}>الاسم<input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="مثلاً: خالد الجار" /></label>
            <label style={{ flex: 1 }}>التلفون<input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} placeholder="09xxxxxxxx" /></label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <label style={{ flex: 1 }}>المبلغ (د.ل)<input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && okNew && !busy && void open()} /></label>
            {tab === "loan" && <label style={{ flex: 1 }}>يرجّعها يوم<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>}
          </div>
          <div className="pay-methods">
            {tab === "loan" && [1, 3, 7, 30].map((d) => <button key={d} className={due === dayAfter(d) ? "active" : ""} onClick={() => setDue(dayAfter(d))}>{d === 1 ? "بكرة" : d === 30 ? "بعد شهر" : `بعد ${d} أيام`}</button>)}
          </div>
          <label>ملاحظة<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="اختياري" /></label>
          {overLimit && (
            <div className="card stack" style={{ padding: 10 }}>
              <b>السلفة فوق {formatMoney(limit)}: تحتاج موافقة</b>
              <div className="row" style={{ gap: 8 }}>
                <select value={approver} onChange={(e) => setApprover(e.target.value)} style={{ flex: 1 }}>
                  <option value="">المدير…</option>
                  {managers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="الرقم السري" style={{ flex: 1 }} />
              </div>
              <button disabled={busy || !name.trim() || m <= 0} onClick={() => void open(true)}>📲 أو اطلب موافقة صاحب المحل من التلفون</button>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button>
            <button className="primary" disabled={!okNew || busy} onClick={() => void open()}>{busy ? "…" : tab === "loan" ? "سجّل وطلّع من الدرج" : "سجّل وحط في الدرج"}</button>
          </div>
        </>
      ) : (
        <>
          <input value={q} autoFocus onChange={(e) => { setQ(e.target.value); setPick(null); }} placeholder="🔎 الاسم أو التلفون" />
          {!pick && (
            <div className="stack" style={{ gap: 4, maxHeight: 280, overflow: "auto" }}>
              {list === null && <div className="muted">…</div>}
              {list?.length === 0 && <div className="muted">ما فيش سلف ولا أمانات مفتوحة{q ? " بالاسم هذا" : ""}.</div>}
              {list?.map((l) => (
                <button key={l.id} className="row" style={{ justifyContent: "space-between", textAlign: "start" }} onClick={() => { setPick(l); setBack(String(l.leftMinor / 1000)); }}>
                  <span>{l.kind === "loan" ? "💵" : "🤝"} {l.personName}{l.overdue && " ⏰"}</span>
                  <span className="muted">{l.kind === "loan" ? "عليه" : "ليه"} {formatMoney(l.leftMinor)}</span>
                </button>
              ))}
            </div>
          )}
          {pick && (
            <div className="stack">
              <div><b>{pick.kind === "loan" ? "💵 سلفة" : "🤝 أمانة"} {pick.personName}</b> · {pick.kind === "loan" ? "الباقي عليه" : "الباقي عنده"} {formatMoney(pick.leftMinor)}</div>
              <label>{pick.kind === "loan" ? "رجّع كم؟" : "يرفع كم؟"} (د.ل)
                <input className="num" inputMode="decimal" value={back} autoFocus onChange={(e) => setBack(e.target.value)} />
              </label>
              <div className="pay-methods">
                <button className={backMinor === pick.leftMinor ? "active" : ""} onClick={() => setBack(String(pick.leftMinor / 1000))}>الكل</button>
                <button onClick={() => setBack(String(Math.round(pick.leftMinor / 2) / 1000))}>النص</button>
                <button onClick={() => setPick(null)}>↩ واحد ثاني</button>
              </div>
              {error && <div className="error">{error}</div>}
              <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button>
                <button className="primary" disabled={busy || backMinor <= 0 || backMinor > pick.leftMinor} onClick={() => void takeBack()}>
                  {pick.kind === "loan" ? "استلم وحط في الدرج" : "سلّم وطلّع من الدرج"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
