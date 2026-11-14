import { useEffect, useMemo, useState } from "react";
import { ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, formatMoney, toMinor, type CatalogProduct, type OrderType } from "@pos/shared";
import type { Call } from "./Admin";

interface Table { id: string; name: string; area: string | null; seats: number; sort: number; active: boolean }
interface RecipeRow { productId: string; name: string; priceMinor: number; costMinor: number; ingredients: number }
interface Report { byType: { orderType: OrderType; count: number; totalMinor: number }[]; byTable: { table: string; count: number; totalMinor: number }[]; kitchen: { tickets: number; avgMinutes: number | null; slowMinutes: number | null } }

const local = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(d);
const base = (p: CatalogProduct) => p.units.find((u) => u.isBase) ?? p.units[0];

/** A restaurant's back office: the tables on the floor, what goes into each dish, and how the service went. */
export function Restaurant({ call, storeId }: { call: Call; storeId: string }) {
  const [tab, setTab] = useState<"tables" | "recipes" | "report">("tables");
  return (
    <div className="stack">
      <div className="seg" role="tablist">
        <button className={tab === "tables" ? "active" : ""} onClick={() => setTab("tables")}>🪑 الطاولات</button>
        <button className={tab === "recipes" ? "active" : ""} onClick={() => setTab("recipes")}>🧾 الوصفات والتكلفة</button>
        <button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>📊 أداء المطعم</button>
      </div>
      {tab === "tables" && <Tables call={call} storeId={storeId} />}
      {tab === "recipes" && <Recipes call={call} storeId={storeId} />}
      {tab === "report" && <Performance call={call} storeId={storeId} />}
    </div>
  );
}

