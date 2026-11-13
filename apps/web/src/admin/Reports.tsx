import { useEffect, useMemo, useState, type ReactNode } from "react";
import { METHOD_LABELS, formatMoney, formatQty, sortSizes } from "@pos/shared";
import type { Call } from "./Admin";
import { BarChart, Donut, RankBars, TimeChart, downloadCsv } from "./charts";
import { Report as DailyReport } from "./Report";
import { INVOICE_METHOD } from "./Purchasing";

interface Period {
  from: string; to: string;
  summary: { salesCount: number; returnsCount: number; returnsMinor: number; totalMinor: number; discountMinor: number; promoMinor: number; costMinor: number; grossProfitMinor: number; expensesMinor: number; netProfitMinor: number; avgMinor: number };
  series: { day: string; totalMinor: number; profitMinor: number; salesCount: number }[];
  byMethod: Record<string, number>;
  byHour: { hour: number; sales_count: number; total_minor: number }[];
  byWeekday: { dow: number; sales_count: number; total_minor: number }[];
  byCategory: { id: string | null; name: string; icon: string | null; total_minor: number; profit_minor: number; products: number }[];
  topProducts: { product_id: string; name: string; weighted: boolean; qty_milli: number; total_minor: number; profit_minor: number }[];
  byCashier: { name: string; sales_count: number; total_minor: number; returns_count: number }[];
  expenses: { category: string; amount_minor: number }[];
  purchases: { bySupplier: { id: string | null; name: string; invoices: number; total_minor: number; paid_minor: number }[]; byMethod: { method: keyof typeof INVOICE_METHOD; invoices: number; total_minor: number }[] };
  credit: { givenMinor: number; collectedMinor: number };
}
interface Inventory {
  items: number; outOfStock: number; costValueMinor: number; retailValueMinor: number;
  byCategory: { name: string; icon: string | null; items: number; inStock: number; costValueMinor: number; retailValueMinor: number }[];
  slowMovers: { id: string; name: string; stockMilli: number; weighted: boolean; costValueMinor: number }[];
}
interface Expiring { product_id: string; name: string; is_weighted: boolean; expiry_date: string; days_left: number; received_milli: number; left_milli: number; stock_milli: number; supplier_name: string | null }

const REPORTS = {
  overview: { icon: "📈", name: "المبيعات والأرباح", hint: "المبيعات والربح يوم بيوم وطرق الدفع" },
  categories: { icon: "🗂️", name: "المبيعات حسب القسم", hint: "أي قسم يبيع أكثر ويربح أكثر" },
  products: { icon: "🏆", name: "الأصناف الأكثر مبيعاً", hint: "أعلى 20 صنف بالقيمة والربح" },
  times: { icon: "🕒", name: "أوقات البيع", hint: "الساعات والأيام الأقوى" },
  cashiers: { icon: "👤", name: "أداء الكاشيرات", hint: "مبيعات وفواتير ومرتجعات كل موظف" },
  pnl: { icon: "🧾", name: "الأرباح والمصروفات", hint: "قائمة دخل مختصرة للفترة" },
  purchases: { icon: "🚚", name: "المشتريات والموردين", hint: "التوريد حسب المورد وطريقة الدفع" },
  sizes: { icon: "👕", name: "المقاسات والألوان", hint: "أي مقاس ولون يتباع، وكم باقي منه" },
  inventory: { icon: "📦", name: "قيمة المخزون", hint: "قيمة البضاعة بالتكلفة والبيع والراكد" },
  expiry: { icon: "⏳", name: "قرب انتهاء الصلاحية", hint: "الدفعات اللي في الرف وتواريخها" },
  prescriptions: { icon: "💊", name: "سجل الوصفات", hint: "مبيعات الأدوية اللي بوصفة طبية" },
  daily: { icon: "📅", name: "تقرير يوم (إقفال)", hint: "تفاصيل يوم واحد للفرع" },
} as const;
type Kind = keyof typeof REPORTS;
/** Reports that read the period picker. */
const NEEDS_PERIOD: Kind[] = ["overview", "categories", "products", "times", "cashiers", "pnl", "purchases"];

