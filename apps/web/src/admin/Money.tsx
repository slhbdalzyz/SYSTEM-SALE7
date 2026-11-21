import { useEffect, useState } from "react";
import { formatMoney, toMinor } from "@pos/shared";
import type { Call } from "./Admin";
import { TimeChart, downloadCsv } from "./charts";
import { Modal } from "../pos/dialogs";
import { BankSelect, bankLabel, printTable, type Bank } from "./banks";

type Account = "cash" | "card" | "transfer";
interface Acc { balanceMinor: number; todayInMinor: number; todayOutMinor: number; monthInMinor: number; monthOutMinor: number; bySource: { source: string; amountMinor: number; count: number }[] }
interface BankBox extends Bank { balanceMinor: number; pendingCardMinor: number; todayInMinor: number; todayOutMinor: number; lastReconciled: { day: string; differenceMinor: number } | null }
interface Summary { accounts: Record<Account, Acc>; banks: BankBox[]; totalMinor: number; series: { day: string; cash: number; card: number; transfer: number }[] }
interface Ledger { openingMinor: number; inMinor: number; outMinor: number; closingMinor: number; rows: { day: string; at: string; source: string; amount: number; ref: string | null; detail: string | null; movement_id: string | null; balance: number; row_key: string; cleared: boolean }[] }

export const ACCOUNT: Record<Account, { icon: string; name: string; hint: string }> = {
  cash: { icon: "💵", name: "النقدي", hint: "الأدراج والخزنة" },
  card: { icon: "💳", name: "البطاقات المصرفية", hint: "حساب ماكينة البطاقات" },
  transfer: { icon: "🏦", name: "التحويلات المصرفية", hint: "الحساب المصرفي والصكوك" },
};
const ACCOUNTS = Object.keys(ACCOUNT) as Account[];

