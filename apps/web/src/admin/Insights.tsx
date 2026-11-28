// The deeper reports on 📊 التقارير: the whole picture on one page (print / WhatsApp), customers,
// debts by age, expenses month by month, what items really earn, suppliers, discounts and
// cancelled carts, branches side by side, the month's forecast, and the summary on the phone.
import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, waLink, type ReportDigest, type ReportFav } from "@pos/shared";
import type { Call } from "./Admin";
import { BarChart, RankBars, TimeChart, downloadCsv } from "./charts";
import { Delta, Kpi, PRESETS, Panel, changePct, compareRange, dinars, dmy, escHtml, money, pct, printHtml } from "./reportKit";

interface Ctx { call: Call; storeId?: string; from: string; to: string; prev: [string, string] | null; shopName: string; storeName: string }
const qs = (o: Record<string, string | undefined>) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");

function useLoad<T>(path: string | null, call: Call): { d: T | null; error: string | null; reload: () => void } {
  const [d, setD] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setD(null);
    setError(null);
    call<T>(path).then((x) => live && setD(x)).catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [path, call, tick]);
  return { d, error, reload: () => setTick((t) => t + 1) };
}
const Loading = ({ error }: { error: string | null }) => (error ? <div className="error">{error}</div> : <div className="muted">جاري التحميل…</div>);

// ───────────────────────────── 2. the full report ─────────────────────────────
interface Totals { salesCount: number; totalMinor: number; profitMinor: number; expensesMinor: number; netMinor: number; avgMinor: number }
interface PeriodLite {
  summary: { salesCount: number; returnsCount: number; returnsMinor: number; totalMinor: number; discountMinor: number; promoMinor: number; grossProfitMinor: number; expensesMinor: number; netProfitMinor: number; avgMinor: number };
  byMethod: Record<string, number>; expenses: { category: string; amount_minor: number }[];
  byCategory: { name: string; icon: string | null; total_minor: number; profit_minor: number }[];
  topProducts: { name: string; total_minor: number; profit_minor: number }[];
  purchases: { bySupplier: { total_minor: number; paid_minor: number }[] };
  credit: { givenMinor: number; collectedMinor: number };
}
interface Full {
  now: PeriodLite; was: PeriodLite | null;
  inventory: { costValueMinor: number; retailValueMinor: number; outOfStock: number; items: number };
  debts: { totalMinor: number; customers: number; totals: number[] };
  suppliers: { owedMinor: number };
  money: { totalMinor: number } | null;
  loans: { totals: { lentMinor: number; heldMinor: number } } | null;
  customers: { summary: { customers: number; newCustomers: number; walkInMinor: number } };
}