const local = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(d);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PRESETS: Record<string, () => [string, string]> = {
  "اليوم": () => [local(), local()],
  "أمس": () => [addDays(local(), -1), addDays(local(), -1)],
  "آخر 7 أيام": () => [addDays(local(), -6), local()],
  "آخر 30 يوم": () => [addDays(local(), -29), local()],
  "هذا الشهر": () => [`${local().slice(0, 7)}-01`, local()],
  "الشهر الماضي": () => {
    const first = `${local().slice(0, 7)}-01`;
    const end = addDays(first, -1);
    return [`${end.slice(0, 7)}-01`, end];
  },
};
const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const PAY: Record<string, string> = { ...METHOD_LABELS, cash: "نقدي", payroll: "على راتب الموظفين" };
const dm = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;
const money = (n: number) => formatMoney(n);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const dinars = (n: number) => (n / 1000).toFixed(3);

export function Reports({ call, storeId, stores, initial }: { call: Call; storeId: string; stores: { id: string; name: string }[]; initial?: Kind }) {
  const [kind, setKind] = useState<Kind>(initial ?? "overview");
  const [preset, setPreset] = useState("آخر 7 أيام");
  const [[from, to], setRange] = useState(PRESETS["آخر 7 أيام"]);
  const [scope, setScope] = useState<"store" | "all">("store");
  const [data, setData] = useState<Period | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sid = scope === "store" ? storeId : undefined;

  useEffect(() => {
    if (!NEEDS_PERIOD.includes(kind)) return;
    setError(null);
    call<Period>(`/reports/period?from=${from}&to=${to}${sid ? `&storeId=${sid}` : ""}`).then(setData).catch((e) => setError((e as Error).message));
  }, [call, from, to, sid, kind]);

  return (
    <div className="reports">
      <nav className="report-menu">
        {(Object.keys(REPORTS) as Kind[]).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
            <span className="report-icon">{REPORTS[k].icon}</span>
            <span><b>{REPORTS[k].name}</b><small className="muted">{REPORTS[k].hint}</small></span>
          </button>
        ))}
      </nav>
      <section className="stack" style={{ minWidth: 0 }}>
        <div className="report-head">
          <h2>{REPORTS[kind].icon} {REPORTS[kind].name}</h2>
          {kind !== "daily" && kind !== "expiry" && stores.length > 1 && (
            <div className="seg">
              <button className={scope === "store" ? "active" : ""} onClick={() => setScope("store")}>{stores.find((s) => s.id === storeId)?.name ?? "الفرع"}</button>
              <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>كل الفروع</button>
            </div>
          )}
        </div>
        {(NEEDS_PERIOD.includes(kind) || kind === "sizes" || kind === "prescriptions") && (
          <div className="row">
            <div className="chips">
              {Object.keys(PRESETS).map((p) => <button key={p} className={preset === p ? "active" : ""} onClick={() => { setPreset(p); setRange(PRESETS[p]()); }}>{p}</button>)}
            </div>
            <label className="row" style={{ gap: 4 }}>من<input type="date" value={from} max={to} onChange={(e) => { setPreset(""); setRange([e.target.value, to]); }} style={{ width: 150 }} /></label>
            <label className="row" style={{ gap: 4 }}>إلى<input type="date" value={to} min={from} onChange={(e) => { setPreset(""); setRange([from, e.target.value]); }} style={{ width: 150 }} /></label>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {NEEDS_PERIOD.includes(kind) && !data && !error && <div className="muted">جاري التحميل…</div>}
        {data && kind === "overview" && <Overview d={data} />}
        {data && kind === "categories" && <Categories d={data} />}
        {data && kind === "products" && <Products d={data} />}
        {data && kind === "times" && <Times d={data} />}
        {data && kind === "cashiers" && <Cashiers d={data} />}
        {data && kind === "pnl" && <Pnl d={data} />}
        {data && kind === "purchases" && <Purchases d={data} />}
        {kind === "prescriptions" && <PrescriptionsReport call={call} storeId={sid} from={from} to={to} />}
        {kind === "sizes" && <SizesReport call={call} storeId={sid} from={from} to={to} />}
        {kind === "inventory" && <InventoryReport call={call} storeId={sid} />}
        {kind === "expiry" && <ExpiryReport call={call} storeId={storeId} />}
        {kind === "daily" && <DailyReport call={call} storeId={storeId} />}
      </section>
    </div>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <div className="kpi">
      <span className="muted">{label}</span>
      <b className={`num ${tone ?? ""}`}>{value}</b>
      {note && <small className="muted">{note}</small>}
    </div>
  );
}