const SOURCE: Record<string, string> = {
  sale: "مبيعات", refund: "مرتجعات", customer: "تحصيل من العملاء", supplier: "دفع للموردين", purchase: "مشتريات نقدية",
  expense: "مصروفات", opening: "رصيد افتتاحي", deposit: "إيداع", withdrawal: "سحب", transfer: "تحويل بين الحسابات", adjust: "تسوية بعد الجرد",
  drawer_in: "إيداع في درج الكاشير", drawer_out: "سحب من درج الكاشير", settlement: "تسوية بطاقات",
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
  const [bankId, setBankId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"move" | "transfer" | "settle" | null>(null);
  const [editBank, setEditBank] = useState<Partial<BankBox> | null>(null);
  const [reconcile, setReconcile] = useState(false);
  const [recTick, setRecTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scope = account !== "cash" && bankId ? `&bankId=${bankId}` : "";
  const load = () => {
    call<Summary>("/money/summary").then(setS).catch((e) => setError((e as Error).message));
    call<Ledger>(`/money/ledger?account=${account}&from=${range.from}&to=${range.to}${scope}`).then(setLedger).catch((e) => setError((e as Error).message));
    setRecTick((n) => n + 1);
  };
  useEffect(load, [account, bankId, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickAccount = (a: Account) => { setAccount(a); if (a === "cash") setBankId(null); setReconcile(false); };
  const pickBank = (id: string) => { setAccount("transfer"); setBankId(id); };

  async function tick(keys: string[], cleared: boolean) {
    if (!keys.length) return;
    await call("/money/cleared", { body: { rowKeys: keys, cleared } }).catch((e) => setError((e as Error).message));
    load();
  }

  async function undo(id: string) {
    if (!confirm("نلغي الحركة هذي؟")) return;
    await call(`/money/movements/${id}/delete`, { method: "POST" });
    load();
  }

  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const banks = s.banks ?? [];
  const activeBanks = banks.filter((b) => b.active);
  const bank = banks.find((b) => b.id === bankId) ?? null;
  const pendingCard = banks.reduce((a, b) => a + b.pendingCardMinor, 0) || s.accounts.card.balanceMinor;
  const title = `${ACCOUNT[account].name}${bank ? `: ${bankLabel(bank)}` : ""}`;
  const canTick = reconcile && account === "transfer" && !!bank;
  const statementRows = () => (ledger?.rows ?? []).slice().reverse().map((r) => [dmy(r.day), SOURCE[r.source] ?? r.source, [r.ref, r.detail].filter(Boolean).join(" — "), r.amount > 0 ? formatMoney(r.amount) : "", r.amount < 0 ? formatMoney(-r.amount) : "", formatMoney(r.balance), r.cleared ? "✓" : ""]);
  return (
    <div className="stack">
      <div className="hello">
        <div>
          <h2>عندك الآن <span className="num">{formatMoney(s.totalMinor)}</span></h2>
          <span className="muted">مجموع النقدي والبطاقات والتحويلات، محسوب من كل حركة في النظام</span>
        </div>
        <span className="spacer" />
        <button onClick={() => setDialog("settle")} disabled={pendingCard <= 0} title="المصرف حوّل فلوس ماكينة البطاقات لحسابك">💳 تسوية البطاقات</button>
        <button onClick={() => setDialog("transfer")}>⇄ تحويل بين الحسابات</button>
        <button className="primary" onClick={() => setDialog("move")}>+ إيداع / سحب / رصيد افتتاحي</button>
      </div>

      <div className="money-cards">
        {ACCOUNTS.map((a) => {
          const x = s.accounts[a];
          return (
            <button key={a} className={`card money-card ${account === a && !bankId ? "active" : ""}`} onClick={() => { pickAccount(a); setBankId(null); }}>
              <div className="row"><span className="money-icon">{ACCOUNT[a].icon}</span><div><b>{ACCOUNT[a].name}</b><small className="muted">{ACCOUNT[a].hint}</small></div></div>
              <b className={`num money-balance ${x.balanceMinor < 0 ? "bad" : ""}`}>{formatMoney(x.balanceMinor)}</b>
              {a === "card" && x.balanceMinor > 0 && <small className="muted">تحت التسوية: المصرف ما حوّلهاش للحساب بعد</small>}
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

      <div className="card stack">
        <div className="row wrap" style={{ alignItems: "center" }}>
          <b style={{ fontSize: "1.05rem" }}>🏦 حساباتك المصرفية</b>
          <small className="muted">كل حساب برصيده. اضغط على حساب تشوف كشفه وتطابقه مع كشف المصرف.</small>
          <span className="spacer" />
          <button className="primary" onClick={() => setEditBank({})}>+ حساب مصرفي</button>
        </div>
        {banks.length === 0 ? (
          <small className="muted">ما فيش حسابات مسجلة. ضيف حساباتك (الجمهورية، الوحدة، التجارة والتنمية…) وكل تحويل أو بطاقة أو دفع لمورد يتسجل على حسابه.</small>
        ) : (
          <div className="money-cards">
            {banks.map((b) => (
              <div key={b.id} role="button" tabIndex={0} className={`card money-card ${bankId === b.id ? "active" : ""}`} style={{ opacity: b.active ? 1 : 0.55, cursor: "pointer" }}
                onClick={() => pickBank(b.id)} onKeyDown={(e) => e.key === "Enter" && pickBank(b.id)}>
                <div className="row">
                  <span className="money-icon">🏦</span>
                  <div style={{ flex: 1 }}>
                    <b>{bankLabel(b)}</b>
                    <small className="muted num">{b.accountNumber ?? b.iban ?? "بدون رقم حساب"}</small>
                  </div>
                  {b.isDefault && <span className="badge ok">الرئيسي</span>}
                  {!b.active && <span className="badge off">موقوف</span>}
                  <button className="ghost" title="تعديل" onClick={(e) => { e.stopPropagation(); setEditBank(b); }}>✏️</button>
                </div>
                <b className={`num money-balance ${b.balanceMinor < 0 ? "bad" : ""}`}>{formatMoney(b.balanceMinor)}</b>
                <div className="money-flow">
                  <span>اليوم <b className="num ok">{plus(b.todayInMinor)}</b></span>
                  <span><b className="num bad">{minus(b.todayOutMinor)}</b></span>
                </div>
                {b.pendingCardMinor > 0 && <small>💳 بطاقات تحت التسوية <b className="num">{formatMoney(b.pendingCardMinor)}</b></small>}
                <small className="muted">
                  {b.lastReconciled
                    ? <>آخر مطابقة {dmy(b.lastReconciled.day)}: {b.lastReconciled.differenceMinor === 0 ? <span className="ok">✓ مطابق</span> : <span className="bad num">فرق {formatMoney(b.lastReconciled.differenceMinor)}</span>}</>
                    : "ما تطابقش مع كشف المصرف بعد"}
                </small>
              </div>
            ))}
          </div>
        )}
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
          <b style={{ fontSize: "1.05rem" }}>كشف حساب {title}</b>
          {account !== "cash" && banks.length > 0 && (
            <select value={bankId ?? ""} onChange={(e) => setBankId(e.target.value || null)} style={{ maxWidth: 220 }}>
              <option value="">كل المصارف</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{bankLabel(b)}</option>)}
            </select>
          )}
          <span className="spacer" />
          <div className="seg">
            {([["اليوم", 0], ["7 أيام", 6], ["30 يوم", 29]] as const).map(([l, n]) => (
              <button key={l} className={range.from === daysAgo(n) && range.to === today() ? "active" : ""} onClick={() => setRange({ from: daysAgo(n), to: today() })}>{l}</button>
            ))}
          </div>
          <label style={{ maxWidth: 160 }}>من<input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></label>
          <label style={{ maxWidth: 160 }}>إلى<input type="date" value={range.to} max={today()} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></label>
          {ledger && <button onClick={() => downloadCsv(`كشف-${title}-${range.from}-${range.to}`, ["التاريخ", "الحركة", "البيان", "داخل", "خارج", "الرصيد", "مطابق"],
            ledger.rows.slice().reverse().map((r) => [r.day, SOURCE[r.source] ?? r.source, [r.ref, r.detail].filter(Boolean).join(" — "), r.amount > 0 ? r.amount / 1000 : "", r.amount < 0 ? -r.amount / 1000 : "", r.balance / 1000, r.cleared ? "نعم" : ""]))}>⬇ Excel</button>}
          {ledger && <button onClick={() => void printTable({
            title: `كشف حساب ${title}`,
            sub: [`من ${dmy(range.from)} إلى ${dmy(range.to)}`, ...(bank?.accountNumber ? [`رقم الحساب ${bank.accountNumber}`] : []), ...(bank?.iban ? [`IBAN ${bank.iban}`] : [])],
            header: ["التاريخ", "الحركة", "البيان", "داخل", "خارج", "الرصيد", "مطابق"],
            rows: [["", "رصيد أول المدة", "", "", "", formatMoney(ledger.openingMinor), ""], ...statementRows()],
            foot: [`داخل ${formatMoney(ledger.inMinor)} · خارج ${formatMoney(ledger.outMinor)} · رصيد آخر المدة ${formatMoney(ledger.closingMinor)}`],
          })}>🖨 طباعة</button>}
          {account === "transfer" && bank && <button className={reconcile ? "primary" : ""} onClick={() => setReconcile(!reconcile)}>✓ مطابقة مع كشف المصرف</button>}
        </div>
        {reconcile && account === "transfer" && bank && <Reconcile call={call} bank={bank} day={range.to} tick={recTick} onSaved={load} />}
        {account === "transfer" && !bank && activeBanks.length > 1 && <small className="muted">للمطابقة مع كشف المصرف اختار حساب واحد من فوق.</small>}
        {ledger && (
          <>
            <div className="kpis">
              <div className="kpi"><span className="muted">رصيد أول المدة</span><b className="num">{formatMoney(ledger.openingMinor)}</b></div>
              <div className="kpi"><span className="muted">داخل</span><b className="num ok">{plus(ledger.inMinor)}</b></div>
              <div className="kpi"><span className="muted">خارج</span><b className="num bad">{minus(ledger.outMinor)}</b></div>
              <div className="kpi"><span className="muted">رصيد آخر المدة</span><b className="num">{formatMoney(ledger.closingMinor)}</b></div>
            </div>
            <table>
              <thead><tr>{canTick && <th title="طلعت في كشف المصرف"><input type="checkbox" aria-label="مطابقة الكل" checked={ledger.rows.length > 0 && ledger.rows.every((r) => r.cleared)}
                onChange={(e) => void tick(ledger.rows.filter((r) => r.cleared !== e.target.checked).map((r) => r.row_key), e.target.checked)} /></th>}<th>التاريخ</th><th>الحركة</th><th>البيان</th><th>داخل</th><th>خارج</th><th>الرصيد</th><th /></tr></thead>
              <tbody>
                {ledger.rows.length === 0 && <tr><td colSpan={8} className="muted">ما فيش حركات في الفترة هذي.</td></tr>}
                {ledger.rows.map((r, i) => (
                  <tr key={i} style={canTick && r.cleared ? { opacity: 0.6 } : undefined}>
                    {canTick && <td><input type="checkbox" checked={r.cleared} aria-label="طلعت في كشف المصرف" onChange={(e) => void tick([r.row_key], e.target.checked)} /></td>}
                    <td className="num">{dmy(r.day)}<div className="muted">{new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div></td>
                    <td>{SOURCE[r.source] ?? r.source}</td>
                    <td>{r.ref}{r.detail && <div className="muted">{r.detail}</div>}</td>
                    <td className="num ok">{r.amount > 0 ? formatMoney(r.amount) : ""}</td>
                    <td className="num bad">{r.amount < 0 ? formatMoney(-r.amount) : ""}</td>
                    <td className="num"><b>{formatMoney(r.balance)}</b></td>
                    <td>{!canTick && r.cleared && <span className="ok" title="طلعت في كشف المصرف">✓</span>}{r.movement_id && <button className="ghost danger" onClick={() => void undo(r.movement_id!)}>إلغاء</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {dialog === "move" && <MoveDialog call={call} account={account} banks={activeBanks} bankId={bankId} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog === "transfer" && <TransferDialog call={call} banks={activeBanks} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {dialog === "settle" && <SettleDialog call={call} banks={banks} bankId={bankId} fallback={s.accounts.card.balanceMinor} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
      {editBank && <BankDialog call={call} bank={editBank} onClose={() => setEditBank(null)} onDone={() => { setEditBank(null); load(); }} />}
    </div>
  );
}

function MoveDialog({ call, account, banks, bankId, onClose, onDone }: { call: Call; account: Account; banks: Bank[]; bankId: string | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ account, bankId, kind: "deposit" as "opening" | "deposit" | "withdrawal" | "adjust", amount: "", note: "", onDate: today() });
  const [error, setError] = useState<string | null>(null);
  const hints = { opening: "الفلوس اللي كانت عندك قبل ما تبدا تستعمل النظام.", deposit: "فلوس حطيتها من برا (رأس مال، قرض…).", withdrawal: "فلوس سحبتها لنفسك أو لبرا المحل.", adjust: "بعد ما تعد الفلوس: اكتب الفرق، موجب لو زايد وسالب (مثلا -5) لو ناقص." };
  async function save() {
    setError(null);
    try {
      await call("/money/movements", { body: { account: f.account, bankId: f.account === "cash" ? undefined : f.bankId, kind: f.kind, amountMinor: toMinor(Number(f.amount.replace(",", "."))), note: f.note || undefined, onDate: f.onDate } });
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
      {f.account !== "cash" && <BankSelect banks={banks} value={f.bankId} onChange={(id) => setF({ ...f, bankId: id })} label="في أي مصرف" />}
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

function TransferDialog({ call, banks, onClose, onDone }: { call: Call; banks: Bank[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ from: "cash" as Account, to: "transfer" as Account, fromBankId: null as string | null, toBankId: null as string | null, amount: "", note: "", onDate: today() });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      await call("/money/transfers", { body: { from: f.from, to: f.to, fromBankId: f.from === "cash" ? undefined : f.fromBankId, toBankId: f.to === "cash" ? undefined : f.toBankId, amountMinor: toMinor(Number(f.amount.replace(",", "."))), note: f.note || undefined, onDate: f.onDate } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="تحويل بين الحسابات" onClose={onClose}>
      <small className="muted">مثلا: إيداع فلوس الدرج في المصرف، سحب من المصرف للخزنة، أو تحويل من مصرف لمصرف.</small>
      <div className="row">
        <label style={{ flex: 1 }}>من<select value={f.from} onChange={(e) => setF({ ...f, from: e.target.value as Account })}>{ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT[a].icon} {ACCOUNT[a].name}</option>)}</select></label>
        <label style={{ flex: 1 }}>إلى<select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value as Account })}>{ACCOUNTS.map((a) => <option key={a} value={a}>{ACCOUNT[a].icon} {ACCOUNT[a].name}</option>)}</select></label>
      </div>
      {banks.length > 1 && (f.from !== "cash" || f.to !== "cash") && (
        <div className="row">
          <div style={{ flex: 1 }}>{f.from !== "cash" && <BankSelect banks={banks} value={f.fromBankId} onChange={(id) => setF({ ...f, fromBankId: id })} label="من مصرف" />}</div>
          <div style={{ flex: 1 }}>{f.to !== "cash" && <BankSelect banks={banks} value={f.toBankId} onChange={(id) => setF({ ...f, toBankId: id })} label="إلى مصرف" />}</div>
        </div>
      )}
      <div className="row">
        <label style={{ flex: 1 }}>المبلغ (د.ل)<input className="num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></label>
        <label style={{ flex: 1 }}>التاريخ<input type="date" value={f.onDate} max={today()} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
      </div>
      <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /></label>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!Number(f.amount) || (f.from === f.to && (f.from === "cash" || f.fromBankId === f.toBankId))} onClick={() => void save()}>تحويل</button></div>
    </Modal>
  );
}

/** The bank paid the card machine's money into the account, less its commission. */
function SettleDialog({ call, banks, bankId, fallback, onClose, onDone }: { call: Call; banks: BankBox[]; bankId: string | null; fallback: number; onClose: () => void; onDone: () => void }) {
  const active = banks.filter((b) => b.active || b.pendingCardMinor > 0);
  const first = active.find((b) => b.id === bankId) ?? active.find((b) => b.pendingCardMinor > 0) ?? active.find((b) => b.isDefault) ?? null;
  const pendingOf = (id: string | null) => (id ? banks.find((b) => b.id === id)?.pendingCardMinor ?? 0 : fallback);
  const [f, setF] = useState({ bankId: first?.id ?? null, gross: String(pendingOf(first?.id ?? null) / 1000), fee: "", note: "", onDate: today() });
  const [error, setError] = useState<string | null>(null);
  const gross = toMinor(Number(f.gross.replace(",", ".")) || 0);
  const fee = toMinor(Number(f.fee.replace(",", ".")) || 0);
  async function save() {
    setError(null);
    try {
      await call("/money/settlements", { body: { bankId: f.bankId, grossMinor: gross, feeMinor: fee, note: f.note || undefined, onDate: f.onDate } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="💳 تسوية البطاقات" onClose={onClose}>
      <small className="muted">فلوس ماكينة البطاقات تقعد «تحت التسوية» لين المصرف يحوّلها لحسابك. لما تنزل في الحساب سجّلها هني، والعمولة اللي خصمها المصرف تنحسب مصروف «عمولة البطاقات».</small>
      {active.length > 0 && (
        <label>المصرف
          <select value={f.bankId ?? ""} onChange={(e) => setF({ ...f, bankId: e.target.value, gross: String(pendingOf(e.target.value) / 1000) })}>
            {active.map((b) => <option key={b.id} value={b.id}>🏦 {bankLabel(b)} (تحت التسوية {formatMoney(b.pendingCardMinor)})</option>)}
          </select>
        </label>
      )}
      <div className="row">
        <label style={{ flex: 1 }}>مبلغ البطاقات (د.ل)<input className="num" inputMode="decimal" value={f.gross} onChange={(e) => setF({ ...f, gross: e.target.value })} autoFocus /></label>
        <label style={{ flex: 1 }}>عمولة المصرف (د.ل)<input className="num" inputMode="decimal" value={f.fee} placeholder="0" onChange={(e) => setF({ ...f, fee: e.target.value })} /></label>
      </div>
      <div className="kpi"><span className="muted">ينزل في الحساب</span><b className="num">{formatMoney(Math.max(gross - fee, 0))}</b></div>
      <div className="row">
        <label style={{ flex: 1 }}>تاريخ التحويل<input type="date" value={f.onDate} max={today()} onChange={(e) => setF({ ...f, onDate: e.target.value })} /></label>
        <label style={{ flex: 2 }}>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={200} /></label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={gross <= 0 || fee >= gross} onClick={() => void save()}>تسجيل التسوية</button></div>
    </Modal>
  );
}

/** Adding a bank account, or changing one (name, number, main account, stopping it). */
function BankDialog({ call, bank, onClose, onDone }: { call: Call; bank: Partial<BankBox>; onClose: () => void; onDone: () => void }) {
  const isNew = !bank.id;
  const [f, setF] = useState({ bankName: bank.bankName ?? "", name: bank.name ?? "", accountNumber: bank.accountNumber ?? "", iban: bank.iban ?? "", opening: "", openingDate: today() });
  const [error, setError] = useState<string | null>(null);
  const run = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await call(isNew ? "/money/banks" : `/money/banks/${bank.id}`, { method: isNew ? "POST" : "PATCH", body });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fields = { bankName: f.bankName.trim(), name: f.name.trim() || null, accountNumber: f.accountNumber.trim() || null, iban: f.iban.trim() || null };
  return (
    <Modal title={isNew ? "حساب مصرفي جديد" : `تعديل ${bankLabel(bank as Bank)}`} onClose={onClose}>
      <label>المصرف
        <input list="bank-names" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} maxLength={80} autoFocus placeholder="مثلاً: مصرف الجمهورية" />
        <datalist id="bank-names">{["مصرف الجمهورية", "مصرف الوحدة", "مصرف التجارة والتنمية", "مصرف الصحاري", "مصرف شمال أفريقيا", "المصرف التجاري الوطني", "مصرف الأمان", "مصرف اليقين", "مصرف المتحد", "مصرف النوران"].map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      <label>اسم مختصر (اختياري)<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="مثلاً: فرع السوق، حساب الماكينة" /></label>
      <div className="row">
        <label style={{ flex: 1 }}>رقم الحساب<input className="num" dir="ltr" value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} maxLength={40} /></label>
        <label style={{ flex: 1 }}>IBAN<input className="num" dir="ltr" value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} maxLength={40} /></label>
      </div>
      {isNew && (
        <div className="row">
          <label style={{ flex: 1 }}>الرصيد الحالي في الحساب (اختياري)<input className="num" inputMode="decimal" value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value })} placeholder="0" /></label>
          <label style={{ flex: 1 }}>بتاريخ<input type="date" value={f.openingDate} max={today()} onChange={(e) => setF({ ...f, openingDate: e.target.value })} /></label>
        </div>
      )}
      {isNew && <small className="muted">أول حساب تضيفه يصير «الرئيسي»: أي تحويل أو بطاقة ما اختارتش مصرف تنزل فيه، والحركات القديمة تنحسب عليه.</small>}
      {!isNew && (
        <div className="row wrap">
          {bank.isDefault ? <span className="badge ok">هذا الحساب الرئيسي</span> : <button onClick={() => void run({ isDefault: true })}>⭐ اجعله الرئيسي</button>}
          {!bank.isDefault && <button className={bank.active ? "danger" : ""} onClick={() => void run({ active: !bank.active })}>{bank.active ? "إيقاف الحساب" : "تشغيل الحساب"}</button>}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button>
        <button className="primary" disabled={fields.bankName.length < 2}
          onClick={() => void run(isNew ? { ...fields, openingMinor: Number(f.opening) ? toMinor(Number(f.opening.replace(",", "."))) : undefined, openingDate: f.openingDate } : fields)}>حفظ</button>
      </div>
    </Modal>
  );
}

interface Rec { day: string; bookMinor: number; clearedMinor: number; openCount: number; history: { id: string; day: string; statement_minor: number; book_minor: number; cleared_minor: number; note: string | null; by: string | null }[] }

/**
 * Checking one bank account against the bank's statement: tick off each movement that shows on it,
 * write the statement's balance, and the difference is what is still to explain.
 */
function Reconcile({ call, bank, day: initial, tick, onSaved }: { call: Call; bank: Bank; day: string; tick: number; onSaved: () => void }) {
  const [day, setDay] = useState(initial);
  const [rec, setRec] = useState<Rec | null>(null);
  const [statement, setStatement] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => setDay(initial), [initial]);
  useEffect(() => void call<Rec>(`/money/reconciliations?bankId=${bank.id}&day=${day}`).then(setRec).catch((e) => setMsg({ text: (e as Error).message, bad: true })), [call, bank.id, day, tick]);
  const st = statement.trim() === "" ? null : toMinor(Number(statement.replace(",", ".")) || 0);
  const diff = rec && st !== null ? st - rec.clearedMinor : null;
  async function save() {
    if (st === null) return;
    setMsg(null);
    try {
      const r = await call<{ differenceMinor: number }>("/money/reconciliations", { body: { bankId: bank.id, statementDate: day, statementMinor: st, note: note || undefined } });
      setMsg({ text: r.differenceMinor === 0 ? "✓ انحفظت المطابقة: الحساب مطابق لكشف المصرف" : `انحفظت المطابقة بفرق ${formatMoney(r.differenceMinor)}` });
      setStatement("");
      setNote("");
      onSaved();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }
  return (
    <div className="card stack" style={{ background: "var(--bg-soft, transparent)" }}>
      <small className="muted">حط علامة ✓ على كل حركة طلعت في كشف المصرف، واكتب الرصيد اللي في الكشف. لو الفرق صفر يبقى الحساب مطابق؛ ولو فيه فرق، الحركات اللي بدون علامة هي اللي تفسره (صك ما انصرفش، عمولة ما تسجلتش…).</small>
      <div className="row wrap" style={{ alignItems: "end" }}>
        <label style={{ maxWidth: 170 }}>رصيد الكشف بتاريخ<input type="date" value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} /></label>
        <label style={{ maxWidth: 190 }}>الرصيد في كشف المصرف (د.ل)<input className="num" inputMode="decimal" value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="0.000" /></label>
        <label style={{ flex: 1, minWidth: 160 }}>ملاحظة<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
        <button className="primary" disabled={st === null} onClick={() => void save()}>حفظ المطابقة</button>
      </div>
      {rec && (
        <div className="kpis">
          <div className="kpi"><span className="muted">الرصيد في النظام</span><b className="num">{formatMoney(rec.bookMinor)}</b></div>
          <div className="kpi"><span className="muted">المُعلَّم عليه ✓</span><b className="num">{formatMoney(rec.clearedMinor)}</b></div>
          <div className="kpi"><span className="muted">حركات بدون علامة</span><b className="num">{rec.openCount}</b><small className="muted num">{formatMoney(rec.bookMinor - rec.clearedMinor)}</small></div>
          <div className="kpi"><span className="muted">الفرق مع الكشف</span>{diff === null ? <b className="muted">—</b> : diff === 0 ? <b className="ok">✓ مطابق</b> : <b className="num bad">{formatMoney(diff)}</b>}</div>
        </div>
      )}
      {msg && <div className={msg.bad ? "error" : "muted"}>{msg.text}</div>}
      {rec && rec.history.length > 0 && (
        <details>
          <summary>المطابقات السابقة ({rec.history.length})</summary>
          <table>
            <thead><tr><th>التاريخ</th><th>رصيد الكشف</th><th>في النظام</th><th>المُعلَّم عليه</th><th>الفرق</th><th>بواسطة</th></tr></thead>
            <tbody>
              {rec.history.map((h) => {
                const d = h.statement_minor - h.cleared_minor;
                return (
                  <tr key={h.id}>
                    <td className="num">{dmy(h.day)}{h.note && <div className="muted">{h.note}</div>}</td>
                    <td className="num">{formatMoney(h.statement_minor)}</td>
                    <td className="num">{formatMoney(h.book_minor)}</td>
                    <td className="num">{formatMoney(h.cleared_minor)}</td>
                    <td>{d === 0 ? <span className="badge ok">مطابق</span> : <span className="badge bad num">{formatMoney(d)}</span>}</td>
                    <td>{h.by ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button onClick={() => void printTable({
            title: `مطابقات ${bankLabel(bank)}`, sub: bank.accountNumber ? [`رقم الحساب ${bank.accountNumber}`] : [],
            header: ["التاريخ", "رصيد الكشف", "في النظام", "المُعلَّم عليه", "الفرق", "ملاحظة"],
            rows: rec.history.map((h) => [dmy(h.day), formatMoney(h.statement_minor), formatMoney(h.book_minor), formatMoney(h.cleared_minor), formatMoney(h.statement_minor - h.cleared_minor), h.note ?? ""]),
          })}>🖨 طباعة</button>
        </details>
      )}
    </div>
  );
}