export function FullReport(c: Ctx) {
  const [d, setD] = useState<Full | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    setError(null);
    const s = c.storeId ? `&storeId=${c.storeId}` : "";
    Promise.all([
      c.call<PeriodLite>(`/reports/period?from=${c.from}&to=${c.to}${s}`),
      c.prev ? c.call<PeriodLite>(`/reports/period?from=${c.prev[0]}&to=${c.prev[1]}${s}`) : Promise.resolve(null),
      c.call<Full["inventory"]>(`/reports/inventory${c.storeId ? `?storeId=${c.storeId}` : ""}`),
      c.call<Full["debts"]>("/reports/debts"),
      c.call<Full["suppliers"]>(`/reports/suppliers?from=${c.from}&to=${c.to}${s}`),
      c.call<Full["money"]>("/money/summary").catch(() => null),
      c.call<Full["loans"]>("/loans?status=open").catch(() => null),
      c.call<Full["customers"]>(`/reports/customers?from=${c.from}&to=${c.to}${s}`),
    ]).then(([now, was, inventory, debts, suppliers, money, loans, customers]) => live && setD({ now, was, inventory, debts, suppliers, money, loans, customers }))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [c.call, c.storeId, c.from, c.to, c.prev?.[0], c.prev?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Loading error={error} />;
  const s = d.now.summary, w = d.was?.summary;
  const bought = d.now.purchases.bySupplier.reduce((a, x) => a + x.total_minor, 0);
  const rows: [string, number, number | undefined, boolean?][] = [
    ["صافي المبيعات", s.totalMinor, w?.totalMinor],
    ["عدد الفواتير", s.salesCount, w?.salesCount],
    ["متوسط الفاتورة", s.avgMinor, w?.avgMinor],
    ["إجمالي الربح", s.grossProfitMinor, w?.grossProfitMinor],
    ["المصروفات", s.expensesMinor, w?.expensesMinor, true],
    ["صافي الربح", s.netProfitMinor, w?.netProfitMinor],
    ["المرتجعات", s.returnsMinor, w?.returnsMinor, true],
    ["الخصومات والعروض", s.discountMinor + s.promoMinor, w ? w.discountMinor + w.promoMinor : undefined, true],
    ["بيع آجل", d.now.credit.givenMinor, d.was?.credit.givenMinor, true],
    ["تحصيل ديون", d.now.credit.collectedMinor, d.was?.credit.collectedMinor],
  ];
  const isCount = (label: string) => label === "عدد الفواتير";
  const fmt = (label: string, v: number) => (isCount(label) ? String(v) : money(v));
  const period = c.from === c.to ? dmy(c.from) : `من ${dmy(c.from)} إلى ${dmy(c.to)}`;
  const vs = c.prev ? `مقارنة مع ${c.prev[0] === c.prev[1] ? dmy(c.prev[0]) : `${dmy(c.prev[0])} - ${dmy(c.prev[1])}`}` : "";
  const standing: [string, number][] = [
    ["الفلوس عندك الآن (الخزينة والمصارف)", d.money?.totalMinor ?? 0],
    ["قيمة البضاعة بالتكلفة", d.inventory.costValueMinor],
    ["قيمة البضاعة بالبيع", d.inventory.retailValueMinor],
    ["ديون على الزبائن", d.debts.totalMinor],
    ["عليك للموردين", d.suppliers.owedMinor],
    ...(d.loans ? [["سلف برّا", d.loans.totals.lentMinor], ["أمانات عندك", d.loans.totals.heldMinor]] as [string, number][] : []),
  ];

  function text() {
    if (!d) return "";
    const line = (l: string, v: number, was?: number) => {
      const p = was !== undefined ? changePct(v, was) : null;
      return `• ${l}: ${fmt(l, v)}${p !== null ? ` (${p >= 0 ? "▲" : "▼"} ${Math.abs(p)}%)` : ""}`;
    };
    return [
      `📊 تقرير ${c.shopName}${c.storeName ? ` - ${c.storeName}` : ""}`, period, vs, "",
      ...rows.slice(0, 7).map(([l, v, was]) => line(l, v, was)), "",
      ...standing.map(([l, v]) => `• ${l}: ${money(v)}`),
      "", `الزبائن: ${d.customers.summary.customers} (جداد ${d.customers.summary.newCustomers})`,
    ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
  }
  function print() {
    if (!d) return;
    const tr = (l: string, v: number, was?: number, low?: boolean) => {
      const p = was !== undefined ? changePct(v, was) : null;
      const good = p !== null && (low ? p <= 0 : p >= 0);
      return `<tr><td>${escHtml(l)}</td><td class="num">${fmt(l, v)}</td>${c.prev ? `<td class="num">${was !== undefined ? fmt(l, was) : ""}</td><td class="num ${p === null ? "muted" : good ? "ok" : "bad"}">${p === null ? "—" : `${p >= 0 ? "▲" : "▼"} ${Math.abs(p)}%`}</td>` : ""}</tr>`;
    };
    printHtml(`تقرير ${period}`, `
      <h1>📊 التقرير الشامل · ${escHtml(c.shopName)}${c.storeName ? ` · ${escHtml(c.storeName)}` : ""}</h1>
      <div class="sub">${period}${vs ? ` · ${vs}` : ""}</div>
      <h2>المبيعات والأرباح</h2>
      <table><thead><tr><th>البند</th><th class="num">الفترة</th>${c.prev ? '<th class="num">المقارنة</th><th class="num">التغير</th>' : ""}</tr></thead>
      <tbody>${rows.map(([l, v, was, low]) => tr(l, v, was, low)).join("")}</tbody></table>
      <h2>المصروفات</h2>
      <table><tbody>${d.now.expenses.map((e) => `<tr><td>${escHtml(e.category)}</td><td class="num">${money(e.amount_minor)}</td><td class="num muted">${pct(e.amount_minor, s.totalMinor)} من المبيعات</td></tr>`).join("") || '<tr><td class="muted">ما فيش مصروفات</td></tr>'}</tbody></table>
      <h2>الأقسام الأكثر مبيعاً</h2>
      <table><tbody>${d.now.byCategory.slice(0, 8).map((x) => `<tr><td>${escHtml(`${x.icon ?? ""} ${x.name}`)}</td><td class="num">${money(x.total_minor)}</td><td class="num muted">ربح ${money(x.profit_minor)}</td></tr>`).join("")}</tbody></table>
      <h2>أعلى الأصناف</h2>
      <table><tbody>${d.now.topProducts.slice(0, 10).map((x) => `<tr><td>${escHtml(x.name)}</td><td class="num">${money(x.total_minor)}</td><td class="num muted">ربح ${money(x.profit_minor)}</td></tr>`).join("")}</tbody></table>
      <h2>وضع المحل الآن</h2>
      <div class="grid">${standing.map(([l, v]) => `<div class="tile">${escHtml(l)}<b>${money(v)}</b></div>`).join("")}<div class="tile">المشتريات في الفترة<b>${money(bought)}</b></div></div>
      <p class="muted">طُبع ${new Date().toLocaleString("ar-LY")}</p>`);
  }

  return (
    <>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="muted">{period}{vs && ` · ${vs}`}</span>
        <span className="spacer" />
        <button onClick={print}>🖨 اطبع / PDF</button>
        <a className="button" href={waLink(null, text())} target="_blank" rel="noreferrer">📲 ابعته واتساب</a>
      </div>
      <div className="kpis">
        <Kpi label="صافي المبيعات" value={money(s.totalMinor)} now={s.totalMinor} was={w?.totalMinor} note={`${s.salesCount} فاتورة`} />
        <Kpi label="إجمالي الربح" value={money(s.grossProfitMinor)} now={s.grossProfitMinor} was={w?.grossProfitMinor} tone="ok" note={`هامش ${pct(s.grossProfitMinor, s.totalMinor)}`} />
        <Kpi label="المصروفات" value={money(s.expensesMinor)} now={s.expensesMinor} was={w?.expensesMinor} lowerIsBetter />
        <Kpi label="صافي الربح" value={money(s.netProfitMinor)} now={s.netProfitMinor} was={w?.netProfitMinor} tone={s.netProfitMinor < 0 ? "bad" : "ok"} />
      </div>
      <Panel title="البنود" onCsv={() => downloadCsv(`تقرير-شامل-${c.from}-${c.to}`, ["البند", "الفترة", ...(c.prev ? ["المقارنة", "التغير"] : [])], rows.map(([l, v, was]) => [l, isCount(l) ? v : dinars(v), ...(c.prev ? [was === undefined ? "" : isCount(l) ? was : dinars(was), `${changePct(v, was ?? 0) ?? ""}%`] : [])]))}>
        <table>
          <thead><tr><th>البند</th><th>الفترة</th>{c.prev && <><th>المقارنة</th><th>التغير</th></>}</tr></thead>
          <tbody>{rows.map(([l, v, was, low]) => (
            <tr key={l}><td>{l}</td><td className="num">{fmt(l, v)}</td>{c.prev && <><td className="num muted">{was !== undefined ? fmt(l, was) : ""}</td><td><Delta now={v} then={was} lowerIsBetter={low} /></td></>}</tr>
          ))}</tbody>
        </table>
      </Panel>
      <Panel title="وضع المحل الآن">
        <div className="kpis">
          {standing.map(([l, v]) => <Kpi key={l} label={l} value={money(v)} />)}
          <Kpi label="المشتريات في الفترة" value={money(bought)} />
          <Kpi label="الزبائن في الفترة" value={String(d.customers.summary.customers)} note={`جداد ${d.customers.summary.newCustomers}`} />
        </div>
      </Panel>
    </>
  );
}

// ───────────────────────────── 3. customers ─────────────────────────────
interface Customers {
  summary: { customers: number; newCustomers: number; returning: number; namedMinor: number; walkInMinor: number; walkInCount: number; visitsPerCustomer: number; daysBetweenVisits: number | null };
  top: { id: string; name: string; phone: string | null; visits: number; totalMinor: number; profitMinor: number; avgMinor: number; lastDay: string; firstDay: string | null; balanceMinor: number; isNew: boolean }[];
  lapsed: { id: string; name: string; phone: string | null; visits: number; totalMinor: number; lastDay: string; daysAway: number }[];
}
export function CustomersReport(c: Ctx) {
  const [lapsedDays, setLapsedDays] = useState(30);
  const [only, setOnly] = useState<"all" | "new" | "back">("all");
  const s = c.storeId;
  const { d, error } = useLoad<Customers>(`/reports/customers?${qs({ from: c.from, to: c.to, storeId: s, lapsedDays: String(lapsedDays) })}`, c.call);
  const p = useLoad<Customers>(c.prev ? `/reports/customers?${qs({ from: c.prev[0], to: c.prev[1], storeId: s })}` : null, c.call).d;
  if (!d) return <Loading error={error} />;
  const sum = d.summary, ps = c.prev ? p?.summary : undefined;
  const rows = d.top.filter((x) => only === "all" || (only === "new" ? x.isNew : !x.isNew));
  const share = sum.namedMinor + sum.walkInMinor;
  return (
    <>
      <div className="kpis">
        <Kpi label="زبائن اشتروا باسمهم" value={String(sum.customers)} note={ps ? <>كانوا {ps.customers} <Delta now={sum.customers} then={ps.customers} /></> : undefined} />
        <Kpi label="زبائن جداد" value={String(sum.newCustomers)} note={ps ? <>كانوا {ps.newCustomers} <Delta now={sum.newCustomers} then={ps.newCustomers} /></> : "أول مرة يشروا"} />
        <Kpi label="رجعوا يشروا" value={String(sum.returning)} />
        <Kpi label="مبيعات بدون اسم زبون" value={money(sum.walkInMinor)} note={`${sum.walkInCount} فاتورة · ${pct(sum.walkInMinor, share)} من المبيعات`} />
        <Kpi label="زيارات كل زبون" value={String(sum.visitsPerCustomer)} note={sum.daysBetweenVisits ? `يرجع كل ${sum.daysBetweenVisits} يوم تقريباً` : undefined} />
      </div>
      <Panel title="أحسن الزبائن" extra={
        <div className="seg">
          {(["all", "new", "back"] as const).map((k) => <button key={k} className={only === k ? "active" : ""} onClick={() => setOnly(k)}>{k === "all" ? "الكل" : k === "new" ? "الجداد" : "الراجعين"}</button>)}
        </div>
      } onCsv={() => downloadCsv(`زبائن-${c.from}-${c.to}`, ["الزبون", "التلفون", "الزيارات", "المشتريات", "الربح", "متوسط الفاتورة", "آخر شراء", "أول شراء", "عليه"], rows.map((x) => [x.name, x.phone ?? "", x.visits, dinars(x.totalMinor), dinars(x.profitMinor), dinars(x.avgMinor), x.lastDay, x.firstDay ?? "", dinars(x.balanceMinor)]))}>
        <table>
          <thead><tr><th>#</th><th>الزبون</th><th>الزيارات</th><th>المشتريات</th><th>الربح</th><th>متوسط الفاتورة</th><th>آخر شراء</th><th>عليه</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="muted">ما فيش زبائن بأسمائهم في الفترة هذي.</td></tr>}
            {rows.slice(0, 100).map((x, i) => (
              <tr key={x.id}>
                <td className="num muted">{i + 1}</td>
                <td>{x.name}{x.isNew && <span className="badge ok" style={{ marginInlineStart: 6 }}>جديد</span>}<div className="muted num" style={{ fontSize: ".8em" }}>{x.phone}</div></td>
                <td className="num">{x.visits}</td><td className="num">{money(x.totalMinor)}</td><td className="num">{money(x.profitMinor)}</td>
                <td className="num">{money(x.avgMinor)}</td><td className="num">{dmy(x.lastDay)}</td><td className="num">{x.balanceMinor > 0 ? money(x.balanceMinor) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="زبائن بطّلوا يجوا" extra={
        <select value={lapsedDays} onChange={(e) => setLapsedDays(Number(e.target.value))} style={{ width: "auto" }} aria-label="من كم يوم">
          {[30, 60, 90].map((n) => <option key={n} value={n}>من أكثر من {n} يوم</option>)}
        </select>
      } onCsv={() => downloadCsv("زبائن-بطلوا", ["الزبون", "التلفون", "الزيارات", "المشتريات", "آخر شراء", "أيام الغياب"], d.lapsed.map((x) => [x.name, x.phone ?? "", x.visits, dinars(x.totalMinor), x.lastDay, x.daysAway]))}>
        <div className="muted" style={{ fontSize: ".9em" }}>زبائن شروا مرتين أو أكثر، وما رجعوش. رسالة صغيرة تقدر ترجّعهم.</div>
        <table>
          <thead><tr><th>الزبون</th><th>اشترى</th><th>مجموع مشترياته</th><th>آخر مرة</th><th></th></tr></thead>
          <tbody>
            {d.lapsed.length === 0 && <tr><td colSpan={5} className="muted">ما فيش. كل زبائنك يرجعوا 👌</td></tr>}
            {d.lapsed.map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td><td className="num">{x.visits} مرات</td><td className="num">{money(x.totalMinor)}</td><td className="num">{dmy(x.lastDay)} <span className="muted">({x.daysAway} يوم)</span></td>
                <td>{x.phone && <a className="button" href={waLink(x.phone, `السلام عليكم ${x.name}، وحشتنا في ${c.shopName} 🌹 عندنا بضاعة جديدة ونستنوا فيك.`)} target="_blank" rel="noreferrer">📲</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 4. debts by age ─────────────────────────────
interface Debts {
  buckets: string[]; totals: number[]; totalMinor: number; customers: number;
  rows: { id: string; name: string; phone: string | null; balanceMinor: number; limitMinor: number | null; buckets: number[]; oldestDay: string | null; oldestDays: number; lastPaid: string | null }[];
  collected: { amountMinor: number; count: number; givenMinor: number } | null;
}
const BUCKET_LABELS = ["أقل من 30 يوم", "30 لـ 60 يوم", "60 لـ 90 يوم", "أكثر من 90 يوم"];
export function DebtsReport(c: Ctx) {
  const { d, error } = useLoad<Debts>(`/reports/debts?from=${c.from}&to=${c.to}`, c.call);
  const p = useLoad<Debts>(c.prev ? `/reports/debts?from=${c.prev[0]}&to=${c.prev[1]}` : null, c.call).d;
  const [bucket, setBucket] = useState<number | null>(null);
  if (!d) return <Loading error={error} />;
  const rows = bucket === null ? d.rows : d.rows.filter((r) => r.buckets[bucket] > 0);
  return (
    <>
      <div className="kpis">
        <Kpi label="مجموع الديون على الزبائن" value={money(d.totalMinor)} note={`${d.customers} زبون`} />
        {d.collected && <Kpi label="تحصّل في الفترة" value={money(d.collected.amountMinor)} tone="ok" note={`${d.collected.count} دفعة`} now={d.collected.amountMinor} was={c.prev ? p?.collected?.amountMinor : undefined} />}
        {d.collected && <Kpi label="بيع آجل في الفترة" value={money(d.collected.givenMinor)} now={d.collected.givenMinor} was={c.prev ? p?.collected?.givenMinor : undefined} lowerIsBetter />}
      </div>
      <Panel title="الديون حسب المدة">
        <div className="aging">
          {d.totals.map((v, i) => (
            <button key={i} className={`aging-cell b${i} ${bucket === i ? "active" : ""}`} onClick={() => setBucket(bucket === i ? null : i)}>
              <span className="muted">{BUCKET_LABELS[i]}</span><b className="num">{money(v)}</b><small className="muted">{pct(v, d.totalMinor)}</small>
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: ".85em" }}>الدفعات تسدّد الأقدم أولاً، فالباقي هو آخر بيع آجل. اضغط على مدة باش تشوف زبائنها بس.</div>
      </Panel>
      <Panel title={bucket === null ? "كل الزبائن اللي عليهم" : `عليهم ديون ${BUCKET_LABELS[bucket]}`} onCsv={() => downloadCsv("ديون-حسب-المدة", ["الزبون", "التلفون", "الدين", ...BUCKET_LABELS, "أقدم دين", "آخر دفعة"], rows.map((r) => [r.name, r.phone ?? "", dinars(r.balanceMinor), ...r.buckets.map(dinars), r.oldestDay ?? "", r.lastPaid ?? ""]))}>
        <table>
          <thead><tr><th>الزبون</th><th>الدين</th>{BUCKET_LABELS.map((l) => <th key={l}>{l}</th>)}<th>آخر دفعة</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="muted">ما فيش ديون 👌</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}{r.limitMinor !== null && r.balanceMinor > r.limitMinor && <span className="badge bad" style={{ marginInlineStart: 6 }}>فوق الحد</span>}</td>
                <td className="num"><b>{money(r.balanceMinor)}</b></td>
                {r.buckets.map((v, i) => <td key={i} className={`num ${i >= 2 && v > 0 ? "bad" : ""}`}>{v ? money(v) : ""}</td>)}
                <td className="num">{r.lastPaid ? dmy(r.lastPaid) : <span className="muted">ما دفعش</span>}</td>
                <td>{r.phone && <a className="button" href={waLink(r.phone, `السلام عليكم ${r.name}، نذكّركم بالحساب اللي عند ${c.shopName}: ${formatMoney(r.balanceMinor)}. شكراً لتعاملكم معنا 🌹`)} target="_blank" rel="noreferrer">📲</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 5. expenses month by month ─────────────────────────────
interface ExpensesData {
  months: string[]; categories: { name: string; byMonth: number[]; totalMinor: number; count: number }[];
  totalByMonth: number[]; salesByMonth: number[]; profitByMonth: number[];
  jumps: { category: string; nowMinor: number; avgMinor: number; pct: number }[];
}
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const monthName = (m: string, short = false) => `${MONTHS[Number(m.slice(5, 7)) - 1]}${short ? "" : ` ${m.slice(0, 4)}`}`;
export function ExpensesReport(c: Ctx) {
  const [months, setMonths] = useState(6);
  const { d, error } = useLoad<ExpensesData>(`/reports/expenses?${qs({ months: String(months), storeId: c.storeId, to: c.to.slice(0, 7) })}`, c.call);
  if (!d) return <Loading error={error} />;
  const k = d.months.length - 1;
  const total = d.totalByMonth.reduce((a, v) => a + v, 0);
  const sales = d.salesByMonth.reduce((a, v) => a + v, 0);
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <span className="muted">لين شهر {monthName(d.months[k])}</span><span className="spacer" />
        <div className="seg">{[3, 6, 12].map((n) => <button key={n} className={months === n ? "active" : ""} onClick={() => setMonths(n)}>{n} شهور</button>)}</div>
      </div>
      {d.jumps.map((j) => (
        <div key={j.category} className="announce warn">⚠️ مصروف «{j.category}» الشهر هذا {money(j.nowMinor)}، زايد {j.pct}% على متوسط آخر 3 شهور ({money(j.avgMinor)}).</div>
      ))}
      <div className="kpis">
        <Kpi label={`مصروفات ${monthName(d.months[k], true)}`} value={money(d.totalByMonth[k])} now={d.totalByMonth[k]} was={k > 0 ? d.totalByMonth[k - 1] : undefined} wasLabel="الشهر اللي قبله" lowerIsBetter />
        <Kpi label="نسبتها من المبيعات" value={pct(d.totalByMonth[k], d.salesByMonth[k])} note={`المتوسط ${pct(total, sales)}`} />
        <Kpi label={`مجموع ${d.months.length} شهور`} value={money(total)} note={`متوسط الشهر ${money(Math.round(total / d.months.length))}`} />
        <Kpi label="ربح الشهر بعد المصروفات" value={money(d.profitByMonth[k] - d.totalByMonth[k])} tone={d.profitByMonth[k] - d.totalByMonth[k] < 0 ? "bad" : "ok"} />
      </div>
      <Panel title="المصروفات والمبيعات شهر بشهر">
        <TimeChart data={d.months.map((m, i) => ({ label: monthName(m, true), values: [d.totalByMonth[i], d.profitByMonth[i]] }))} names={["المصروفات", "إجمالي الربح"]} fmt={money} />
      </Panel>
      <Panel title="كل بند شهر بشهر" onCsv={() => downloadCsv(`مصروفات-${d.months[0]}-${d.months[k]}`, ["البند", ...d.months, "المجموع"], [...d.categories.map((x) => [x.name, ...x.byMonth.map(dinars), dinars(x.totalMinor)]), ["المجموع", ...d.totalByMonth.map(dinars), dinars(total)], ["المبيعات", ...d.salesByMonth.map(dinars), dinars(sales)]])}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>البند</th>{d.months.map((m) => <th key={m}>{monthName(m, true)}</th>)}<th>المجموع</th><th>من المبيعات</th></tr></thead>
            <tbody>
              {d.categories.length === 0 && <tr><td colSpan={d.months.length + 3} className="muted">ما فيش مصروفات مسجلة في الشهور هذي.</td></tr>}
              {d.categories.map((x) => (
                <tr key={x.name}>
                  <td>{x.name}</td>
                  {x.byMonth.map((v, i) => <td key={i} className={`num ${d.jumps.some((j) => j.category === x.name) && i === k ? "bad" : ""}`}>{v ? money(v) : ""}</td>)}
                  <td className="num"><b>{money(x.totalMinor)}</b></td><td className="num muted">{pct(x.totalMinor, sales)}</td>
                </tr>
              ))}
              <tr className="pnl-total"><td>المجموع</td>{d.totalByMonth.map((v, i) => <td key={i} className="num">{money(v)}</td>)}<td className="num">{money(total)}</td><td className="num">{pct(total, sales)}</td></tr>
              <tr><td className="muted">المبيعات</td>{d.salesByMonth.map((v, i) => <td key={i} className="num muted">{money(v)}</td>)}<td className="num muted">{money(sales)}</td><td /></tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ───────────────────────────── 6. item margins ─────────────────────────────
interface Margins {
  totalMinor: number; profitMinor: number; marginPct: number;
  items: { id: string; name: string; weighted: boolean; category: string; qtyMilli: number; totalMinor: number; costMinor: number; profitMinor: number; sales: number; marginPct: number }[];
  underCost: { id: string; name: string; unit: string; costMinor: number; priceMinor: number }[];
}
export function MarginsReport(c: Ctx) {
  const { d, error } = useLoad<Margins>(`/reports/margins?${qs({ from: c.from, to: c.to, storeId: c.storeId })}`, c.call);
  const [view, setView] = useState<"loss" | "thin" | "stars" | "all">("loss");
  const groups = useMemo(() => {
    if (!d) return null;
    const byQty = [...d.items].sort((a, b) => b.qtyMilli - a.qtyMilli);
    const busy = new Set(byQty.slice(0, Math.max(5, Math.ceil(byQty.length * 0.3))).map((i) => i.id));
    return {
      loss: d.items.filter((i) => i.profitMinor < 0).sort((a, b) => a.profitMinor - b.profitMinor),
      thin: d.items.filter((i) => i.profitMinor >= 0 && busy.has(i.id) && i.marginPct < d.marginPct / 2).sort((a, b) => b.qtyMilli - a.qtyMilli),
      stars: [...d.items].filter((i) => i.profitMinor > 0).sort((a, b) => b.profitMinor - a.profitMinor).slice(0, 30),
      all: [...d.items].sort((a, b) => b.profitMinor - a.profitMinor),
    };
  }, [d]);
  if (!d || !groups) return <Loading error={error} />;
  const rows = groups[view];
  const NAMES = { loss: `🔻 تبيع بخسارة (${groups.loss.length})`, thin: `🐢 يتباع واجد وربحه قليل (${groups.thin.length})`, stars: "⭐ أكثر ربح", all: "الكل" };
  return (
    <>
      <div className="kpis">
        <Kpi label="المبيعات" value={money(d.totalMinor)} />
        <Kpi label="الربح" value={money(d.profitMinor)} tone={d.profitMinor < 0 ? "bad" : "ok"} note={`هامش ${d.marginPct}%`} />
        <Kpi label="أصناف بخسارة" value={String(groups.loss.length)} tone={groups.loss.length ? "bad" : undefined} note={groups.loss.length ? `خسرت ${money(-groups.loss.reduce((a, i) => a + i.profitMinor, 0))}` : undefined} />
        <Kpi label="سعرها اليوم تحت التكلفة" value={String(d.underCost.length)} tone={d.underCost.length ? "bad" : undefined} />
      </div>
      {d.underCost.length > 0 && (
        <Panel title="⚠️ أصناف سعر بيعها اليوم أقل من تكلفتها">
          <table>
            <thead><tr><th>الصنف</th><th>التكلفة</th><th>سعر البيع</th><th>تخسر في كل {"وحدة"}</th></tr></thead>
            <tbody>{d.underCost.map((u) => (
              <tr key={u.id}><td>{u.name} <span className="muted">({u.unit})</span></td><td className="num">{money(u.costMinor)}</td><td className="num">{money(u.priceMinor)}</td><td className="num bad">{money(u.costMinor - u.priceMinor)}</td></tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
      <div className="seg wrap">{(Object.keys(NAMES) as (keyof typeof NAMES)[]).map((k) => <button key={k} className={view === k ? "active" : ""} onClick={() => setView(k)}>{NAMES[k]}</button>)}</div>
      <Panel title={NAMES[view]} onCsv={() => downloadCsv(`ربح-الأصناف-${c.from}-${c.to}`, ["الصنف", "القسم", "الكمية", "المبيعات", "التكلفة", "الربح", "الهامش %"], rows.map((i) => [i.name, i.category, i.qtyMilli / 1000, dinars(i.totalMinor), dinars(i.costMinor), dinars(i.profitMinor), i.marginPct]))}>
        {view === "thin" && <div className="muted" style={{ fontSize: ".9em" }}>من أكثر الأصناف بيعاً، وهامشها أقل من نص متوسط المحل ({d.marginPct}%). زيادة صغيرة في سعرها تفرق واجد.</div>}
        <table>
          <thead><tr><th>الصنف</th><th>الكمية</th><th>المبيعات</th><th>التكلفة</th><th>الربح</th><th>الهامش</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="muted">{view === "loss" ? "ما فيش أصناف تبيعها بخسارة 👌" : "ما فيش"}</td></tr>}
            {rows.slice(0, 200).map((i) => (
              <tr key={i.id}>
                <td>{i.name}<div className="muted" style={{ fontSize: ".8em" }}>{i.category}</div></td>
                <td className="num">{formatQty(i.qtyMilli, i.weighted)}</td><td className="num">{money(i.totalMinor)}</td><td className="num">{money(i.costMinor)}</td>
                <td className={`num ${i.profitMinor < 0 ? "bad" : ""}`}>{money(i.profitMinor)}</td><td className="num">{i.marginPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 7. suppliers ─────────────────────────────
interface Suppliers {
  owed: { id: string; name: string; phone: string | null; balanceMinor: number; lastInvoice: string | null; lastPaid: string | null; boughtMinor: number }[];
  owedMinor: number;
  priceMoves: { id: string; name: string; unit: string; supplier: string | null; times: number; wasMinor: number; nowMinor: number; pct: number }[];
  upCount: number; downCount: number;
}
export function SuppliersReport(c: Ctx) {
  const { d, error } = useLoad<Suppliers>(`/reports/suppliers?${qs({ from: c.from, to: c.to, storeId: c.storeId })}`, c.call);
  if (!d) return <Loading error={error} />;
  const owing = d.owed.filter((s) => s.balanceMinor > 0);
  return (
    <>
      <div className="kpis">
        <Kpi label="عليك للموردين" value={money(d.owedMinor)} tone={d.owedMinor ? "bad" : undefined} note={`${owing.length} مورد`} />
        <Kpi label="شريت منهم في الفترة" value={money(d.owed.reduce((a, s) => a + s.boughtMinor, 0))} />
        <Kpi label="أصناف غلى سعرها" value={String(d.upCount)} tone={d.upCount ? "bad" : undefined} />
        <Kpi label="أصناف رخص سعرها" value={String(d.downCount)} tone={d.downCount ? "ok" : undefined} />
      </div>
      <Panel title="الديون اللي عليك لكل مورد" onCsv={() => downloadCsv("ديون-الموردين", ["المورد", "التلفون", "عليك", "شريت في الفترة", "آخر فاتورة", "آخر دفعة"], d.owed.map((s) => [s.name, s.phone ?? "", dinars(s.balanceMinor), dinars(s.boughtMinor), s.lastInvoice ?? "", s.lastPaid ?? ""]))}>
        <RankBars rows={owing.map((s) => ({ key: s.id, label: s.name, value: s.balanceMinor, note: `آخر فاتورة ${dmy(s.lastInvoice) || "—"} · آخر دفعة ${dmy(s.lastPaid) || "ما دفعتش"}` }))} fmt={money} />
      </Panel>
      <Panel title="أسعار الشراء: شن تغير في الفترة" onCsv={() => downloadCsv(`أسعار-الشراء-${c.from}-${c.to}`, ["الصنف", "الوحدة", "المورد", "كان", "صار", "التغير %"], d.priceMoves.map((m) => [m.name, m.unit, m.supplier ?? "", dinars(m.wasMinor), dinars(m.nowMinor), m.pct]))}>
        <div className="muted" style={{ fontSize: ".9em" }}>يقارن آخر سعر شريت بيه في الفترة مع السعر اللي قبلها. لو غلى، شوف سعر البيع.</div>
        <table>
          <thead><tr><th>الصنف</th><th>المورد</th><th>كان</th><th>صار</th><th>التغير</th></tr></thead>
          <tbody>
            {d.priceMoves.length === 0 && <tr><td colSpan={5} className="muted">ما تغيرش حتى سعر في الفترة هذي.</td></tr>}
            {d.priceMoves.map((m) => (
              <tr key={m.id}>
                <td>{m.name} <span className="muted">({m.unit})</span></td><td>{m.supplier ?? ""}</td>
                <td className="num">{money(m.wasMinor)}</td><td className="num">{money(m.nowMinor)}</td>
                <td className={`num ${m.pct > 0 ? "bad" : "ok"}`}>{m.pct > 0 ? "▲" : "▼"} {Math.abs(m.pct)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 8. discounts, returns, voids ─────────────────────────────
interface Controls {
  totals: { soldMinor: number; returnedMinor: number; discountedMinor: number; voidedMinor: number; voids: number; overrides: number };
  people: { id: string; name: string; sales: number; soldMinor: number; returns: number; returnedMinor: number; discounts: number; discountedMinor: number; voids: number; voidedMinor: number; overrides: number }[];
  events: { kind: "return" | "discount" | "void" | "price"; at: string; who: string | null; ref: string | null; amountMinor: number; detail: string | null }[];
}
const EVENT: Record<Controls["events"][number]["kind"], string> = { return: "↩️ مرتجع", discount: "🏷️ خصم", void: "🗑 فاتورة ملغية", price: "✏️ سعر بالإيد" };
export function ControlsReport(c: Ctx) {
  const { d, error } = useLoad<Controls>(`/reports/controls?${qs({ from: c.from, to: c.to, storeId: c.storeId })}`, c.call);
  const p = useLoad<Controls>(c.prev ? `/reports/controls?${qs({ from: c.prev[0], to: c.prev[1], storeId: c.storeId })}` : null, c.call).d;
  const [kind, setKind] = useState<"all" | Controls["events"][number]["kind"]>("all");
  if (!d) return <Loading error={error} />;
  const t = d.totals, pt = c.prev ? p?.totals : undefined;
  const events = d.events.filter((e) => kind === "all" || e.kind === kind);
  return (
    <>
      <div className="kpis">
        <Kpi label="المرتجعات" value={money(t.returnedMinor)} note={pct(t.returnedMinor, t.soldMinor) + " من المبيعات"} now={t.returnedMinor} was={pt?.returnedMinor} lowerIsBetter />
        <Kpi label="الخصومات اليدوية" value={money(t.discountedMinor)} note={pct(t.discountedMinor, t.soldMinor) + " من المبيعات"} now={t.discountedMinor} was={pt?.discountedMinor} lowerIsBetter />
        <Kpi label="فواتير ملغية في الكاشير" value={`${t.voids} · ${money(t.voidedMinor)}`} now={t.voidedMinor} was={pt?.voidedMinor} lowerIsBetter />
        <Kpi label="أسعار تغيرت بالإيد" value={String(t.overrides)} />
      </div>
      <Panel title="كل موظف" onCsv={() => downloadCsv(`خصومات-ومرتجعات-${c.from}-${c.to}`, ["الموظف", "الفواتير", "المبيعات", "المرتجعات", "قيمة المرتجعات", "الخصومات", "قيمة الخصومات", "الملغية", "قيمة الملغية", "أسعار بالإيد"], d.people.map((x) => [x.name, x.sales, dinars(x.soldMinor), x.returns, dinars(x.returnedMinor), x.discounts, dinars(x.discountedMinor), x.voids, dinars(x.voidedMinor), x.overrides]))}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>الموظف</th><th>المبيعات</th><th>المرتجعات</th><th>الخصومات</th><th>الملغية</th><th>أسعار بالإيد</th></tr></thead>
            <tbody>
              {d.people.map((x) => {
                const r = x.soldMinor ? x.returnedMinor / x.soldMinor : 0;
                const avg = t.soldMinor ? t.returnedMinor / t.soldMinor : 0;
                return (
                  <tr key={x.id}>
                    <td>{x.name}</td>
                    <td className="num">{money(x.soldMinor)}<div className="muted">{x.sales} فاتورة</div></td>
                    <td className={`num ${r > avg * 2 && x.returns > 1 ? "bad" : ""}`}>{money(x.returnedMinor)}<div className="muted">{x.returns} · {pct(x.returnedMinor, x.soldMinor)}</div></td>
                    <td className="num">{money(x.discountedMinor)}<div className="muted">{x.discounts} · {pct(x.discountedMinor, x.soldMinor)}</div></td>
                    <td className={`num ${x.voids > 3 ? "bad" : ""}`}>{money(x.voidedMinor)}<div className="muted">{x.voids} فاتورة</div></td>
                    <td className="num">{x.overrides}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: ".85em" }}>بالأحمر: موظف مرتجعاته فوق ضعف متوسط المحل، أو ألغى أكثر من 3 فواتير.</div>
      </Panel>
      <Panel title="أكبر الحركات" extra={
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={{ width: "auto" }} aria-label="النوع">
          <option value="all">الكل</option>{(Object.keys(EVENT) as (keyof typeof EVENT)[]).map((k) => <option key={k} value={k}>{EVENT[k]}</option>)}
        </select>
      }>
        <table>
          <thead><tr><th>الوقت</th><th>النوع</th><th>الموظف</th><th>الفاتورة / التفاصيل</th><th>المبلغ</th></tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={5} className="muted">ما فيش</td></tr>}
            {events.map((e, i) => (
              <tr key={i}>
                <td className="num">{dmy(e.at)} {new Date(e.at).toLocaleTimeString("ar-LY", { hour: "2-digit", minute: "2-digit" })}</td>
                <td>{EVENT[e.kind]}</td><td>{e.who ?? ""}</td>
                <td className="muted">{[e.ref, e.kind === "price" ? null : e.detail].filter(Boolean).join(" · ")}</td>
                <td className="num">{e.amountMinor ? money(e.amountMinor) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 9. branches side by side ─────────────────────────────
interface Branch extends Totals { id: string; name: string; active: boolean; returnedMinor: number; customers: number }
export function BranchesReport(c: Ctx) {
  const { d, error } = useLoad<Branch[]>(`/reports/branches-full?from=${c.from}&to=${c.to}`, c.call);
  const p = useLoad<Branch[]>(c.prev ? `/reports/branches-full?from=${c.prev[0]}&to=${c.prev[1]}` : null, c.call).d;
  if (!d) return <Loading error={error} />;
  const was = (id: string) => (c.prev ? p?.find((x) => x.id === id) : undefined);
  const total = d.reduce((a, b) => a + b.totalMinor, 0);
  const cols: [string, keyof Branch, boolean?][] = [["المبيعات", "totalMinor"], ["الربح", "profitMinor"], ["المصروفات", "expensesMinor", true], ["الصافي", "netMinor"], ["متوسط الفاتورة", "avgMinor"], ["المرتجعات", "returnedMinor", true]];
  return (
    <>
      <Panel title="المبيعات حسب الفرع">
        <RankBars rows={d.map((b) => ({ key: b.id, label: `${b.name}${b.active ? "" : " (موقوف)"}`, value: b.totalMinor, note: <>{pct(b.totalMinor, total)} من المبيعات · {b.salesCount} فاتورة {was(b.id) && <Delta now={b.totalMinor} then={was(b.id)!.totalMinor} />}</> }))} fmt={money} />
      </Panel>
      <Panel title="الفروع جنب بعض" onCsv={() => downloadCsv(`فروع-${c.from}-${c.to}`, ["الفرع", "الفواتير", ...cols.map(([l]) => l), "زبائن"], d.map((b) => [b.name, b.salesCount, ...cols.map(([, k]) => dinars(b[k] as number)), b.customers]))}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>الفرع</th><th>الفواتير</th>{cols.map(([l]) => <th key={l}>{l}</th>)}<th>زبائن</th></tr></thead>
            <tbody>{d.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td><td className="num">{b.salesCount}</td>
                {cols.map(([l, k, low]) => <td key={l} className="num">{money(b[k] as number)}{was(b.id) && <div><Delta now={b[k] as number} then={was(b.id)![k] as number} lowerIsBetter={low} /></div>}</td>)}
                <td className="num">{b.customers}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ───────────────────────────── 10. forecast ─────────────────────────────
interface Forecast {
  month: string; today: string; daysGone: number; daysInMonth: number; soFar: Totals; projectedMinor: number; paceMinor: number;
  lastMonth: Totals; lastYear: Totals;
  runningOut: { id: string; name: string; weighted: boolean; stockMilli: number; perDayMilli: number; daysLeft: number; minMilli: number }[];
}
export function ForecastReport(c: Ctx) {
  const { d, error } = useLoad<Forecast>(`/reports/forecast${c.storeId ? `?storeId=${c.storeId}` : ""}`, c.call);
  if (!d) return <Loading error={error} />;
  const left = d.daysInMonth - d.daysGone;
  return (
    <>
      <div className="kpis">
        <Kpi label={`المتوقع لشهر ${monthName(d.month)}`} value={money(d.projectedMinor)} now={d.projectedMinor} was={d.lastMonth.totalMinor || undefined} wasLabel="الشهر اللي فات" note="على حسب كل يوم في الأسبوع آخر 8 أسابيع" />
        <Kpi label="بعت لين توا" value={money(d.soFar.totalMinor)} note={`${d.daysGone} يوم من ${d.daysInMonth} · باقي ${left}`} />
        <Kpi label="لو كملت بنفس المعدل" value={money(d.paceMinor)} />
        <Kpi label="نفس الشهر العام اللي فات" value={d.lastYear.totalMinor ? money(d.lastYear.totalMinor) : "—"} now={d.projectedMinor} was={d.lastYear.totalMinor || undefined} wasLabel="" />
      </div>
      <Panel title="الشهر: الفعلي والمتوقع">
        <BarChart name="المبيعات" fmt={money} data={[
          { label: "الشهر اللي فات", value: d.lastMonth.totalMinor },
          { label: "لين توا", value: d.soFar.totalMinor },
          { label: "المتوقع", value: d.projectedMinor },
          ...(d.lastYear.totalMinor ? [{ label: "العام اللي فات", value: d.lastYear.totalMinor }] : []),
        ]} />
      </Panel>
      <Panel title="أصناف حتخلص قريب" onCsv={() => downloadCsv("أصناف-حتخلص", ["الصنف", "الموجود", "يتباع في اليوم", "تخلص بعد (يوم)"], d.runningOut.map((r) => [r.name, r.stockMilli / 1000, r.perDayMilli / 1000, r.daysLeft]))}>
        <div className="muted" style={{ fontSize: ".9em" }}>على حسب البيع آخر 30 يوم. اطلبها من المورد قبل ما تخلص.</div>
        <table>
          <thead><tr><th>الصنف</th><th>الموجود</th><th>يتباع في اليوم</th><th>تخلص بعد</th></tr></thead>
          <tbody>
            {d.runningOut.length === 0 && <tr><td colSpan={4} className="muted">ما فيش أصناف حتخلص في الـ 3 أسابيع الجاية 👌</td></tr>}
            {d.runningOut.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td><td className="num">{formatQty(r.stockMilli, r.weighted)}</td><td className="num">{formatQty(r.perDayMilli, r.weighted)}</td>
                <td className={`num ${r.daysLeft <= 3 ? "bad" : ""}`}><b>{r.daysLeft === 0 ? "خلص" : `${r.daysLeft} يوم`}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ───────────────────────────── 11. the summary on the phone ─────────────────────────────
export function DigestCard({ call }: { call: Call }) {
  const [v, setV] = useState<ReportDigest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => void call<{ settings: { reportDigest?: ReportDigest } }>("/settings").then((r) => setV(r.settings.reportDigest ?? { daily: false, weekly: false, monthly: false, hour: 22 })).catch(() => undefined), [call]);
  if (!v) return null;
  async function save(next: ReportDigest) {
    setV(next);
    setMsg(null);
    try {
      await call("/settings/report-digest", { method: "PATCH", body: next });
      setMsg("✔ تحفظ");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="card stack">
      <b>📲 ملخص يوصلك وحده على التلفون</b>
      <div className="muted" style={{ fontSize: ".9em" }}>يجيك تنبيه على التلفون فيه المبيعات والربح والمصروفات، ومقارنتهم باللي قبلهم. ومن التنبيه تقدر تبعته واتساب.</div>
      <label className="check"><input type="checkbox" checked={v.daily} onChange={(e) => void save({ ...v, daily: e.target.checked })} /> كل يوم (مقارنة مع نفس اليوم الأسبوع اللي فات)</label>
      <label className="check"><input type="checkbox" checked={v.weekly} onChange={(e) => void save({ ...v, weekly: e.target.checked })} /> كل أسبوع، يوم السبت</label>
      <label className="check"><input type="checkbox" checked={v.monthly} onChange={(e) => void save({ ...v, monthly: e.target.checked })} /> كل شهر، أول يوم فيه</label>
      <label className="row" style={{ gap: 8 }}>بعد الساعة
        <select value={v.hour} onChange={(e) => void save({ ...v, hour: Number(e.target.value) })} style={{ width: "auto" }}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
        </select>
      </label>
      {msg && <span className="muted">{msg}</span>}
    </div>
  );
}

// ───────────────────────────── 12. pinned reports on the home page ─────────────────────────────
export function PinnedReports({ call, storeId, openFav }: { call: Call; storeId: string; openFav: (f: ReportFav) => void }) {
  const [rows, setRows] = useState<{ f: ReportFav; now: Totals; was: Totals | null; label: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    void call<{ settings: { reportFavs?: ReportFav[] } }>("/settings").then(async (r) => {
      const pinned = (r.settings.reportFavs ?? []).filter((f) => f.pinned).slice(0, 6);
      const out = await Promise.all(pinned.map(async (f) => {
        const [from, to] = (PRESETS[f.preset] ?? PRESETS["هذا الشهر"])();
        const sid = f.scope === "store" ? `&storeId=${storeId}` : "";
        const prev = compareRange(from, to, f.compare);
        const [now, was] = await Promise.all([
          call<Totals>(`/reports/totals?from=${from}&to=${to}${sid}`),
          prev ? call<Totals>(`/reports/totals?from=${prev[0]}&to=${prev[1]}${sid}`) : Promise.resolve(null),
        ]);
        return { f, now, was, label: f.preset || `${dmy(from)} - ${dmy(to)}` };
      }));
      if (live) setRows(out);
    }).catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [call, storeId]);
  if (!rows?.length) return null;
  return (
    <div className="kpis">
      {rows.map(({ f, now, was, label }) => (
        <button key={f.id} className="kpi pinned-report" onClick={() => openFav(f)} title="افتح التقرير">
          <span className="muted">📌 {f.name}</span>
          <b className="num">{money(now.totalMinor)}</b>
          <small className="muted">{label} · {now.salesCount} فاتورة {was && <Delta now={now.totalMinor} then={was.totalMinor} />}</small>
          <small className="muted">ربح {money(now.profitMinor)} {was && <Delta now={now.profitMinor} then={was.profitMinor} />}</small>
        </button>
      ))}
    </div>
  );
}
