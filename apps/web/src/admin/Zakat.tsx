import { useEffect, useMemo, useState } from "react";
import { GREGORIAN_MONTHS, HIJRI_MONTHS, computeZakat, formatHijri, formatMoney, toMinor, type ZakatResult, type ZakatSettings } from "@pos/shared";
import type { Call } from "./Admin";
import { printSheet } from "./Counts";

interface Hawl { date: string; daysLeft: number; year: number; label: string }
interface StoreFig { id: string; name: string; costMinor: number; priceMinor: number; items: number; lastCountAt: string | null; openZakatCount: string | null }
interface Debtor { id: string; name: string; phone: string | null; balanceMinor: number; lastActivity: string | null }
interface Preview {
  settings: ZakatSettings; hawl: Hawl; stores: StoreFig[]; inventoryMinor: number; accounts: { cash: number; card: number; transfer: number }; cashMinor: number;
  customers: Debtor[]; receivablesMinor: number; suppliers: { id: string; name: string; balanceMinor: number }[]; payablesMinor: number;
}
interface Report {
  id: string; yearLabel: string; onDate: string; calendar: ZakatSettings["calendar"]; valuation: ZakatSettings["valuation"];
  inventoryMinor: number; cashMinor: number; receivablesMinor: number; otherAssetsMinor: number; payablesMinor: number; otherDebtsMinor: number;
  goldGramMinor: number; nisabGrams: number; baseMinor: number; rate: number; zakatMinor: number; note: string | null; createdByName: string | null;
  details: { hijri?: string; stores?: { name: string; costMinor: number; priceMinor: number; items: number; lastCountAt: string | null }[]; accounts?: Preview["accounts"]; excluded?: { name: string; balanceMinor: number }[]; nisabMinor?: number; reachesNisab?: boolean | null };
}

const VALUATION = { cost: "بسعر الشراء الحالي (الجملة)", price: "بسعر البيع للزبون" } as const;
const lyd = (s: string) => { const n = Number(s.replace(",", ".")); return s.trim() === "" || !(n >= 0) ? 0 : toMinor(n); };
const major = (m: number) => (m ? String(m / 1000) : "");
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-GB") : "—");
const daysAgo = (s: string | null) => (s ? Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000) : null);

/**
 * Zakat on the shop: when the year turns, a count made for it, and the sheet, worked out from what
 * the system already knows (stock, drawers and bank, customers' and suppliers' balances) plus what
 * only the owner knows (cash at home, debts that will not come back, today's gold price).
 */
