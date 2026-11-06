import { useEffect, useState } from "react";
import { formatMoney, toMinor } from "@pos/shared";
import type { Call } from "./Admin";
import { TimeChart, downloadCsv } from "./charts";
import { Modal } from "../pos/dialogs";

type Account = "cash" | "card" | "transfer";
interface Acc { balanceMinor: number; todayInMinor: number; todayOutMinor: number; monthInMinor: number; monthOutMinor: number; bySource: { source: string; amountMinor: number; count: number }[] }
interface Summary { accounts: Record<Account, Acc>; totalMinor: number; series: { day: string; cash: number; card: number; transfer: number }[] }
interface Ledger { openingMinor: number; inMinor: number; outMinor: number; closingMinor: number; rows: { day: string; at: string; source: string; amount: number; ref: string | null; detail: string | null; movement_id: string | null; balance: number }[] }

export const ACCOUNT: Record<Account, { icon: string; name: string; hint: string }> = {
  cash: { icon: "💵", name: "النقدي", hint: "الأدراج والخزنة" },
  card: { icon: "💳", name: "البطاقات المصرفية", hint: "حساب ماكينة البطاقات" },
  transfer: { icon: "🏦", name: "التحويلات المصرفية", hint: "الحساب المصرفي والصكوك" },
};
const ACCOUNTS = Object.keys(ACCOUNT) as Account[];

const SOURCE: Record<string, string> = {
  sale: "مبيعات", refund: "مرتجعات", customer: "تحصيل من العملاء", supplier: "دفع للموردين", purchase: "مشتريات نقدية",
  expense: "مصروفات", opening: "رصيد افتتاحي", deposit: "إيداع", withdrawal: "سحب", transfer: "تحويل بين الحسابات", adjust: "تسوية بعد الجرد",
  drawer_in: "إيداع في درج الكاشير", drawer_out: "سحب من درج الكاشير",
};

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const dmy = (d: string) => d.split("-").reverse().join("/");
const plus = (n: number) => (n ? `+${formatMoney(n)}` : formatMoney(0));
const minus = (n: number) => (n ? `−${formatMoney(n)}` : formatMoney(0));

