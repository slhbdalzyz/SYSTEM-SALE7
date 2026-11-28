// «🤝 السلف والأمانات»: who owes the shop and for whom the shop holds money, with each one's
// history, money back from the office, a new date, a WhatsApp reminder, answers to cashiers
// asking to lend over their limit, the shop's own rules, and a report.
import { useEffect, useState } from "react";
import { fillTemplate, formatMoney, readShopSettings, toMinor, waLink, type LoanSettings } from "@pos/shared";
import type { Call } from "./Admin";

interface Row {
  id: string; kind: "loan" | "deposit"; personName: string; phone: string | null; amountMinor: number; dueOn: string | null; note: string | null;
  status: "pending" | "approved" | "open" | "closed" | "rejected"; storeName: string | null; createdByName: string | null; approvedByName: string | null;
  createdAt: string; closedAt: string | null; openedMinor: number; backMinor: number; leftMinor: number; overdue: boolean;
}
interface Move { id: string; kind: "open" | "back"; amountMinor: number; note: string | null; at: string; userName: string | null; deviceName: string | null; drawer: boolean }
interface Person { name: string; phone: string | null; oweMinor: number; heldMinor: number; count: number; overdue: boolean }
interface List { rows: Row[]; people: Person[]; totals: { lentMinor: number; heldMinor: number; overdue: number; overdueMinor: number; pending: number } }
interface Report {
  lent: { count: number; amountMinor: number }; back: { count: number; amountMinor: number };
  depositsIn: { count: number; amountMinor: number }; depositsOut: { count: number; amountMinor: number };
  closed: number; onTime: number; avgDays: number | null; byDay: { day: string; lentMinor: number; backMinor: number }[];
}

const day = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(d);
const showDay = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const STATUS: Record<Row["status"], string> = { pending: "⏳ يستنى موافقتك", approved: "✔ وافقت، يستنى الكاشير", open: "مفتوحة", closed: "✅ مقفولة", rejected: "✖ مرفوضة" };

