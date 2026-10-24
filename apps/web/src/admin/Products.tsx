import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import type { Call } from "./Admin";

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
  units: UnitForm[];
}

const blank = (): Form => ({
  name: "", sku: "", categoryId: "", isWeighted: false, scaleCode: "", cost: "0", minStock: "0", active: true,
  units: [{ name: "حبة", factor: "1", price: "", barcodes: "", isBase: true }],
});

function toForm(p: CatalogProduct): Form {
  return {
    id: p.id, name: p.name, sku: p.sku ?? "", categoryId: p.categoryId ?? "", isWeighted: p.isWeighted, scaleCode: p.scaleCode ?? "",
    cost: String(p.costMinor / 1000), minStock: String(p.minStockMilli / 1000), active: p.active,
    units: p.units.map((u) => ({ id: u.id, name: u.name, factor: String(u.factorMilli / 1000), price: String(u.priceMinor / 1000), barcodes: u.barcodes.join(", "), isBase: u.isBase })),
  };
}

export function Products({ call, storeId }: { call: Call; storeId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setRows(await call<Row[]>(`/products?storeId=${storeId}`));
    setCats(await call<{ id: string; name: string }[]>("/categories"));
  };
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.units.some((u) => u.barcodes.some((b) => b.includes(s))));
  }, [rows, q]);

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

  async function receive(p: Row) {
    const unit = p.units.find((u) => u.isBase)!;
    const qty = prompt(`كمية الاستلام لـ ${p.name} (${unit.name})`);
    if (!qty || !(Number(qty) > 0)) return;
    const cost = prompt("تكلفة الوحدة (د.ل)", String(p.costMinor / 1000));
    await call("/purchases", { body: { storeId, lines: [{ unitId: unit.id, qtyMilli: toMinor(Number(qty)), unitCostMinor: toMinor(Number(cost) || 0) }] } });
    await load();
  }

  async function addCategory() {
    const name = prompt("اسم التصنيف");
    if (!name) return;
    await call("/categories", { body: { name } });
    setCats(await call("/categories"));
  }

  const setUnit = (i: number, patch: Partial<UnitForm>) =>
    form && setForm({ ...form, units: form.units.map((u, j) => (j === i ? { ...u, ...patch } : patch.isBase ? { ...u, isBase: false } : u)) });

  if (form) {
    return (
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{form.id ? "تعديل صنف" : "صنف جديد"}</h2>
        <div className="kpis">
          <label>الاسم<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></label>
          <label>التصنيف
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">—</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={addCategory}>+</button>
            </div>
          </label>
          <label>كود داخلي (SKU)<input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></label>
          <label>التكلفة للوحدة الأساسية<input className="num" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></label>
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
      <div className="row">
        <input placeholder="بحث بالاسم أو الباركود" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        <span className="spacer" />
        <button className="primary" onClick={() => setForm(blank())}>+ صنف جديد</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الصنف</th><th>الوحدات والأسعار</th><th>التكلفة</th><th>المخزون</th><th /></tr></thead>
          <tbody>
            {shown.map((p) => {
              const low = p.stockMilli !== null && p.minStockMilli > 0 && p.stockMilli <= p.minStockMilli;
              return (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td>{p.name}{p.isWeighted && <span className="muted"> ⚖️ {p.scaleCode}</span>}</td>
                  <td>{p.units.map((u) => <div key={u.id}>{u.name}: <span className="num">{formatMoney(u.priceMinor)}</span></div>)}</td>
                  <td className="num">{formatMoney(p.costMinor)}</td>
                  <td><span className={low ? "badge bad" : ""}><span className="num">{formatQty(p.stockMilli ?? 0, p.isWeighted)}</span></span></td>
                  <td className="row">
                    <button onClick={() => setForm(toForm(p))}>تعديل</button>
                    <button onClick={() => receive(p)}>استلام بضاعة</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