function Panel({ title, children, onCsv }: { title: string; children: ReactNode; onCsv?: () => void }) {
  return (
    <div className="card panel">
      <div className="panel-head"><b>{title}</b><span className="spacer" />{onCsv && <button className="ghost" onClick={onCsv}>⬇ Excel</button>}</div>
      {children}
    </div>
  );
}

function Overview({ d }: { d: Period }) {
  const s = d.summary;
  const series = d.series.map((x) => ({ label: dm(x.day), values: [x.totalMinor, x.profitMinor] }));
  return (
    <>
      <div className="kpis">
        <Kpi label="صافي المبيعات" value={money(s.totalMinor)} note={`${s.salesCount} فاتورة`} />
        <Kpi label="إجمالي الربح" value={money(s.grossProfitMinor)} note={`هامش ${pct(s.grossProfitMinor, s.totalMinor)}`} tone="ok" />
        <Kpi label="متوسط الفاتورة" value={money(s.avgMinor)} />
        <Kpi label="المرتجعات" value={money(s.returnsMinor)} note={`${s.returnsCount} مرتجع`} tone={s.returnsMinor ? "bad" : undefined} />
        <Kpi label="الخصومات والعروض" value={money(s.discountMinor + s.promoMinor)} />
        <Kpi label="صافي الربح بعد المصروفات" value={money(s.netProfitMinor)} tone={s.netProfitMinor < 0 ? "bad" : "ok"} />
      </div>
      <Panel title="المبيعات والربح يوم بيوم" onCsv={() => downloadCsv(`مبيعات-${d.from}-${d.to}`, ["اليوم", "المبيعات", "الربح", "عدد الفواتير"], d.series.map((x) => [x.day, dinars(x.totalMinor), dinars(x.profitMinor), x.salesCount]))}>
        <TimeChart data={series} names={["المبيعات", "الربح"]} fmt={money} />
      </Panel>
      <div className="grid-2">
        <Panel title="طرق الدفع">
          <Donut items={Object.entries(d.byMethod).map(([k, v]) => ({ label: PAY[k] ?? k, value: v }))} fmt={money} />
        </Panel>
        <Panel title="الأقسام الأكثر مبيعاً">
          <RankBars rows={d.byCategory.slice(0, 6).map((c) => ({ key: c.id ?? "none", label: `${c.icon ?? ""} ${c.name}`, value: c.total_minor }))} fmt={money} />
        </Panel>
      </div>
      <div className="grid-2">
        <Kpi label="بيع آجل (ديون جديدة على العملاء)" value={money(d.credit.givenMinor)} />
        <Kpi label="تحصيل ديون من العملاء" value={money(d.credit.collectedMinor)} tone="ok" />
      </div>
    </>
  );
}

function Categories({ d }: { d: Period }) {
  const total = d.byCategory.reduce((a, c) => a + c.total_minor, 0);
  return (
    <>
      <Panel title="المبيعات حسب القسم">
        <RankBars rows={d.byCategory.map((c) => ({ key: c.id ?? "none", label: `${c.icon ?? ""} ${c.name}`, value: c.total_minor, note: `ربح ${money(c.profit_minor)} · ${pct(c.total_minor, total)} من المبيعات` }))} fmt={money} />
      </Panel>
      <Panel title="الجدول" onCsv={() => downloadCsv(`أقسام-${d.from}-${d.to}`, ["القسم", "المبيعات", "الربح", "الهامش", "عدد الأصناف المباعة"], d.byCategory.map((c) => [c.name, dinars(c.total_minor), dinars(c.profit_minor), pct(c.profit_minor, c.total_minor), c.products]))}>
        <table>
          <thead><tr><th>القسم</th><th>المبيعات</th><th>النسبة</th><th>الربح</th><th>الهامش</th><th>أصناف</th></tr></thead>
          <tbody>{d.byCategory.map((c) => (
            <tr key={c.id ?? "none"}><td>{c.icon} {c.name}</td><td className="num">{money(c.total_minor)}</td><td className="num">{pct(c.total_minor, total)}</td><td className="num">{money(c.profit_minor)}</td><td className="num">{pct(c.profit_minor, c.total_minor)}</td><td className="num">{c.products}</td></tr>
          ))}</tbody>
        </table>
      </Panel>
    </>
  );
}