export function Loans({ call, shopName }: { call: Call; shopName: string }) {
  const [tab, setTab] = useState<"open" | "pending" | "closed" | "people" | "report" | "settings">("open");
  const [q, setQ] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [set, setSet] = useState<LoanSettings | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    call<List>(`/loans?status=${tab === "pending" ? "pending" : tab === "closed" ? "closed" : "open"}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    if (tab === "report" || tab === "settings") return;
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void call<{ settings: unknown }>("/settings").then((r) => setSet(readShopSettings(r.settings).loans)).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const t = list?.totals;
  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile"><div className="muted">سلف برّا (عليهم)</div><b className="num">{t ? formatMoney(t.lentMinor) : "…"}</b></div>
        <div className="tile"><div className="muted">أمانات عندك (ليهم)</div><b className="num">{t ? formatMoney(t.heldMinor) : "…"}</b></div>
        <div className={`tile ${t?.overdue ? "warn" : ""}`}><div className="muted">⏰ فات موعدها</div><b className="num">{t ? `${t.overdue} · ${formatMoney(t.overdueMinor)}` : "…"}</b></div>
        {!!t?.pending && <button className="tile warn" onClick={() => setTab("pending")}><div className="muted">⏳ تستنى موافقتك</div><b className="num">{t.pending}</b></button>}
      </div>
      <div className="seg wrap">
        {([["open", "المفتوحة"], ["pending", `تستنى موافقة${t?.pending ? ` (${t.pending})` : ""}`], ["people", "حسب الشخص"], ["closed", "المقفولة"], ["report", "📊 التقرير"], ["settings", "⚙ القواعد"]] as const).map(([k, l]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => { setTab(k); setOpen(null); }}>{l}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}

      {tab === "report" && <LoanReport call={call} />}
      {tab === "settings" && set && <LoanRules call={call} value={set} onSaved={setSet} />}

      {tab !== "report" && tab !== "settings" && (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔎 الاسم أو التلفون" />
          {tab === "people" ? (
            <div className="card">
              <table className="table">
                <thead><tr><th>الشخص</th><th>التلفون</th><th>عليه للمحل</th><th>ليه عند المحل</th><th></th></tr></thead>
                <tbody>
                  {list?.people.length === 0 && <tr><td colSpan={5} className="muted">ما فيش حد عليه أو ليه حاجة.</td></tr>}
                  {list?.people.map((p) => (
                    <tr key={p.phone ?? p.name}>
                      <td>{p.name}{p.overdue && " ⏰"}</td>
                      <td className="num">{p.phone ?? ""}</td>
                      <td className="num">{p.oweMinor ? formatMoney(p.oweMinor) : ""}</td>
                      <td className="num">{p.heldMinor ? formatMoney(p.heldMinor) : ""}</td>
                      <td><button className="ghost small" onClick={() => { setQ(p.phone ?? p.name); setTab("open"); }}>التفاصيل</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {list?.rows.length === 0 && <div className="card muted">{tab === "pending" ? "ما فيش طلبات تستنى." : tab === "closed" ? "ما فيش سلف ولا أمانات مقفولة." : "ما فيش سلف ولا أمانات مفتوحة. الكاشير يسجلها من زر «🤝 سلف وأمانات»."}</div>}
              {list?.rows.map((r) => (
                <LoanCard key={r.id} r={r} call={call} shopName={shopName} set={set} expanded={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} reload={load} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LoanCard({ r, call, shopName, set, expanded, toggle, reload }: { r: Row; call: Call; shopName: string; set: LoanSettings | null; expanded: boolean; toggle: () => void; reload: () => Promise<unknown> }) {
  const [moves, setMoves] = useState<Move[] | null>(null);
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(r.dueOn ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (expanded) void call<Row & { moves: Move[] }>(`/loans/${r.id}`).then((x) => setMoves(x.moves)).catch((e) => setError((e as Error).message));
  }, [expanded, r.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(f: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await f();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const back = toMinor(Number(amount.replace(",", ".")) || 0);
  const isLoan = r.kind === "loan";
  const remind = set && r.phone
    ? waLink(r.phone, fillTemplate(set.reminder, { name: r.personName, shop: shopName, what: isLoan ? "سلفة" : "أمانة", amount: formatMoney(r.amountMinor), left: formatMoney(r.leftMinor), due: r.dueOn ? showDay(r.dueOn) : "" }))
    : null;

  return (
    <div className="card stack" style={{ gap: 6, borderColor: r.overdue || r.status === "pending" ? "var(--warn)" : undefined }}>
      <button className="row ghost" style={{ justifyContent: "space-between", textAlign: "start", width: "100%" }} onClick={toggle}>
        <span>
          <b>{isLoan ? "💵 سلفة" : "🤝 أمانة"} · {r.personName}</b>{r.phone && <span className="muted num"> · {r.phone}</span>}
          <div className="muted" style={{ fontSize: "0.85em" }}>
            {showDay(day(new Date(r.createdAt)))}{r.storeName && ` · ${r.storeName}`}{r.createdByName && ` · ${r.createdByName}`}
            {isLoan && r.dueOn && r.status === "open" && <> · يرجّعها {showDay(r.dueOn)}{r.overdue && " ⏰ فات موعدها"}</>}
            {r.status !== "open" && <> · {STATUS[r.status]}</>}
          </div>
        </span>
        <span style={{ textAlign: "end" }}>
          <b className="num">{formatMoney(r.status === "open" ? r.leftMinor : r.amountMinor)}</b>
          {r.status === "open" && r.backMinor > 0 && <div className="muted num" style={{ fontSize: "0.85em" }}>من {formatMoney(r.openedMinor)}</div>}
        </span>
      </button>

      {r.status === "pending" && (
        <div className="row" style={{ gap: 8 }}>
          <span className="muted">{r.createdByName ?? "الكاشير"} يبي يسلّف {formatMoney(r.amountMinor)}{r.note && ` (${r.note})`}</span>
          <span className="spacer" />
          <button disabled={busy} onClick={() => void act(() => call(`/loans/${r.id}/decide`, { body: { approve: false } }))}>✖ ارفض</button>
          <button className="primary" disabled={busy} onClick={() => void act(() => call(`/loans/${r.id}/decide`, { body: { approve: true } }))}>✔ وافق</button>
        </div>
      )}

      {expanded && (
        <div className="stack" style={{ gap: 6 }}>
          {r.note && <div className="muted">📝 {r.note}</div>}
          <table className="table">
            <thead><tr><th>اليوم</th><th>الحركة</th><th>المبلغ</th><th>من</th></tr></thead>
            <tbody>
              {moves === null && <tr><td colSpan={4} className="muted">…</td></tr>}
              {moves?.length === 0 && <tr><td colSpan={4} className="muted">الدرج ما طلّعش الفلوس بعد.</td></tr>}
              {moves?.map((m) => (
                <tr key={m.id}>
                  <td className="num">{showDay(day(new Date(m.at)))}</td>
                  <td>{m.kind === "open" ? (isLoan ? "طلعت من الدرج" : "حطها في الدرج") : isLoan ? "رجّع" : "رفع"}{m.note && ` · ${m.note}`}</td>
                  <td className="num">{formatMoney(m.amountMinor)}</td>
                  <td className="muted">{m.deviceName ?? (m.drawer ? "" : "من الخزينة")}{m.userName && ` · ${m.userName}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.status === "open" && (
            <>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                <label style={{ flex: 1, minWidth: 140 }}>{isLoan ? "رجّع كم؟ (للخزينة)" : "رفع كم؟ (من الخزينة)"}
                  <input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(r.leftMinor / 1000)} />
                </label>
                <button className="primary" disabled={busy || back <= 0 || back > r.leftMinor}
                  onClick={() => void act(async () => { await call(`/loans/${r.id}/moves`, { body: { id: crypto.randomUUID(), amountMinor: back } }); setAmount(""); })}>سجّل</button>
                <button disabled={busy} onClick={() => setAmount(String(r.leftMinor / 1000))}>الكل</button>
              </div>
              {isLoan && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "end" }}>
                  <label style={{ flex: 1, minWidth: 140 }}>موعد جديد<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
                  <button disabled={busy || !due || due === r.dueOn} onClick={() => void act(() => call(`/loans/${r.id}`, { method: "PATCH", body: { dueOn: due } }))}>غيّر الموعد</button>
                </div>
              )}
              {remind && <a className="button" href={remind} target="_blank" rel="noreferrer">📲 ذكّره على الواتساب</a>}
            </>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}

