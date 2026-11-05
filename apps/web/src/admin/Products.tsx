import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";
import { ItemCard } from "./ItemCard";

export interface Dept { id: string; name: string; icon: string | null; sort: number; products: number }

type Row = CatalogProduct & { stockMilli: number | null };

interface UnitForm { id?: string; name: string; factor: string; price: string; barcodes: string; isBase: boolean }
interface Form {
  id?: string;
  name: string;
  sku: string;
  categoryId: string;
  isWeighted: boolean;
  scaleCode: string;
  cost: string;
  minStock: string;
  active: boolean;
  trackExpiry: boolean;
  units: UnitForm[];
}

function toForm(p: CatalogProduct): Form {
  return {
    id: p.id, name: p.name, sku: p.sku ?? "", categoryId: p.categoryId ?? "", isWeighted: p.isWeighted, scaleCode: p.scaleCode ?? "",
    cost: String(p.costMinor / 1000), minStock: String(p.minStockMilli / 1000), active: p.active, trackExpiry: !!p.trackExpiry,
    units: p.units.map((u) => ({ id: u.id, name: u.name, factor: String(u.factorMilli / 1000), price: String(u.priceMinor / 1000), barcodes: u.barcodes.join(", "), isBase: u.isBase })),
  };
}

export function Products({ call, storeId }: { call: Call; storeId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [cats, setCats] = useState<Dept[]>([]);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<string>("all");
  const [manage, setManage] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [card, setCard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setRows(await call<Row[]>(`/products?storeId=${storeId}`));
    setCats(await call<Dept[]>("/categories"));
  };
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const inDept = dept === "all" ? rows : rows.filter((r) => (r.categoryId ?? "none") === dept);
    if (!s) return inDept;
    return inDept.filter((r) => r.name.toLowerCase().includes(s) || r.units.some((u) => u.barcodes.some((b) => b.includes(s))));
  }, [rows, q, dept]);
  const catName = (id: string | null) => {
    const c = cats.find((x) => x.id === id);
    return c ? `${c.icon ? `${c.icon} ` : ""}${c.name}` : "";
  };
  const uncategorised = rows.filter((r) => !r.categoryId).length;

  async function save() {
    if (!form) return;
    setError(null);
    const body = {
      name: form.name,
      sku: form.sku || null,
      categoryId: form.categoryId || null,
      isWeighted: form.isWeighted,
      scaleCode: form.isWeighted ? form.scaleCode || null : null,
      costMinor: toMinor(Number(form.cost) || 0),
      minStockMilli: toMinor(Number(form.minStock) || 0),
      active: form.active,
      trackExpiry: form.trackExpiry,
      units: form.units.map((u) => ({
        id: u.id,
        name: u.name,
        factorMilli: toMinor(Number(u.factor) || 1),
        priceMinor: toMinor(Number(u.price) || 0),
        isBase: u.isBase,
        barcodes: u.barcodes.split(/[,\s]+/).filter(Boolean),
      })),
    };
    try {
      await call(form.id ? `/products/${form.id}` : "/products", { method: form.id ? "PUT" : "POST", body });
      setForm(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addCategory() {
    const name = prompt("اسم القسم الجديد");
    if (!name) return;
    const r = await call<{ id: string }>("/categories", { body: { name } });
    setCats(await call("/categories"));
    if (form) setForm({ ...form, categoryId: r.id });
  }

  const setUnit = (i: number, patch: Partial<UnitForm>) =>
    form && setForm({ ...form, units: form.units.map((u, j) => (j === i ? { ...u, ...patch } : patch.isBase ? { ...u, isBase: false } : u)) });

  if (form) {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>تعديل صنف</h2>
        <div className="kpis">
          <label>الاسم<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></label>
          <label>القسم
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">—</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
              </select>
              <button type="button" onClick={addCategory}>+</button>
            </div>
          </label>
          <label>كود داخلي (SKU)<input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></label>
          <label>التكلفة للوحدة الأساسية<input className="num" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} title="تتحدث تلقائياً من فواتير التوريد" /></label>
          <label>حد التنبيه بالنقص<input className="num" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} /></label>
        </div>
        <div className="row">
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={form.isWeighted} onChange={(e) => setForm({ ...form, isWeighted: e.target.checked, units: e.target.checked ? [{ ...form.units.find((u) => u.isBase)!, name: "كيلو", factor: "1" }] : form.units })} />
            يباع بالوزن (ميزان)
          </label>
          {form.isWeighted && (
            <label style={{ width: 200 }}>كود الصنف في الميزان<input className="num" value={form.scaleCode} onChange={(e) => setForm({ ...form, scaleCode: e.target.value.replace(/\D/g, "") })} /></label>
          )}
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            فعال
          </label>
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={form.trackExpiry} onChange={(e) => setForm({ ...form, trackExpiry: e.target.checked })} />
            خاضع للصلاحية
          </label>
        </div>
        <b>وحدات البيع</b>
        <div className="units-grid muted" style={{ fontSize: ".85rem" }}>
          <span>الوحدة</span><span>فيها كم وحدة أساسية</span><span>السعر (د.ل)</span><span>الباركود (أكثر من واحد بفاصلة)</span><span>أساسية</span><span />
        </div>
        {form.units.map((u, i) => (
          <div className="units-grid" key={i}>
            <input value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} />
            <input className="num" value={u.factor} disabled={u.isBase} onChange={(e) => setUnit(i, { factor: e.target.value })} />
            <input className="num" value={u.price} onChange={(e) => setUnit(i, { price: e.target.value })} />
            <input className="num" value={u.barcodes} onChange={(e) => setUnit(i, { barcodes: e.target.value })} />
            <input type="radio" style={{ width: "auto" }} checked={u.isBase} onChange={() => setUnit(i, { isBase: true, factor: "1" })} />
            <button className="danger" disabled={form.units.length === 1} onClick={() => setForm({ ...form, units: form.units.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        {!form.isWeighted && (
          <div><button onClick={() => setForm({ ...form, units: [...form.units, { name: "كرتونة", factor: "12", price: "", barcodes: "", isBase: false }] })}>+ وحدة (كرتونة، شد…)</button></div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={() => { setForm(null); setError(null); }}>إلغاء</button>
          <button className="primary" onClick={save} disabled={!form.name || form.units.some((u) => !u.name || u.price === "")}>حفظ</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="chips">
        <button className={dept === "all" ? "active" : ""} onClick={() => setDept("all")}>الكل <span className="count">{rows.length}</span></button>
        {cats.map((c) => (
          <button key={c.id} className={dept === c.id ? "active" : ""} onClick={() => setDept(c.id)}>
            {c.icon && <span>{c.icon}</span>} {c.name} <span className="count">{c.products}</span>
          </button>
        ))}
        {uncategorised > 0 && <button className={dept === "none" ? "active" : ""} onClick={() => setDept("none")}>بدون قسم <span className="count">{uncategorised}</span></button>}
        <button className="ghost" onClick={() => setManage(true)}>⚙ إدارة الأقسام</button>
      </div>
      <div className="row">
        <input placeholder="بحث بالاسم أو الباركود" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        <span className="spacer" />
        <button className="primary" onClick={() => setCard(true)}>+ بطاقة صنف جديدة</button>
      </div>
      {card && (
        <ItemCard call={call} initial={q.trim()} categoryId={dept !== "all" && dept !== "none" ? dept : ""} onClose={() => setCard(false)}
          onCreated={() => { setCard(false); setQ(""); void load(); }} />
      )}
      {manage && <Departments call={call} list={cats} reload={load} onClose={() => setManage(false)} />}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الصنف</th><th>القسم</th><th>الوحدات والأسعار</th><th>التكلفة</th><th>المخزون</th><th /></tr></thead>
          <tbody>
            {shown.map((p) => {
              const low = p.stockMilli !== null && p.minStockMilli > 0 && p.stockMilli <= p.minStockMilli;
              return (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td>{p.name}{p.isWeighted && <span className="muted"> ⚖️ {p.scaleCode}</span>}{p.trackExpiry && <span className="muted" title="خاضع للصلاحية"> ⏳</span>}</td>
                  <td className="muted">{catName(p.categoryId) || "—"}</td>
                  <td>{p.units.map((u) => <div key={u.id}>{u.name}{!u.isBase && <span className="muted"> ({formatQty(u.factorMilli, false)})</span>}: {u.priceMinor ? <span className="num">{formatMoney(u.priceMinor)}</span> : <span className="muted">بدون سعر</span>}</div>)}</td>
                  <td className="num">{formatMoney(p.costMinor)}</td>
                  <td><span className={low ? "badge bad" : ""}><span className="num">{formatQty(p.stockMilli ?? 0, p.isWeighted)}</span></span></td>
                  <td><button onClick={() => setForm(toForm(p))}>تعديل</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const ICONS = ["🥩", "🍗", "🐟", "🥬", "🍎", "🧀", "🥛", "🍞", "🍚", "🥫", "🥤", "☕", "🍫", "🧊", "🧴", "🧼", "🧻", "🌶️", "🍯", "🥚", "🍼", "🚬", "🔌", "📦"];

/** Add, rename, reorder and remove departments. Removing one keeps its items, without a department. */
function Departments({ call, list, reload, onClose }: { call: Call; list: Dept[]; reload: () => Promise<void>; onClose: () => void }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; icon: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  const move = (i: number, d: -1 | 1) => {
    const order = list.map((c) => c.id);
    [order[i], order[i + d]] = [order[i + d], order[i]];
    // Renumber them all, so departments that shared a number end up in a fixed order too.
    void run(() => Promise.all(order.map((id, k) => call(`/categories/${id}`, { method: "PATCH", body: { sort: k + 1 } }))));
  };
  return (
    <Modal title="أقسام المحل" onClose={onClose}>
      {edit ? (
        <>
          <label>اسم القسم<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <div className="icon-pick">
            {ICONS.map((i) => <button key={i} type="button" className={edit.icon === i ? "active" : ""} onClick={() => setEdit({ ...edit, icon: edit.icon === i ? "" : i })}>{i}</button>)}
          </div>
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setEdit(null)}>رجوع</button>
            <button className="primary" disabled={!edit.name.trim()} onClick={async () => {
              const body = { name: edit.name.trim(), icon: edit.icon || null };
              if (await run(() => call(edit.id ? `/categories/${edit.id}` : "/categories", { method: edit.id ? "PATCH" : "POST", body }))) setEdit(null);
            }}>حفظ</button>
          </div>
        </>
      ) : (
        <>
          <div className="dept-list">
            {list.map((c, i) => (
              <div key={c.id} className="dept-row">
                <span className="dept-icon">{c.icon ?? "📦"}</span>
                <span style={{ flex: 1 }}>{c.name} <span className="muted">· {c.products} صنف</span></span>
                <button className="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="لفوق">▲</button>
                <button className="ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="لتحت">▼</button>
                <button onClick={() => setEdit({ id: c.id, name: c.name, icon: c.icon ?? "" })}>تعديل</button>
                <button className="danger" onClick={() => confirm(`نحذف قسم «${c.name}»؟ الأصناف اللي فيه تبقى بدون قسم.`) && run(() => call(`/categories/${c.id}/delete`, { method: "POST" }))}>حذف</button>
              </div>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="primary" onClick={() => setEdit({ name: "", icon: "" })}>+ قسم جديد</button><span className="spacer" /><button onClick={onClose}>تم</button></div>
        </>
      )}
    </Modal>
  );
}