function Products({ d }: { d: Period }) {
  const [by, setBy] = useState<"total_minor" | "profit_minor">("total_minor");
  const rows = useMemo(() => [...d.topProducts].sort((a, b) => b[by] - a[by]), [d, by]);
  return (
    <>
      <div className="seg" style={{ justifySelf: "start" }}>
        <button className={by === "total_minor" ? "active" : ""} onClick={() => setBy("total_minor")}>حسب المبيعات</button>
        <button className={by === "profit_minor" ? "active" : ""} onClick={() => setBy("profit_minor")}>حسب الربح</button>
      </div>
      <Panel title="أعلى الأصناف">
        <RankBars rows={rows.slice(0, 10).map((p) => ({ key: p.product_id, label: p.name, value: p[by], note: `${formatQty(p.qty_milli, p.weighted)} ${p.weighted ? "كغ" : "قطعة"}` }))} fmt={money} />
      </Panel>
      <Panel title="الجدول" onCsv={() => downloadCsv(`أصناف-${d.from}-${d.to}`, ["الصنف", "الكمية", "المبيعات", "الربح", "الهامش"], rows.map((p) => [p.name, p.qty_milli / 1000, dinars(p.total_minor), dinars(p.profit_minor), pct(p.profit_minor, p.total_minor)]))}>
        <table>
          <thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>المبيعات</th><th>الربح</th><th>الهامش</th></tr></thead>
          <tbody>{rows.map((p, i) => (
            <tr key={p.product_id}><td className="num muted">{i + 1}</td><td>{p.name}</td><td className="num">{formatQty(p.qty_milli, p.weighted)}</td><td className="num">{money(p.total_minor)}</td><td className="num">{money(p.profit_minor)}</td><td className="num">{pct(p.profit_minor, p.total_minor)}</td></tr>
          ))}</tbody>
        </table>
      </Panel>
    </>
  );
}

function Times({ d }: { d: Period }) {
  const hours = Array.from({ length: 24 }, (_, h) => d.byHour.find((x) => x.hour === h)).map((x, h) => ({ label: String(h), value: x?.total_minor ?? 0, sub: `${x?.sales_count ?? 0} فاتورة` }));
  const first = hours.findIndex((h) => h.value > 0);
  const last = 23 - [...hours].reverse().findIndex((h) => h.value > 0);
  const best = [...d.byHour].sort((a, b) => b.total_minor - a.total_minor)[0];
  const bestDay = [...d.byWeekday].sort((a, b) => b.total_minor - a.total_minor)[0];
  return (
    <>
      <div className="kpis">
        <Kpi label="أقوى ساعة" value={best ? `${String(best.hour).padStart(2, "0")}:00` : "—"} note={best && money(best.total_minor)} />
        <Kpi label="أقوى يوم في الأسبوع" value={bestDay ? DAYS[bestDay.dow] : "—"} note={bestDay && money(bestDay.total_minor)} />
      </div>
      <Panel title="المبيعات حسب الساعة">
        <BarChart name="المبيعات" data={first < 0 ? hours : hours.slice(first, last + 1)} fmt={money} />
      </Panel>
      <Panel title="المبيعات حسب يوم الأسبوع">
        <BarChart name="المبيعات" data={DAYS.map((n, i) => { const x = d.byWeekday.find((w) => w.dow === i); return { label: n, value: x?.total_minor ?? 0, sub: `${x?.sales_count ?? 0} فاتورة` }; })} fmt={money} />
      </Panel>
    </>
  );
}