/** The treasury: how much is in cash, on the card account and in the bank, right now. */
export function Money({ call }: { call: Call }) {
  const [s, setS] = useState<Summary | null>(null);
  const [account, setAccount] = useState<Account>("cash");
  const [range, setRange] = useState({ from: daysAgo(6), to: today() });
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [dialog, setDialog] = useState<"move" | "transfer" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    call<Summary>("/money/summary").then(setS).catch((e) => setError((e as Error).message));
    call<Ledger>(`/money/ledger?account=${account}&from=${range.from}&to=${range.to}`).then(setLedger).catch((e) => setError((e as Error).message));
  };
  useEffect(load, [account, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  async function undo(id: string) {
    if (!confirm("نلغي الحركة هذي؟")) return;
    await call(`/money/movements/${id}/delete`, { method: "POST" });
    load();
  }

  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">جاري التحميل…</div>;
  return (
    <div className="stack">
      <div className="hello">
        <div>
          <h2>عندك الآن <span className="num">{formatMoney(s.totalMinor)}</span></h2>
          <span className="muted">مجموع النقدي والبطاقات والتحويلات، محسوب من كل حركة في النظام</span>
        </div>
        <span className="spacer" />
        <button onClick={() => setDialog("transfer")}>⇄ تحويل بين الحسابات</button>
        <button className="primary" onClick={() => setDialog("move")}>+ إيداع / سحب / رصيد افتتاحي</button>
      </div>

      <div className="money-cards">
        {ACCOUNTS.map((a) => {
          const x = s.accounts[a];
          return (
            <button key={a} className={`card money-card ${account === a ? "active" : ""}`} onClick={() => setAccount(a)}>
              <div className="row"><span className="money-icon">{ACCOUNT[a].icon}</span><div><b>{ACCOUNT[a].name}</b><small className="muted">{ACCOUNT[a].hint}</small></div></div>
              <b className={`num money-balance ${x.balanceMinor < 0 ? "bad" : ""}`}>{formatMoney(x.balanceMinor)}</b>
              <div className="money-flow">
                <span>اليوم <b className="num ok">{plus(x.todayInMinor)}</b></span>
                <span><b className="num bad">{minus(x.todayOutMinor)}</b></span>
              </div>
              <div className="money-flow muted">
                <span>الشهر {plus(x.monthInMinor)}</span>
                <span>{minus(x.monthOutMinor)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid-main">
        <div className="card panel">
          <div className="panel-head"><b>الأرصدة آخر 30 يوم</b></div>
          <TimeChart
            data={s.series.map((d) => ({ label: dmy(d.day).slice(0, 5), values: [d.cash, d.card, d.transfer] }))}
            names={ACCOUNTS.map((a) => ACCOUNT[a].name)} fmt={formatMoney} height={240} />
        </div>
        <div className="card panel">
          <div className="panel-head"><b>{ACCOUNT[account].icon} {ACCOUNT[account].name}: من وين جات وين مشت (الشهر)</b></div>
          {s.accounts[account].bySource.length === 0 ? <div className="muted">ما فيش حركات هذا الشهر.</div> : (
            <table><tbody>
              {s.accounts[account].bySource.map((r) => (
                <tr key={r.source}><td>{SOURCE[r.source] ?? r.source}<div className="muted">{r.count} حركة</div></td><td className={`num ${r.amountMinor >= 0 ? "ok" : "bad"}`}>{r.amountMinor >= 0 ? "+" : "−"}{formatMoney(Math.abs(r.amountMinor))}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      <div className="card stack">
        <div className="row wrap" style={{ alignItems: "end" }}>
          <b style={{ fontSize: "1.05rem" }}>كشف حساب {ACCOUNT[account].name}</b>
          <span className="spacer" />
          <div className="seg">
            {([["اليوم", 0], ["7 أيام", 6], ["30 يوم", 29]] as const).map(([l, n]) => (
              <button key={l} className={range.from === daysAgo(n) && range.to === today() ? "active" : ""} onClick={() => setRange({ from: daysAgo(n), to: today() })}>{l}</button>
            ))}
          </div>
          <label style={{ maxWidth: 160 }}>من<input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></label>
          <label style={{ maxWidth: 160 }}>إلى<input type="date" value={range.to} max={today()} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></label>
          {ledger && <button onClick={() => downloadCsv(`كشف-${ACCOUNT[account].name}-${range.from}-${range.to}`, ["التاريخ", "الحركة", "البيان", "داخل", "خارج", "الرصيد"],
            ledger.rows.map((r) => [r.day, SOURCE[r.source] ?? r.source, [r.ref, r.detail].filter(Boolean).join(" — "), r.amount > 0 ? r.amount / 1000 : "", r.amount < 0 ? -r.amount / 1000 : "", r.balance / 1000]))}>⬇ Excel</button>}
        </div>
        {ledger && (
          <>
            <div className="kpis">
              <div className="kpi"><span className="muted">رصيد أول المدة</span><b className="num">{formatMoney(ledger.openingMinor)}</b></div>
              <div className="kpi"><span className="muted">داخل</span><b className="num ok">{plus(ledger.inMinor)}</b></div>
              <div className="kpi"><span className="muted">خارج</span><b className="num bad">{minus(ledger.outMinor)}</b></div>
              <div className="kpi"><span className="muted">رصيد آخر المدة</span><b className="num">{formatMoney(ledger.closingMinor)}</b></div>
            </div>
            <table>
              <thead><tr><th>التاريخ</th><th>الحركة</th><th>البيان</th><th>داخل</th><th>خارج</th><th>الرصيد</th><th /></tr></thead>
              <tbody>
                {ledger.rows.length === 0 && <tr><td colSpan={7} className="muted">ما فيش حركات في الفترة هذي.</td></tr>}
                {ledger.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="num">{dmy(r.day)}<div className="muted">{new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div></td>
                    <td>{SOURCE[r.source] ?? r.source}</td>
                    <td>{r.ref}{r.detail && <div className="muted">{r.detail}</div>}</td>
                    <td className="num ok">{r.amount > 0 ? formatMoney(r.amount) : ""}</td>
                    <td className="num bad">{r.amount < 0 ? formatMoney(-r.amount) : ""}</td>
                    <td className="num"><b>{formatMoney(r.balance)}</b></td>
                    <td>{r.movement_id && <button className="ghost danger" onClick={() => void undo(r.movement_id!)}>إلغاء</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {dialog === "move" && <MoveDialog call={call} account={account} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog === "transfer" && <TransferDialog call={call} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
    </div>
  );
}

function MoveDialog({ call, account, onClose, onDone }: { call: Call; account: Account; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ account, kind: "deposit" as "opening" | "deposit" | "withdrawal" | "adjust", amount: "", note: "", onDate: today() });
  const [error, setError] = useState<string | null>(null);
  const hints = { opening: "الفلوس اللي كانت عندك قبل ما تبدا تستعمل النظام.", deposit: "فلوس حطيتها من برا (رأس مال، قرض…).", withdrawal: "فلوس سحبتها لنفسك أو لبرا المحل.", adjust: "بعد ما تعد الفلوس: اكتب الفرق، موجب لو زايد وسالب (مثلا -5) لو ناقص." };
  async function save() {
    setError(null);
    try {
      await call("/money/movements", { body: { account: f.account, kind: f.kind, amountMinor: toMinor(Number(f.amount.replace(",", "."))), note: f.note || undefined, onDate: f.onDate } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="حركة على الخزينة" onClose={onClose}>
      <div className="seg">
        {(["deposit", "withdrawal", "opening", "adjust"] as const).map((k) => (
          <button key={k} className={f.kind === k ? "active" : ""} onClick={() => setF({ ...f, kind: k })}>{SOURCE[k]}</button>
        ))}
      </div>
      <small className="muted">{hints[f.kind]}</small>
      <label>الحساب
        <select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value as Account })}>
          {ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT[a].icon} {ACCOUNT[a].name}</option>)}
        </select>
      </label>
      <div className="row">
        <label style={{ flex: 1 }}>المبلغ (د.ل)<input className="num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></label>
        <label style={{ flex: 1 }}>التاريخ<input type="date" value={f.onDate} max={today()} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
      </div>
      <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /></label>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!Number(f.amount)} onClick={() => void save()}>حفظ</button></div>
    </Modal>
  );
}

function TransferDialog({ call, onClose, onDone }: { call: Call; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ from: "cash" as Account, to: "transfer" as Account, amount: "", note: "", onDate: today() });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      await call("/money/transfers", { body: { from: f.from, to: f.to, amountMinor: toMinor(Number(f.amount.replace(",", "."))), note: f.note || undefined, onDate: f.onDate } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="تحويل بين الحسابات" onClose={onClose}>
      <small className="muted">مثلا: إيداع فلوس الدرج في المصرف، أو سحب من المصرف للخزنة.</small>
      <div className="row">
        <label style={{ flex: 1 }}>من<select value={f.from} onChange={(e) => setF({ ...f, from: e.target.value as Account })}>{ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT[a].icon} {ACCOUNT[a].name}</option>)}</select></label>
        <label style={{ flex: 1 }}>إلى<select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value as Account })}>{ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT[a].icon} {ACCOUNT[a].name}</option>)}</select></label>
      </div>
      <div className="row">
        <label style={{ flex: 1 }}>المبلغ (د.ل)<input className="num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></label>
        <label style={{ flex: 1 }}>التاريخ<input type="date" value={f.onDate} max={today()} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
      </div>
      <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /></label>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!Number(f.amount) || f.from === f.to} onClick={() => void save()}>تحويل</button></div>
    </Modal>
  );
}