export function Zakat({ call, open }: { call: Call; open: (tab: "counts") => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [edit, setEdit] = useState<ZakatSettings | null>(null);
  const [valuation, setValuation] = useState<ZakatSettings["valuation"]>("cost");
  const [gold, setGold] = useState("");
  const [otherAssets, setOtherAssets] = useState("");
  const [otherDebts, setOtherDebts] = useState("");
  const [note, setNote] = useState("");
  const [doubtful, setDoubtful] = useState<Set<string>>(new Set());
  const [showing, setShowing] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (v?: ZakatSettings["valuation"]) => {
    try {
      const r = await call<Preview>(`/zakat/preview${v ? `?valuation=${v}` : ""}`);
      setP(r);
      if (!v) {
        setValuation(r.settings.valuation);
        if (r.settings.goldGramMinor && !gold) setGold(major(r.settings.goldGramMinor));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadReports = () => call<Report[]>("/zakat/reports").then(setReports).catch(() => undefined);
  useEffect(() => { void load(); void loadReports(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const receivables = useMemo(() => (p ? p.customers.filter((c) => !doubtful.has(c.id)).reduce((a, c) => a + c.balanceMinor, 0) : 0), [p, doubtful]);
  const result = useMemo<ZakatResult | null>(() => p && computeZakat({
    inventoryMinor: p.inventoryMinor, cashMinor: p.cashMinor, receivablesMinor: receivables, otherAssetsMinor: lyd(otherAssets),
    payablesMinor: p.payablesMinor, otherDebtsMinor: lyd(otherDebts), goldGramMinor: lyd(gold), nisabGrams: p.settings.nisabGrams, calendar: p.settings.calendar,
  }), [p, receivables, otherAssets, otherDebts, gold]);

  async function saveSettings() {
    if (!edit) return;
    try {
      await call("/zakat/settings", { method: "PUT", body: edit });
      setEdit(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startCount(s: StoreFig) {
    if (s.openZakatCount) return open("counts");
    if (!confirm(`نبدأ جرد الزكاة في ${s.name}؟ العمال يقدروا يجردوا من تلفوناتهم في نفس الوقت، والبيع يكمل عادي.`)) return;
    try {
      await call("/counts", { body: { storeId: s.id, purpose: "zakat", note: `جرد الزكاة ${p?.hawl.year ?? ""}${p?.settings.calendar === "hijri" ? "هـ" : ""}` } });
      open("counts");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function sign() {
    if (!p || !result) return;
    if (!lyd(gold)) return setError("اكتب سعر جرام الذهب اليوم عشان نعرفوا النصاب");
    if (!confirm(`نحفظ ورقة زكاة هذا العام؟ الزكاة ${formatMoney(result.zakatMinor)}. الورقة تتحفظ كما هي عشان تقارن بيها السنين الجاية.`)) return;
    setBusy(true);
    try {
      const r = await call<{ id: string }>("/zakat/reports", {
        body: { valuation, goldGramMinor: lyd(gold), otherAssetsMinor: lyd(otherAssets), otherDebtsMinor: lyd(otherDebts), excludeCustomers: [...doubtful], note: note.trim() || undefined },
      });
      await loadReports();
      setShowing(await call<Report>(`/zakat/reports/${r.id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (showing) return <ReportView r={showing} onBack={() => setShowing(null)} onDelete={async () => {
    if (!confirm("نمسحوا الورقة هذه؟ المسح يتسجل في سجل العمليات.")) return;
    await call(`/zakat/reports/${showing.id}/delete`, { method: "POST" });
    setShowing(null);
    void loadReports();
  }} />;
  if (!p) return error ? <div className="error">{error}</div> : <div className="muted">جاري التحميل…</div>;
  const s = p.settings;

  return (
    <div className="stack">
      <div className="zakat-hawl">
        <div>
          <div className="muted">حول الزكاة</div>
          <div className="big num">{p.hawl.daysLeft === 0 ? "اليوم" : `${p.hawl.daysLeft} يوم`}</div>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <b>{p.hawl.label}{s.calendar === "hijri" ? ` · ${p.hawl.date}` : ""}</b>
          <span className="muted">اليوم {formatHijri(new Date())} · النسبة {s.calendar === "hijri" ? "2.5٪ (سنة هجرية)" : "2.577٪ (سنة ميلادية)"} · ينبهك قبلها بـ{s.remindDays} أيام</span>
        </div>
        <span className="spacer" />
        {!edit && <button onClick={() => setEdit({ ...s })}>⚙️ تغيير الموعد</button>}
      </div>

      {edit && (
        <div className="card stack">
          <b>موعد الحول وطريقة الحساب</b>
          <div className="seg">
            <button className={edit.calendar === "hijri" ? "active" : ""} onClick={() => setEdit({ ...edit, calendar: "hijri" })}>سنة هجرية (2.5٪)</button>
            <button className={edit.calendar === "gregorian" ? "active" : ""} onClick={() => setEdit({ ...edit, calendar: "gregorian" })}>سنة ميلادية (2.577٪)</button>
          </div>
          <div className="count-form">
            <label>الشهر
              <select value={edit.month} onChange={(e) => setEdit({ ...edit, month: Number(e.target.value) })}>
                {(edit.calendar === "hijri" ? HIJRI_MONTHS : GREGORIAN_MONTHS).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </label>
            <label>اليوم
              <input className="num" type="number" min={1} max={30} value={edit.day} onChange={(e) => setEdit({ ...edit, day: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })} />
            </label>
            <label>تقييم البضاعة
              <select value={edit.valuation} onChange={(e) => setEdit({ ...edit, valuation: e.target.value as ZakatSettings["valuation"] })}>
                <option value="cost">{VALUATION.cost}</option>
                <option value="price">{VALUATION.price}</option>
              </select>
            </label>
            <label>النصاب (جرام ذهب)
              <input className="num" type="number" min={1} value={edit.nisabGrams} onChange={(e) => setEdit({ ...edit, nisabGrams: Math.max(1, Number(e.target.value) || 85) })} />
            </label>
            <label>نبهني قبلها بكم يوم
              <input className="num" type="number" min={0} max={60} value={edit.remindDays} onChange={(e) => setEdit({ ...edit, remindDays: Math.min(60, Math.max(0, Number(e.target.value) || 0)) })} />
            </label>
          </div>
          <div className="row"><span className="spacer" /><button className="ghost" onClick={() => setEdit(null)}>إلغاء</button><button className="primary" onClick={() => void saveSettings()}>حفظ</button></div>
        </div>
      )}

      <div className="card stack">
        <b>1. جرد المحل للزكاة</b>
        <span className="muted">الزكاة تنحسب على البضاعة الموجودة فعلاً، فالأحسن تجرد المحل قريب من يوم الحول. الجرد يتم والمحل شغال، وأكثر من عامل يجردوا من تلفوناتهم.</span>
        {p.stores.map((st) => {
          const ago = daysAgo(st.lastCountAt);
          return (
            <div className="row" key={st.id}>
              <b>{st.name}</b>
              <span className="muted">{st.items} صنف عنده رصيد · آخر جرد مطبّق: {st.lastCountAt ? `${shortDate(st.lastCountAt)} (قبل ${ago} يوم)` : "ما فيش"}</span>
              {(ago === null || ago > 30) && <span className="badge warn">يبيله جرد</span>}
              <span className="spacer" />
              <button className={st.openZakatCount ? "" : "primary"} onClick={() => void startCount(st)}>{st.openZakatCount ? "كمّل جرد الزكاة" : "🕌 ابدأ جرد الزكاة"}</button>
            </div>
          );
        })}
      </div>

      <div className="zakat-grid">
        <div className="card stack">
          <b>2. اللي عندك واللي عليك</b>
          <label>تقييم البضاعة
            <div className="seg">
              {(["cost", "price"] as const).map((v) => <button key={v} className={valuation === v ? "active" : ""} onClick={() => { setValuation(v); void load(v); }}>{VALUATION[v]}</button>)}
            </div>
          </label>
          <label>سعر جرام الذهب اليوم (د.ل)
            <input className="num" inputMode="decimal" value={gold} placeholder="مثلاً 650" onChange={(e) => setGold(e.target.value)} />
          </label>
          <label>فلوس أو بضاعة تجارة برا النظام (د.ل)
            <input className="num" inputMode="decimal" value={otherAssets} placeholder="مثلاً كاش في الحوش، مصرف ثاني" onChange={(e) => setOtherAssets(e.target.value)} />
          </label>
          <label>ديون عليك برا النظام ومستحقة الآن (د.ل)
            <input className="num" inputMode="decimal" value={otherDebts} placeholder="مثلاً إيجار متأخر، قرض قسطه حال" onChange={(e) => setOtherDebts(e.target.value)} />
          </label>
          {p.customers.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <b style={{ fontSize: ".95rem" }}>ديون الزبائن: شيل الصح على اللي ما ترجاش ترجع</b>
              <div className="zakat-debts">
                {p.customers.map((c) => {
                  const ago = daysAgo(c.lastActivity);
                  return (
                    <label key={c.id} className="check">
                      <input type="checkbox" checked={!doubtful.has(c.id)} onChange={(e) => { const n = new Set(doubtful); if (e.target.checked) n.delete(c.id); else n.add(c.id); setDoubtful(n); }} />
                      <span>{c.name} <b className="num">{formatMoney(c.balanceMinor)}</b>{ago !== null && ago > 180 && <span className="muted"> · ما تحركش من {ago} يوم</span>}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <label>ملاحظة (اختياري)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <div className="card stack">
          <b>3. ورقة الزكاة</b>
          {result && (
            <Sheet
              inventoryMinor={p.inventoryMinor} valuation={valuation} stores={p.stores.map((x) => ({ name: x.name, minor: valuation === "cost" ? x.costMinor : x.priceMinor }))}
              cashMinor={p.cashMinor} accounts={p.accounts} receivablesMinor={receivables} excludedMinor={p.customers.filter((c) => doubtful.has(c.id)).reduce((a, c) => a + c.balanceMinor, 0)}
              otherAssetsMinor={lyd(otherAssets)} payablesMinor={p.payablesMinor} otherDebtsMinor={lyd(otherDebts)}
              baseMinor={result.baseMinor} nisabMinor={result.nisabMinor} nisabGrams={s.nisabGrams} reachesNisab={result.reachesNisab} rate={result.rate} zakatMinor={result.zakatMinor}
            />
          )}
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy} onClick={() => void sign()}>✓ احفظ ورقة زكاة هذا العام</button>
          <span className="muted" style={{ fontSize: ".85rem" }}>
            الحساب على المذهب المعمول بيه في عروض التجارة: البضاعة والنقد والديون المرجوة، ناقص الديون الحالّة، والأصول الثابتة زي الثلاجات والرفوف ما تدخلش. لو عندك حالة خاصة راجع شيخ أو دار الإفتاء.
          </span>
        </div>
      </div>

      {reports.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table>
            <thead><tr><th>العام</th><th>التاريخ</th><th>الوعاء</th><th>الزكاة</th><th /></tr></thead>
            <tbody>
              {reports.map((r, i) => {
                const prev = reports[i + 1];
                return (
                  <tr key={r.id}>
                    <td><b>{r.yearLabel}</b></td>
                    <td className="num">{r.onDate}<div className="muted">{r.details.hijri}</div></td>
                    <td className="num">{formatMoney(r.baseMinor)}{prev && prev.baseMinor > 0 && <div className={`muted ${r.baseMinor >= prev.baseMinor ? "diff-up" : "diff-down"}`}>{r.baseMinor >= prev.baseMinor ? "▲" : "▼"} {Math.abs(Math.round(((r.baseMinor - prev.baseMinor) / prev.baseMinor) * 100))}٪</div>}</td>
                    <td className="num"><b>{formatMoney(r.zakatMinor)}</b></td>
                    <td><button onClick={() => setShowing(r)}>عرض وطباعة</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SheetProps {
  inventoryMinor: number; valuation: ZakatSettings["valuation"]; stores: { name: string; minor: number }[];
  cashMinor: number; accounts?: Preview["accounts"]; receivablesMinor: number; excludedMinor: number; otherAssetsMinor: number;
  payablesMinor: number; otherDebtsMinor: number; baseMinor: number; nisabMinor: number; nisabGrams: number; reachesNisab: boolean | null; rate: number; zakatMinor: number;
}

function Sheet(x: SheetProps) {
  const pct = `${x.rate / 1000}٪`;
  return (
    <div className="zakat-sheet">
      <div><span>البضاعة {x.valuation === "cost" ? "(بسعر الشراء)" : "(بسعر البيع)"}</span><b className="num">{formatMoney(x.inventoryMinor)}</b></div>
      {x.stores.length > 1 && x.stores.map((s) => <div className="sub" key={s.name}><span>{s.name}</span><span className="num">{formatMoney(s.minor)}</span></div>)}
      <div><span>النقد في الخزينة والمصرف</span><b className="num">{formatMoney(x.cashMinor)}</b></div>
      {x.accounts && <div className="sub"><span>درج {formatMoney(x.accounts.cash)} · بطاقات {formatMoney(x.accounts.card)} · تحويلات {formatMoney(x.accounts.transfer)}</span></div>}
      <div><span>ديون الزبائن المرجوة</span><b className="num">{formatMoney(x.receivablesMinor)}</b></div>
      {x.excludedMinor > 0 && <div className="sub"><span>ديون ما ترجاش (ما تدخلش)</span><span className="num">{formatMoney(x.excludedMinor)}</span></div>}
      {x.otherAssetsMinor > 0 && <div><span>أموال تجارة أخرى</span><b className="num">{formatMoney(x.otherAssetsMinor)}</b></div>}
      <div><span>ناقص: ديون الموردين</span><b className="num diff-down">−{formatMoney(x.payablesMinor)}</b></div>
      {x.otherDebtsMinor > 0 && <div><span>ناقص: ديون أخرى حالّة</span><b className="num diff-down">−{formatMoney(x.otherDebtsMinor)}</b></div>}
      <div className="total"><span>الوعاء الزكوي</span><span className="num">{formatMoney(x.baseMinor)}</span></div>
      <div><span>النصاب ({x.nisabGrams} جرام ذهب)</span><span className="num">{x.nisabMinor ? formatMoney(x.nisabMinor) : "اكتب سعر الذهب"}</span></div>
      <div style={{ borderBottom: 0, alignItems: "center" }}>
        <span>{x.reachesNisab === false ? "ما وصلش النصاب: ما عليكش زكاة هذا العام" : `الزكاة (${pct})`}</span>
        <span className="zakat-due num">{formatMoney(x.zakatMinor)}</span>
      </div>
    </div>
  );
}

function ReportView({ r, onBack, onDelete }: { r: Report; onBack: () => void; onDelete: () => void }) {
  const d = r.details;
  return (
    <div className="stack printable">
      <div className="row">
        <button className="ghost no-print" onClick={onBack}>→ رجوع</button>
        <b>🕌 ورقة زكاة {r.yearLabel}</b>
        <span className="spacer" />
        <button className="ghost no-print" onClick={printSheet}>🖨️ طباعة</button>
        <button className="danger no-print" onClick={onDelete}>مسح</button>
      </div>
      <div className="card stack">
        <span className="muted">{r.onDate}{d.hijri ? ` — ${d.hijri}` : ""} · {VALUATION[r.valuation]} · سعر جرام الذهب {formatMoney(r.goldGramMinor)}{r.createdByName ? ` · ${r.createdByName}` : ""}</span>
        <Sheet
          inventoryMinor={r.inventoryMinor} valuation={r.valuation} stores={(d.stores ?? []).map((s) => ({ name: s.name, minor: r.valuation === "cost" ? s.costMinor : s.priceMinor }))}
          cashMinor={r.cashMinor} accounts={d.accounts} receivablesMinor={r.receivablesMinor} excludedMinor={(d.excluded ?? []).reduce((a, c) => a + c.balanceMinor, 0)}
          otherAssetsMinor={r.otherAssetsMinor} payablesMinor={r.payablesMinor} otherDebtsMinor={r.otherDebtsMinor} baseMinor={r.baseMinor}
          nisabMinor={d.nisabMinor ?? r.goldGramMinor * r.nisabGrams} nisabGrams={r.nisabGrams} reachesNisab={d.reachesNisab ?? null} rate={r.rate} zakatMinor={r.zakatMinor}
        />
        {(d.excluded ?? []).length > 0 && <span className="muted">ديون ما دخلتش: {d.excluded!.map((c) => `${c.name} (${formatMoney(c.balanceMinor)})`).join("، ")}</span>}
        {(d.stores ?? []).length > 0 && <span className="muted">آخر جرد: {d.stores!.map((s) => `${s.name} ${shortDate(s.lastCountAt)}`).join("، ")}</span>}
        {r.note && <span>ملاحظة: {r.note}</span>}
      </div>
    </div>
  );
}