function Cashiers({ d }: { d: Period }) {
  return (
    <>
      <Panel title="مبيعات كل موظف">
        <RankBars rows={d.byCashier.map((c) => ({ key: c.name, label: c.name, value: c.total_minor, note: `${c.sales_count} فاتورة · متوسط ${money(c.sales_count ? Math.round(c.total_minor / c.sales_count) : 0)} · ${c.returns_count} مرتجع` }))} fmt={money} />
      </Panel>
      <Panel title="الجدول" onCsv={() => downloadCsv(`كاشيرات-${d.from}-${d.to}`, ["الموظف", "الفواتير", "المبيعات", "المرتجعات"], d.byCashier.map((c) => [c.name, c.sales_count, dinars(c.total_minor), c.returns_count]))}>
        <table>
          <thead><tr><th>الموظف</th><th>الفواتير</th><th>المبيعات</th><th>متوسط الفاتورة</th><th>المرتجعات</th></tr></thead>
          <tbody>{d.byCashier.map((c) => (
            <tr key={c.name}><td>{c.name}</td><td className="num">{c.sales_count}</td><td className="num">{money(c.total_minor)}</td><td className="num">{money(c.sales_count ? Math.round(c.total_minor / c.sales_count) : 0)}</td><td className="num">{c.returns_count}</td></tr>
          ))}</tbody>
        </table>
      </Panel>
    </>
  );
}

function Pnl({ d }: { d: Period }) {
  const s = d.summary;
  const line = (label: string, v: number, strong?: boolean, sign = "") => (
    <tr className={strong ? "pnl-total" : ""}><td>{label}</td><td className="num">{sign}{money(v)}</td><td className="num muted">{pct(Math.abs(v), s.totalMinor)}</td></tr>
  );
  return (
    <div className="grid-2">
      <Panel title="قائمة الدخل" onCsv={() => downloadCsv(`أرباح-${d.from}-${d.to}`, ["البند", "المبلغ"], [["صافي المبيعات", dinars(s.totalMinor)], ["تكلفة البضاعة المباعة", dinars(s.totalMinor - s.grossProfitMinor)], ["إجمالي الربح", dinars(s.grossProfitMinor)], ...d.expenses.map((e) => [`مصروف: ${e.category}`, dinars(e.amount_minor)]), ["صافي الربح", dinars(s.netProfitMinor)]])}>
        <table>
          <tbody>
            {line("صافي المبيعات", s.totalMinor, true)}
            {line("تكلفة البضاعة المباعة", s.totalMinor - s.grossProfitMinor, false, "− ")}
            {line("إجمالي الربح", s.grossProfitMinor, true)}
            {d.expenses.map((e) => <tr key={e.category}><td className="muted">مصروف: {e.category}</td><td className="num">− {money(e.amount_minor)}</td><td className="num muted">{pct(e.amount_minor, s.totalMinor)}</td></tr>)}
            {line("صافي الربح", s.netProfitMinor, true)}
          </tbody>
        </table>
      </Panel>
      <Panel title="المصروفات حسب البند">
        <Donut items={d.expenses.slice(0, 5).map((e) => ({ label: e.category, value: e.amount_minor })).concat(d.expenses.length > 5 ? [{ label: "أخرى", value: d.expenses.slice(5).reduce((a, e) => a + e.amount_minor, 0) }] : [])} fmt={money} />
      </Panel>
    </div>
  );
}

function Purchases({ d }: { d: Period }) {
  const total = d.purchases.bySupplier.reduce((a, s) => a + s.total_minor, 0);
  const owed = d.purchases.bySupplier.reduce((a, s) => a + s.total_minor - s.paid_minor, 0);
  return (
    <>
      <div className="kpis">
        <Kpi label="إجمالي التوريد" value={money(total)} note={`${d.purchases.bySupplier.reduce((a, s) => a + s.invoices, 0)} فاتورة`} />
        <Kpi label="المدفوع" value={money(total - owed)} tone="ok" />
        <Kpi label="آجل (دين للموردين)" value={money(owed)} tone={owed ? "bad" : undefined} />
      </div>
      <div className="grid-2">
        <Panel title="حسب المورد">
          <RankBars rows={d.purchases.bySupplier.map((s) => ({ key: s.id ?? "none", label: s.name, value: s.total_minor, note: `${s.invoices} فاتورة · باقي ${money(s.total_minor - s.paid_minor)}` }))} fmt={money} />
        </Panel>
        <Panel title="حسب طريقة الدفع">
          <Donut items={d.purchases.byMethod.map((m) => ({ label: INVOICE_METHOD[m.method] ?? m.method, value: m.total_minor }))} fmt={money} />
        </Panel>
      </div>
      <Panel title="الجدول" onCsv={() => downloadCsv(`مشتريات-${d.from}-${d.to}`, ["المورد", "الفواتير", "الإجمالي", "المدفوع", "الباقي"], d.purchases.bySupplier.map((s) => [s.name, s.invoices, dinars(s.total_minor), dinars(s.paid_minor), dinars(s.total_minor - s.paid_minor)]))}>
        <table>
          <thead><tr><th>المورد</th><th>الفواتير</th><th>الإجمالي</th><th>المدفوع</th><th>الباقي</th></tr></thead>
          <tbody>{d.purchases.bySupplier.map((s) => (
            <tr key={s.id ?? "none"}><td>{s.name}</td><td className="num">{s.invoices}</td><td className="num">{money(s.total_minor)}</td><td className="num">{money(s.paid_minor)}</td><td className="num">{money(s.total_minor - s.paid_minor)}</td></tr>
          ))}</tbody>
        </table>
      </Panel>
    </>
  );
}