function LoanReport({ call }: { call: Call }) {
  const [from, setFrom] = useState(() => day().slice(0, 8) + "01");
  const [to, setTo] = useState(day);
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (from && to) void call<Report>(`/loans/report?from=${from}&to=${to}`).then(setR).catch((e) => setError((e as Error).message));
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(1, ...(r?.byDay ?? []).map((d) => Math.max(d.lentMinor, d.backMinor)));
  return (
    <div className="card stack">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label>من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>لين<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      {r && (
        <>
          <div className="tiles">
            <div className="tile"><div className="muted">سلّفنا</div><b className="num">{formatMoney(r.lent.amountMinor)}</b><div className="muted">{r.lent.count} مرة</div></div>
            <div className="tile"><div className="muted">رجع منها</div><b className="num">{formatMoney(r.back.amountMinor)}</b><div className="muted">{r.back.count} مرة</div></div>
            <div className="tile"><div className="muted">أمانات دخلت</div><b className="num">{formatMoney(r.depositsIn.amountMinor)}</b><div className="muted">{r.depositsIn.count} مرة</div></div>
            <div className="tile"><div className="muted">أمانات انرفعت</div><b className="num">{formatMoney(r.depositsOut.amountMinor)}</b><div className="muted">{r.depositsOut.count} مرة</div></div>
          </div>
          <div className="muted">
            {r.closed ? <>تقفلت {r.closed} سلفة، منها {r.onTime} في موعدها. متوسط الرجوع {r.avgDays ?? 0} يوم.</> : "ما تقفلت حتى سلفة في المدة هذي."}
          </div>
          {r.byDay.length > 0 && (
            <table className="table">
              <thead><tr><th>اليوم</th><th>طلع سلف</th><th>رجع</th></tr></thead>
              <tbody>
                {r.byDay.map((d) => (
                  <tr key={d.day}>
                    <td className="num">{showDay(d.day)}</td>
                    <td className="num"><span className="bar" style={{ display: "inline-block", width: `${(d.lentMinor / max) * 80}px`, height: 8, background: "var(--warn, #c77)", borderRadius: 4, marginInlineEnd: 6 }} />{formatMoney(d.lentMinor)}</td>
                    <td className="num"><span className="bar" style={{ display: "inline-block", width: `${(d.backMinor / max) * 80}px`, height: 8, background: "var(--ok, #6a6)", borderRadius: 4, marginInlineEnd: 6 }} />{formatMoney(d.backMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function LoanRules({ call, value, onSaved }: { call: Call; value: LoanSettings; onSaved: (s: LoanSettings) => void }) {
  const [f, setF] = useState({ ...value, limit: value.cashierLimitMinor ? String(value.cashierLimitMinor / 1000) : "", slip: value.slipOverMinor ? String(value.slipOverMinor / 1000) : "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body: LoanSettings = {
        cashierLimitMinor: toMinor(Number(f.limit) || 0), defaultDays: f.defaultDays, slipOverMinor: toMinor(Number(f.slip) || 0),
        alertOverdue: f.alertOverdue, message: f.message, reminder: f.reminder,
      };
      const r = await call<{ loans: LoanSettings }>("/settings/loans", { method: "PATCH", body });
      onSaved(r.loans);
      setMsg("✔ تحفظت");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <div className="form-grid">
        <label>الكاشير يسلّف لين كم بدون موافقة؟ (د.ل)
          <input className="num" inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} placeholder="فاضي = بدون حد" />
        </label>
        <label>موعد الرجوع العادي (بعد كم يوم)
          <input className="num" type="number" min={0} max={365} value={f.defaultDays} onChange={(e) => setF({ ...f, defaultDays: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} />
        </label>
        <label>تطبع ورقة بالتوقيع لو المبلغ فوق (د.ل)
          <input className="num" inputMode="decimal" value={f.slip} onChange={(e) => setF({ ...f, slip: e.target.value })} placeholder="فاضي = لما يطلبها الكاشير بس" />
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.alertOverdue} onChange={(e) => setF({ ...f, alertOverdue: e.target.checked })} style={{ width: "auto" }} />
          نبّهني على التلفون لما يجي موعد سلفة أو يفوت
        </label>
        <label style={{ gridColumn: "1 / -1" }}>رسالة الواتساب للإيصال
          <textarea rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>رسالة التذكير
          <textarea rows={3} value={f.reminder} onChange={(e) => setF({ ...f, reminder: e.target.value })} />
        </label>
      </div>
      <div className="muted" style={{ fontSize: "0.85em" }}>تقدر تحط في الرسالة: {"{name}"} الاسم، {"{shop}"} المحل، {"{what}"} سلفة أو أمانة، {"{amount}"} المبلغ، {"{left}"} الباقي، {"{due}"} الموعد.</div>
      <div className="row"><span className="muted">{msg}</span><span className="spacer" /><button className="primary" disabled={busy} onClick={() => void save()}>حفظ</button></div>
    </div>
  );
}
