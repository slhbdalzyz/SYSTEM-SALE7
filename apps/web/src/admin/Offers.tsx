import { useEffect, useMemo, useState } from "react";
import { formatMoney, offerLive, toMinor, type CatalogProduct, type Offer, type OfferKind } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call, Me } from "./Admin";

type Row = Offer & { salesCount: number; givenMinor: number };

const KINDS: Record<OfferKind, string> = {
  percent: "خصم بالنسبة",
  amount: "خصم مبلغ على كل وحدة",
  buy_get: "اشري وخوذ ببلاش",
  bundle: "عدد بسعر (مثلاً 3 بـ 10 د.ل)",
};
// Saturday first, the way the week runs here; values are JS day numbers.
const DAYS: [number, string][] = [[6, "السبت"], [0, "الأحد"], [1, "الاثنين"], [2, "الثلاثاء"], [3, "الأربعاء"], [4, "الخميس"], [5, "الجمعة"]];

export function describe(o: Offer) {
  switch (o.kind) {
    case "percent": return `${(o.percentBp ?? 0) / 100}% خصم`;
    case "amount": return `${formatMoney(o.amountMinor ?? 0)} خصم على الوحدة`;
    case "buy_get": return `اشري ${o.buyQty} وخوذ ${o.getQty} ببلاش`;
    case "bundle": return `${o.bundleQty} بـ ${formatMoney(o.bundlePriceMinor ?? 0)}`;
  }
}

function status(o: Offer, now: Date): [string, string] {
  if (!o.active) return ["موقوف", ""];
  if (o.endsAt && new Date(o.endsAt) <= now) return ["انتهى", ""];
  if (o.startsAt && new Date(o.startsAt) > now) return ["مجدول", "off"];
  return offerLive(o, now, null) ? ["شغال الآن", "ok"] : ["خارج أوقاته", "off"];
}

const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "");

interface Form {
  id?: string; name: string; kind: OfferKind; value: string; buy: string; get: string; bundleQty: string; bundlePrice: string;
  scope: "all" | "products" | "categories"; productIds: string[]; categoryIds: string[]; storeIds: string[];
  startsAt: string; endsAt: string; days: number[]; hourFrom: string; hourTo: string; active: boolean;
}

const blank: Form = {
  name: "", kind: "buy_get", value: "", buy: "2", get: "1", bundleQty: "3", bundlePrice: "", scope: "products", productIds: [], categoryIds: [],
  storeIds: [], startsAt: "", endsAt: "", days: [], hourFrom: "", hourTo: "", active: true,
};

function toForm(o: Offer): Form {
  return {
    id: o.id, name: o.name, kind: o.kind,
    value: o.kind === "percent" ? String((o.percentBp ?? 0) / 100) : o.kind === "amount" ? String((o.amountMinor ?? 0) / 1000) : "",
    buy: String(o.buyQty ?? 2), get: String(o.getQty ?? 1), bundleQty: String(o.bundleQty ?? 3), bundlePrice: o.bundlePriceMinor !== null ? String(o.bundlePriceMinor / 1000) : "",
    scope: o.productIds.length ? "products" : o.categoryIds.length ? "categories" : "all", productIds: o.productIds, categoryIds: o.categoryIds, storeIds: o.storeIds,
    startsAt: toLocal(o.startsAt), endsAt: toLocal(o.endsAt), days: o.days, hourFrom: o.hourFrom === null ? "" : String(o.hourFrom), hourTo: o.hourTo === null ? "" : String(o.hourTo), active: o.active,
  };
}

function toBody(f: Form) {
  const num = (s: string) => (s === "" ? null : Number(s));
  return {
    name: f.name, kind: f.kind,
    percentBp: f.kind === "percent" ? Math.round(Number(f.value) * 100) : null,
    amountMinor: f.kind === "amount" ? toMinor(Number(f.value)) : null,
    buyQty: f.kind === "buy_get" ? Number(f.buy) : null,
    getQty: f.kind === "buy_get" ? Number(f.get) : null,
    bundleQty: f.kind === "bundle" ? Number(f.bundleQty) : null,
    bundlePriceMinor: f.kind === "bundle" && f.bundlePrice !== "" ? toMinor(Number(f.bundlePrice)) : null,
    productIds: f.scope === "products" ? f.productIds : [],
    categoryIds: f.scope === "categories" ? f.categoryIds : [],
    storeIds: f.storeIds,
    startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null,
    endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
    days: f.days,
    hourFrom: num(f.hourFrom),
    hourTo: num(f.hourTo),
    active: f.active,
  };
}