function Tables({ call, storeId }: { call: Call; storeId: string }) {
  const [rows, setRows] = useState<Table[]>([]);
  const [count, setCount] = useState("10");
  const [area, setArea] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => call<Table[]>(`/restaurant/tables?storeId=${storeId}`).then(setRows);
  useEffect(() => void load(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await f();
      await load();
      if (ok) setMsg({ text: ok });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  };
  const save = (t: Table, patch: Partial<Table>) => run(() => call(`/restaurant/tables/${t.id}`, { method: "PUT", body: { name: t.name, area: t.area, seats: t.seats, sort: t.sort, active: t.active, ...patch } }));
  const areas = [...new Set(rows.map((t) => t.area ?? ""))];
  return (
    <>
      <div className="card stack">
        <b>أضف طاولات</b>
        <div className="row" style={{ alignItems: "end" }}>
          <label>العدد<input className="num" style={{ width: 90 }} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>
          <label>القسم (اختياري)<input value={area} onChange={(e) => setArea(e.target.value)} placeholder="الصالة، التراس، العائلات" /></label>
          <button className="primary" onClick={() => void run(async () => {
            const r = await call<{ added: number }>("/restaurant/tables/bulk", { body: { storeId, count: Number(count) || 0, area: area || null, from: rows.length + 1 } });
            setMsg({ text: `تمت إضافة ${r.added} طاولة` });
          })}>أضف «طاولة {rows.length + 1}» وما بعدها</button>
          <span className="spacer" />
          <label>أو طاولة باسم<input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: VIP" /></label>
          <button disabled={!name.trim()} onClick={() => void run(() => call("/restaurant/tables", { body: { storeId, name, area: area || null, sort: rows.length + 1 } }).then(() => setName("")), "تمت الإضافة")}>أضف</button>
        </div>
        {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
        <div className="hint">الطاولات توصل لجهاز الكاشير مع المزامنة. الكاشير يختار الطاولة ويخلّي طلبها مفتوح لين يدفع.</div>
      </div>
      <div className="card">
        {rows.length === 0 ? <p className="muted">ما فيش طاولات لسا.</p> : areas.map((a) => (
          <div key={a} className="stack" style={{ marginBottom: 12 }}>
            {areas.length > 1 && <b>{a || "بدون قسم"}</b>}
            <table>
              <thead><tr><th>الطاولة</th><th>القسم</th><th>الكراسي</th><th>الحالة</th><th /></tr></thead>
              <tbody>
                {rows.filter((t) => (t.area ?? "") === a).map((t) => (
                  <tr key={t.id}>
                    <td><input defaultValue={t.name} onBlur={(e) => e.target.value.trim() && e.target.value !== t.name && void save(t, { name: e.target.value.trim() })} aria-label="اسم الطاولة" /></td>
                    <td><input defaultValue={t.area ?? ""} onBlur={(e) => e.target.value !== (t.area ?? "") && void save(t, { area: e.target.value || null })} aria-label="القسم" /></td>
                    <td><input className="num" style={{ width: 70 }} defaultValue={t.seats} onBlur={(e) => Number(e.target.value) !== t.seats && Number(e.target.value) > 0 && void save(t, { seats: Number(e.target.value) })} aria-label="الكراسي" /></td>
                    <td><label className="check"><input type="checkbox" checked={t.active} onChange={(e) => void save(t, { active: e.target.checked })} />{t.active ? "شغالة" : "موقوفة"}</label></td>
                    <td><button className="danger" onClick={() => confirm(`نحذفوا ${t.name}؟`) && void run(() => call(`/restaurant/tables/${t.id}`, { method: "DELETE" }))}>حذف</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}

interface Line { ingredientId: string; qty: string }

/**
 * What goes into one of each dish, in the ingredient's own unit (grams, ml, pieces). Selling the dish
 * takes them out of stock, and its cost is what they cost, so the profit is the real one.
 */
function Recipes({ call, storeId }: { call: Call; storeId: string }) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [list, setList] = useState<RecipeRow[]>([]);
  const [dish, setDish] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = async () => {
    setProducts(await call<CatalogProduct[]>(`/products?storeId=${storeId}`));
    setList(await call<RecipeRow[]>("/recipes"));
  };
  useEffect(() => void load(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const withRecipe = new Set(list.map((r) => r.productId));

  async function open(id: string) {
    setDish(id);
    setMsg(null);
    if (!id) return setLines([]);
    const r = await call<{ lines: { ingredientId: string; qtyMilli: number }[] }>(`/recipes/${id}`);
    setLines(r.lines.length ? r.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(l.qtyMilli / 1000) })) : [{ ingredientId: "", qty: "" }]);
  }
  const qty = (s: string) => toMinor(Number(s.replace(",", ".")) || 0);
  const cost = lines.reduce((a, l) => a + Math.round(((byId.get(l.ingredientId)?.costMinor ?? 0) * qty(l.qty)) / 1000), 0);
  const price = dish ? base(byId.get(dish)!)?.priceMinor ?? 0 : 0;
  const ok = lines.every((l) => l.ingredientId && qty(l.qty) > 0) && new Set(lines.map((l) => l.ingredientId)).size === lines.length;

  async function save(empty = false) {
    setMsg(null);
    try {
      await call(`/recipes/${dish}`, { method: "PUT", body: { lines: empty ? [] : lines.map((l) => ({ ingredientId: l.ingredientId, qtyMilli: qty(l.qty) })) } });
      await load();
      if (empty) { setLines([{ ingredientId: "", qty: "" }]); setMsg({ text: "انشالت الوصفة: الصنف يرجع ينقص من مخزونه هو" }); }
      else setMsg({ text: "تم الحفظ. كل ما يتباع، المواد تنقص من المخزون." });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  const ingredients = products.filter((p) => p.active && p.id !== dish && !withRecipe.has(p.id));
  return (
    <>
      <div className="card stack">
        <label>الصنف (الوجبة أو المشروب)
          <select value={dish} onChange={(e) => void open(e.target.value)}>
            <option value="">— اختار —</option>
            {products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}{withRecipe.has(p.id) ? " ✓" : ""}</option>)}
          </select>
        </label>
        {dish && (
          <>
            <b>المواد في الحبة الوحدة</b>
            {lines.map((l, i) => {
              const ing = byId.get(l.ingredientId);
              return (
                <div className="row" key={i} style={{ flexWrap: "nowrap" }}>
                  <select style={{ flex: 2 }} value={l.ingredientId} aria-label="المادة" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}>
                    <option value="">— المادة —</option>
                    {ingredients.map((p) => <option key={p.id} value={p.id}>{p.name} ({base(p)?.name})</option>)}
                  </select>
                  <input className="num" style={{ width: 100 }} inputMode="decimal" value={l.qty} aria-label="الكمية" placeholder="الكمية" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  <span className="muted" style={{ minWidth: 60 }}>{ing ? base(ing)?.name : ""}</span>
                  <span className="num muted" style={{ minWidth: 90 }}>{ing ? formatMoney(Math.round((ing.costMinor * qty(l.qty)) / 1000)) : ""}</span>
                  <button className="danger" aria-label="شيل" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
                </div>
              );
            })}
            <div><button onClick={() => setLines([...lines, { ingredientId: "", qty: "" }])}>+ مادة</button></div>
            <div className="kpis">
              <div className="kpi"><span className="muted">تكلفة الحبة</span><b className="num">{formatMoney(cost)}</b></div>
              <div className="kpi"><span className="muted">سعر البيع</span><b className="num">{formatMoney(price)}</b></div>
              <div className="kpi"><span className="muted">الربح</span><b className="num">{price ? `${formatMoney(price - cost)} (${Math.round(((price - cost) / price) * 100)}%)` : "—"}</b></div>
            </div>
            {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
            <div className="row">
              <span className="muted">الكمية بوحدة المادة: الحليب بالمل لو وحدته مل، أو باللتر (0.2) لو وحدته لتر.</span>
              <span className="spacer" />
              {withRecipe.has(dish) && <button className="danger" onClick={() => void save(true)}>شيل الوصفة</button>}
              <button className="primary" disabled={!ok || !lines.length} onClick={() => void save()}>حفظ الوصفة</button>
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>الأصناف اللي عندها وصفة</h3>
        {list.length === 0 ? <p className="muted">ما فيش لسا. الوصفة تخلّي البيع ينقص المواد الخام (لحم، خبز، حليب) بدل الوجبة.</p> : (
          <table>
            <thead><tr><th>الصنف</th><th>المواد</th><th>التكلفة</th><th>السعر</th><th>الربح</th></tr></thead>
            <tbody>{list.map((r) => {
              const m = r.priceMinor ? Math.round(((r.priceMinor - r.costMinor) / r.priceMinor) * 100) : null;
              return (
                <tr key={r.productId} onClick={() => void open(r.productId)} style={{ cursor: "pointer" }}>
                  <td>{r.name}</td><td className="num">{r.ingredients}</td><td className="num">{formatMoney(r.costMinor)}</td><td className="num">{formatMoney(r.priceMinor)}</td>
                  <td className="num">{m === null ? "—" : <span className={m < 30 ? "badge warn" : ""}>{m}%</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Performance({ call, storeId }: { call: Call; storeId: string }) {
  const [days, setDays] = useState(1);
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    const from = local(new Date(Date.now() - (days - 1) * 864e5));
    void call<Report>(`/reports/restaurant?storeId=${storeId}&from=${from}&to=${local()}`).then(setR);
  }, [days, storeId, call]);
  const total = r?.byType.reduce((a, x) => a + x.totalMinor, 0) ?? 0;
  return (
    <div className="card stack">
      <div className="seg">
        {([[1, "اليوم"], [7, "آخر 7 أيام"], [30, "آخر 30 يوم"]] as const).map(([d, t]) => <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{t}</button>)}
      </div>
      {!r ? <p className="muted">…</p> : (
        <>
          <div className="kpis">
            {(["dine_in", "takeaway", "delivery"] as const).map((t) => {
              const x = r.byType.find((y) => y.orderType === t);
              return (
                <div className="kpi" key={t}>
                  <span className="muted">{ORDER_TYPE_ICONS[t]} {ORDER_TYPE_LABELS[t]}</span>
                  <b className="num">{formatMoney(x?.totalMinor ?? 0)}</b>
                  <small className="muted">{x?.count ?? 0} طلب{total ? ` · ${Math.round(((x?.totalMinor ?? 0) / total) * 100)}%` : ""}</small>
                </div>
              );
            })}
            <div className="kpi">
              <span className="muted">👨‍🍳 وقت التحضير</span>
              <b className="num">{r.kitchen.avgMinutes === null ? "—" : `${r.kitchen.avgMinutes} دقيقة`}</b>
              <small className="muted">{r.kitchen.tickets} طلب{r.kitchen.slowMinutes !== null ? ` · 9 من 10 قبل ${r.kitchen.slowMinutes} د` : ""}</small>
            </div>
          </div>
          <h3 style={{ margin: 0 }}>الطاولات</h3>
          {r.byTable.length === 0 ? <p className="muted">ما فيش طلبات على طاولات في الفترة هذي.</p> : (
            <table>
              <thead><tr><th>الطاولة</th><th>الطلبات</th><th>المبيعات</th><th>متوسط الطلب</th></tr></thead>
              <tbody>{r.byTable.map((t) => <tr key={t.table}><td>{t.table}</td><td className="num">{t.count}</td><td className="num">{formatMoney(t.totalMinor)}</td><td className="num">{formatMoney(Math.round(t.totalMinor / t.count))}</td></tr>)}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