function InventoryReport({ call, storeId }: { call: Call; storeId?: string }) {
  const [d, setD] = useState<Inventory | null>(null);
  useEffect(() => void call<Inventory>(`/reports/inventory${storeId ? `?storeId=${storeId}` : ""}`).then(setD), [call, storeId]);
  if (!d) return <div className="muted">جاري التحميل…</div>;
  return (
    <>
      <div className="kpis">
        <Kpi label="قيمة المخزون بالتكلفة" value={money(d.costValueMinor)} />
        <Kpi label="قيمته بسعر البيع" value={money(d.retailValueMinor)} note={`ربح متوقع ${money(d.retailValueMinor - d.costValueMinor)}`} tone="ok" />
        <Kpi label="عدد الأصناف" value={String(d.items)} />
        <Kpi label="أصناف خالصة" value={String(d.outOfStock)} tone={d.outOfStock ? "bad" : undefined} />
      </div>
      <Panel title="قيمة المخزون حسب القسم (بالتكلفة)" onCsv={() => downloadCsv("مخزون-حسب-القسم", ["القسم", "الأصناف", "فيها بضاعة", "القيمة بالتكلفة", "القيمة بالبيع"], d.byCategory.map((c) => [c.name, c.items, c.inStock, dinars(c.costValueMinor), dinars(c.retailValueMinor)]))}>
        <RankBars rows={d.byCategory.map((c) => ({ key: c.name, label: `${c.icon ?? ""} ${c.name}`, value: c.costValueMinor, note: `${c.inStock} من ${c.items} صنف فيها بضاعة · بالبيع ${money(c.retailValueMinor)}` }))} fmt={money} />
      </Panel>
      <Panel title="بضاعة راكدة: ما تباعتش آخر 30 يوم" onCsv={() => downloadCsv("بضاعة-راكدة", ["الصنف", "الكمية", "القيمة بالتكلفة"], d.slowMovers.map((s) => [s.name, s.stockMilli / 1000, dinars(s.costValueMinor)]))}>
        {d.slowMovers.length === 0 ? <div className="muted">كل الأصناف تتحرك.</div> : (
          <table>
            <thead><tr><th>الصنف</th><th>الكمية</th><th>القيمة بالتكلفة</th></tr></thead>
            <tbody>{d.slowMovers.map((s) => <tr key={s.id}><td>{s.name}</td><td className="num">{formatQty(s.stockMilli, s.weighted)}</td><td className="num">{money(s.costValueMinor)}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function ExpiryReport({ call, storeId }: { call: Call; storeId: string }) {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Expiring[] | null>(null);
  useEffect(() => void call<Expiring[]>(`/stock/expiring?storeId=${storeId}&days=${days}`).then(setRows), [call, storeId, days]);
  const badge = (n: number) => (n < 0 ? <span className="badge bad">منتهي من {-n} يوم</span> : n <= 7 ? <span className="badge bad">باقي {n} يوم</span> : <span className="badge off">باقي {n} يوم</span>);
  return (
    <>
      <div className="chips">
        {[7, 15, 30, 60, 90].map((n) => <button key={n} className={days === n ? "active" : ""} onClick={() => setDays(n)}>خلال {n} يوم</button>)}
      </div>
      <Panel title="دفعات في الرف قربت صلاحيتها تخلص" onCsv={rows ? () => downloadCsv(`صلاحية-${days}-يوم`, ["الصنف", "تاريخ الصلاحية", "الأيام الباقية", "باقي من الدفعة", "وصل", "المخزون الحالي", "المورد"], rows.map((r) => [r.name, r.expiry_date, r.days_left, r.left_milli / 1000, r.received_milli / 1000, r.stock_milli / 1000, r.supplier_name ?? ""])) : undefined}>
        {!rows ? <div className="muted">جاري التحميل…</div> : rows.length === 0 ? <div className="muted">ما فيش دفعات في الرف تنتهي خلال {days} يوم. (التواريخ تتسجل من فاتورة التوريد، والمخزون يتحسب من أحدث الدفعات لأن الأقدم يتباع أول.)</div> : (
          <table>
            <thead><tr><th>الصنف</th><th>تاريخ الصلاحية</th><th /><th>باقي من الدفعة</th><th>وصل</th><th>المخزون الحالي</th><th>المورد</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.product_id}-${r.expiry_date}`}>
                <td>{r.name}</td><td className="num">{r.expiry_date.split("-").reverse().join("/")}</td><td style={{ whiteSpace: "nowrap" }}>{badge(r.days_left)}</td>
                <td className="num"><b>{formatQty(r.left_milli, r.is_weighted)}</b></td>
                <td className="num">{formatQty(r.received_milli, r.is_weighted)}</td><td className="num">{formatQty(r.stock_milli, r.is_weighted)}</td><td>{r.supplier_name ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

interface SizeModel { groupId: string; name: string; soldMilli: number; totalMinor: number; stockMilli: number; pieces: { productId: string; color: string | null; size: string | null; soldMilli: number; stockMilli: number }[] }

/** Clothes: each model as colours by sizes, sold over the period and left on the shelf. */
function SizesReport({ call, storeId, from, to }: { call: Call; storeId?: string; from: string; to: string }) {
  const [rows, setRows] = useState<SizeModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    setError(null);
    call<SizeModel[]>(`/reports/sizes?from=${from}&to=${to}${storeId ? `&storeId=${storeId}` : ""}`).then(setRows).catch((e) => setError((e as Error).message));
  }, [call, storeId, from, to]);
  if (error) return <div className="error">{error}</div>;
  if (!rows) return <div className="muted">جاري التحميل…</div>;
  if (!rows.length) return <div className="muted">ما فيش أصناف بمقاسات وألوان. تنعمل من «بطاقة صنف جديدة» ← «👕 مقاسات وألوان».</div>;
  // Over all models: which sizes and colours sell, so the next order brings more of them.
  const bySize = new Map<string, number>();
  const byColor = new Map<string, number>();
  for (const m of rows) for (const p of m.pieces) {
    if (p.size) bySize.set(p.size, (bySize.get(p.size) ?? 0) + p.soldMilli);
    if (p.color) byColor.set(p.color, (byColor.get(p.color) ?? 0) + p.soldMilli);
  }
  const q = (n: number) => formatQty(n, false);
  const csv = () => downloadCsv(`مقاسات-${from}-${to}`, ["الموديل", "اللون", "المقاس", "المباع", "الباقي"],
    rows.flatMap((m) => m.pieces.map((p) => [m.name, p.color ?? "", p.size ?? "", p.soldMilli / 1000, p.stockMilli / 1000])));
  return (
    <>
      <div className="kpis">
        {bySize.size > 0 && <Panel title="المقاسات الأكثر بيعاً"><RankBars rows={sortSizes([...bySize.keys()]).map((k) => ({ key: k, label: k, value: bySize.get(k)! }))} fmt={q} /></Panel>}
        {byColor.size > 0 && <Panel title="الألوان الأكثر بيعاً"><RankBars rows={[...byColor].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: k, value: v }))} fmt={q} /></Panel>}
      </div>
      <Panel title="كل موديل: المباع / الباقي" onCsv={csv}>
        <div className="stack">
          {rows.map((m) => {
            const sizes = sortSizes(m.pieces.map((p) => p.size ?? ""));
            const colors = [...new Set(m.pieces.map((p) => p.color ?? ""))];
            const at = (c: string, s: string) => m.pieces.find((p) => (p.color ?? "") === c && (p.size ?? "") === s);
            return (
              <div key={m.groupId} className="stack" style={{ gap: 6 }}>
                <div className="row"><b>{m.name}</b><span className="muted">باع <span className="num">{q(m.soldMilli)}</span> · بقى <span className="num">{q(m.stockMilli)}</span> · <span className="num">{formatMoney(m.totalMinor)}</span></span></div>
                <div className="variant-grid" style={{ gridTemplateColumns: `auto repeat(${sizes.length}, minmax(64px, 1fr))` }}>
                  <span />
                  {sizes.map((s) => <b key={s} className="vg-head">{s || "—"}</b>)}
                  {colors.map((c) => (
                    <div key={c} style={{ display: "contents" }}>
                      <b className="vg-color">{c || "—"}</b>
                      {sizes.map((s) => {
                        const p = at(c, s);
                        if (!p) return <span key={s} className="vg-none">—</span>;
                        // Sold well and nearly gone: the size to reorder.
                        const hot = p.soldMilli > 0 && p.stockMilli <= p.soldMilli / 2;
                        return (
                          <span key={s} className={`vg-stock ${p.stockMilli <= 0 ? "out" : hot ? "low" : ""}`} title="المباع / الباقي">
                            {q(p.soldMilli)} / {q(p.stockMilli)}
                          </span>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="muted" style={{ fontSize: ".85rem" }}>كل خانة: المباع في الفترة / الباقي في المخزون. البرتقالي باع كويس وقرّب يخلص، والأحمر خالص.</div>
        </div>
      </Panel>
    </>
  );
}

interface RxSale { id: string; number: string; created_at: string; cashier: string; store: string; prescription: { doctor?: string; number?: string; patient?: string } | null; items: { name: string; qtyMilli: number }[] }

/** Pharmacies: who sold which prescription-only medicine, against whose prescription. */
function PrescriptionsReport({ call, storeId, from, to }: { call: Call; storeId?: string; from: string; to: string }) {
  const [rows, setRows] = useState<RxSale[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    setError(null);
    call<RxSale[]>(`/reports/prescriptions?from=${from}&to=${to}${storeId ? `&storeId=${storeId}` : ""}`).then(setRows).catch((e) => setError((e as Error).message));
  }, [call, storeId, from, to]);
  if (error) return <div className="error">{error}</div>;
  if (!rows) return <div className="muted">جاري التحميل…</div>;
  const missing = rows.filter((r) => !r.prescription || !Object.keys(r.prescription).length).length;
  const items = (r: RxSale) => r.items.map((i) => `${i.name} × ${formatQty(i.qtyMilli, false)}`).join("، ");
  return (
    <>
      <div className="kpis">
        <Kpi label="فواتير فيها دواء بوصفة" value={String(rows.length)} />
        <Kpi label="بدون بيانات وصفة" value={String(missing)} tone={missing ? "bad" : "ok"} note={missing ? "من جهاز كان مقطوع أو بكتالوج قديم" : undefined} />
      </div>
      <Panel title="الوصفات" onCsv={() => downloadCsv(`وصفات-${from}-${to}`, ["التاريخ", "الفاتورة", "الطبيب", "رقم الوصفة", "المريض", "الأدوية", "الكاشير"],
        rows.map((r) => [r.created_at.slice(0, 16).replace("T", " "), r.number, r.prescription?.doctor ?? "", r.prescription?.number ?? "", r.prescription?.patient ?? "", items(r), r.cashier]))}>
        {rows.length === 0 ? <div className="muted">ما تباعش دواء بوصفة في الفترة هذي. (الأدوية اللي بوصفة تتعلّم «💊 بوصفة طبية» في بطاقة الصنف.)</div> : (
          <table>
            <thead><tr><th>التاريخ</th><th>الفاتورة</th><th>الطبيب</th><th>رقم الوصفة</th><th>المريض</th><th>الأدوية</th><th>الكاشير</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="num">{new Date(r.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                <td className="num">{r.number}</td>
                {r.prescription && Object.keys(r.prescription).length ? (
                  <><td>{r.prescription.doctor ?? "—"}</td><td className="num">{r.prescription.number ?? "—"}</td><td>{r.prescription.patient ?? "—"}</td></>
                ) : <td colSpan={3}><span className="badge bad">ما تسجلتش وصفة</span></td>}
                <td>{items(r)}</td>
                <td>{r.cashier}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