export function Offers({ call, storeId, stores }: { call: Call; storeId: string; stores: Me["stores"] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<Row[]>("/offers").then(setRows);
  useEffect(() => {
    void load();
    void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then(setProducts);
    void call<typeof cats>("/categories").then(setCats);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const now = new Date();
  const names = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const catNames = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);

  async function save(f: Form) {
    setError(null);
    try {
      await call(f.id ? `/offers/${f.id}` : "/offers", { method: f.id ? "PUT" : "POST", body: toBody(f) });
      setForm(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const scopeText = (o: Offer) =>
    o.productIds.length ? o.productIds.map((id) => names.get(id) ?? "؟").join("، ")
      : o.categoryIds.length ? `قسم: ${o.categoryIds.map((id) => catNames.get(id) ?? "؟").join("، ")}` : "كل الأصناف";

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">العروض تتطبق على الكاشير تلقائياً، حتى بدون نت، وتطلع على الإيصال.</span>
        <span className="spacer" />
        <button className="primary" onClick={() => { setError(null); setForm({ ...blank }); }}>+ عرض جديد</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>العرض</th><th>على</th><th>الفترة</th><th>الحالة</th><th>فواتير</th><th>وفّر للزباين</th><th /></tr></thead>
          <tbody>
            {rows.map((o) => {
              const [label, cls] = status(o, now);
              return (
                <tr key={o.id} style={{ opacity: o.active ? 1 : 0.55 }}>
                  <td><b>{o.name}</b><div className="muted">{describe(o)}</div></td>
                  <td style={{ maxWidth: 260 }}>{scopeText(o)}</td>
                  <td className="num">
                    {o.startsAt || o.endsAt ? <>{when(o.startsAt) || "من الآن"} ← {when(o.endsAt) || "مفتوح"}</> : "مفتوح"}
                    {(o.days.length > 0 || o.hourFrom !== null) && (
                      <div className="muted">
                        {o.days.length > 0 && DAYS.filter(([d]) => o.days.includes(d)).map(([, n]) => n).join("، ")}
                        {o.hourFrom !== null && ` ${o.hourFrom}:00–${o.hourTo}:00`}
                      </div>
                    )}
                  </td>
                  <td><span className={`badge ${cls}`}>{label}</span></td>
                  <td className="num">{o.salesCount}</td>
                  <td className="num">{formatMoney(o.givenMinor)}</td>
                  <td className="row">
                    <button onClick={() => { setError(null); setForm(toForm(o)); }}>تعديل</button>
                    <button onClick={() => save({ ...toForm(o), active: !o.active })}>{o.active ? "إيقاف" : "تشغيل"}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted" style={{ padding: 16 }}>ما فيش عروض. جرّب «اشري 2 وخوذ 1 ببلاش» على صنف.</p>}
      </div>
      {error && !form && <div className="error">{error}</div>}
      {form && <OfferForm form={form} setForm={setForm} products={products} cats={cats} stores={stores.filter((s) => s.active)} error={error} onSave={save} />}
    </div>
  );
}

function OfferForm({ form: f, setForm, products, cats, stores, error, onSave }: {
  form: Form; setForm: (f: Form | null) => void; products: CatalogProduct[]; cats: { id: string; name: string }[];
  stores: Me["stores"]; error: string | null; onSave: (f: Form) => void;
}) {
  const set = (p: Partial<Form>) => setForm({ ...f, ...p });
  const [find, setFind] = useState("");
  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return products.filter((p) => !f.productIds.includes(p.id) && (p.name.toLowerCase().includes(q) || p.units.some((u) => u.barcodes.includes(q)))).slice(0, 8);
  }, [find, products, f.productIds]);
  const toggle = (list: number[] | string[], v: never) => ((list as never[]).includes(v) ? (list as never[]).filter((x) => x !== v) : [...list, v]);
  const hours = Array.from({ length: 25 }, (_, i) => i);
  const valid =
    f.name.length >= 2 &&
    (f.kind === "percent" ? Number(f.value) > 0 && Number(f.value) <= 100
      : f.kind === "amount" ? Number(f.value) > 0
      : f.kind === "buy_get" ? Number(f.buy) >= 1 && Number(f.get) >= 1
      : Number(f.bundleQty) >= 2 && f.bundlePrice !== "") &&
    (f.scope !== "products" || f.productIds.length > 0) &&
    (f.scope !== "categories" || f.categoryIds.length > 0) &&
    (f.hourFrom === "") === (f.hourTo === "");

  return (
    <Modal title={f.id ? "تعديل عرض" : "عرض جديد"} onClose={() => setForm(null)}>
      <label>اسم العرض (يطلع على الإيصال)<input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="مثلاً: ياغورت 2+1" autoFocus /></label>
      <label>نوع العرض
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value as OfferKind })}>
          {(Object.keys(KINDS) as OfferKind[]).map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
        </select>
      </label>
      <div className="row">
        {f.kind === "percent" && <label>النسبة %<input className="num" value={f.value} onChange={(e) => set({ value: e.target.value })} style={{ width: 100 }} /></label>}
        {f.kind === "amount" && <label>الخصم على كل وحدة (د.ل)<input className="num" value={f.value} onChange={(e) => set({ value: e.target.value })} style={{ width: 120 }} /></label>}
        {f.kind === "buy_get" && (
          <>
            <label>اشري<input className="num" value={f.buy} onChange={(e) => set({ buy: e.target.value })} style={{ width: 70 }} /></label>
            <label>وخوذ ببلاش<input className="num" value={f.get} onChange={(e) => set({ get: e.target.value })} style={{ width: 70 }} /></label>
          </>
        )}
        {f.kind === "bundle" && (
          <>
            <label>العدد<input className="num" value={f.bundleQty} onChange={(e) => set({ bundleQty: e.target.value })} style={{ width: 70 }} /></label>
            <label>بسعر (د.ل)<input className="num" value={f.bundlePrice} onChange={(e) => set({ bundlePrice: e.target.value })} style={{ width: 100 }} /></label>
          </>
        )}
      </div>
      {(f.kind === "buy_get" || f.kind === "bundle") && (
        <div className="muted">يتحسب بالحبة (الوحدة الأساسية). الأرخص هو اللي يطلع ببلاش، وتقدر تخلط أصناف العرض مع بعض.</div>
      )}

      <label>على
        <select value={f.scope} onChange={(e) => set({ scope: e.target.value as Form["scope"] })}>
          <option value="products">أصناف معينة</option>
          <option value="categories">أقسام</option>
          <option value="all">كل الأصناف</option>
        </select>
      </label>
      {f.scope === "products" && (
        <div className="stack">
          <div className="row">
            {f.productIds.map((id) => (
              <span key={id} className="badge">{products.find((p) => p.id === id)?.name ?? "؟"} <button className="link" onClick={() => set({ productIds: f.productIds.filter((x) => x !== id) })}>✕</button></span>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <input placeholder="امسح باركود أو اكتب اسم صنف" value={find} onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { set({ productIds: [...f.productIds, matches[0].id] }); setFind(""); } }} />
            {matches.length > 0 && (
              <div className="results">
                {matches.map((p) => <button key={p.id} onClick={() => { set({ productIds: [...f.productIds, p.id] }); setFind(""); }}><span>{p.name}</span></button>)}
              </div>
            )}
          </div>
        </div>
      )}
      {f.scope === "categories" && (
        <div className="row">
          {cats.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={f.categoryIds.includes(c.id)} onChange={() => set({ categoryIds: toggle(f.categoryIds, c.id as never) as string[] })} /> {c.name}</label>
          ))}
        </div>
      )}

      <div className="row">
        <label>يبدا<input type="datetime-local" value={f.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></label>
        <label>ينتهي<input type="datetime-local" value={f.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></label>
      </div>
      <div className="row">
        <span className="muted">الأيام:</span>
        {DAYS.map(([d, n]) => (
          <label key={d} className="check"><input type="checkbox" checked={f.days.includes(d)} onChange={() => set({ days: toggle(f.days, d as never) as number[] })} /> {n}</label>
        ))}
        <span className="muted">(بدون اختيار = كل الأيام)</span>
      </div>
      <div className="row">
        <label>من الساعة
          <select value={f.hourFrom} onChange={(e) => set({ hourFrom: e.target.value })} style={{ width: "auto" }}>
            <option value="">طول اليوم</option>
            {hours.slice(0, 24).map((h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
        </label>
        <label>للساعة
          <select value={f.hourTo} onChange={(e) => set({ hourTo: e.target.value })} style={{ width: "auto" }}>
            <option value="">طول اليوم</option>
            {hours.slice(1).map((h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
        </label>
      </div>
      {stores.length > 1 && (
        <div className="row">
          <span className="muted">الفروع:</span>
          {stores.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={f.storeIds.includes(s.id)} onChange={() => set({ storeIds: toggle(f.storeIds, s.id as never) as string[] })} /> {s.name}</label>
          ))}
          <span className="muted">(بدون اختيار = كل الفروع)</span>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> شغال</label>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={() => setForm(null)}>إلغاء</button><button className="primary" disabled={!valid} onClick={() => onSave(f)}>حفظ</button></div>
    </Modal>
  );
}
