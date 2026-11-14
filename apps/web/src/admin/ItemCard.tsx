import { useEffect, useState } from "react";
import { toMinor, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Pack { name: string; qty: string; barcode: string }
interface Dept { id: string; name: string; icon: string | null }

const BASE_UNITS = ["حبة", "علبة", "قنينة", "كيس", "باكو", "لتر", "متر"];
const PACKS = ["صندوق", "كرتونة", "شد", "جالون", "كيس", "باكو", "درزن", "طبقة"];
export const SIZE_SETS: [string, string[]][] = [
  ["ملابس", ["S", "M", "L", "XL", "XXL"]],
  ["أحذية", ["38", "39", "40", "41", "42", "43", "44"]],
  ["أطفال", ["2", "4", "6", "8", "10", "12"]],
];
export const COLORS = ["أبيض", "أسود", "رمادي", "كحلي", "أزرق", "أحمر", "أخضر", "بيج", "بني"];

/** Words typed with Enter or a comma become chips; a tap on a suggestion adds it. */
export function Chips({ value, onChange, suggest, label }: { value: string[]; onChange: (v: string[]) => void; suggest: string[]; label: string }) {
  const [t, setT] = useState("");
  const add = (w: string) => {
    const x = w.trim();
    if (x && !value.includes(x)) onChange([...value, x]);
    setT("");
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="chip-input" aria-label={label}>
        {value.map((v) => <span key={v} className="badge">{v}<button type="button" aria-label={`شيل ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>✕</button></span>)}
        <input value={t} placeholder={value.length ? "" : label} onChange={(e) => (/[,،]$/.test(e.target.value) ? add(e.target.value.slice(0, -1)) : setT(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(t); } else if (e.key === "Backspace" && !t && value.length) onChange(value.slice(0, -1)); }} onBlur={() => t && add(t)} />
      </div>
      <div className="row wrap" style={{ gap: 4 }}>
        {suggest.filter((x) => !value.includes(x)).map((x) => <button type="button" key={x} className="ghost" style={{ padding: "2px 8px" }} onClick={() => add(x)}>+ {x}</button>)}
      </div>
    </div>
  );
}

/**
 * A new item card: what the item is and how it comes, never what it costs or sells for. Prices
 * and quantities are entered on a supply invoice. A barcode is made when the item has none.
 */
export function ItemCard({ call, initial = "", categoryId = "", onClose, onCreated }: {
  call: Call; initial?: string; categoryId?: string; onClose: () => void; onCreated: (p: CatalogProduct) => void;
}) {
  const isCode = /^\d{6,}$/.test(initial);
  const [name, setName] = useState(isCode ? "" : initial);
  const [barcode, setBarcode] = useState(isCode ? initial : "");
  const [dept, setDept] = useState(categoryId);
  const [weighted, setWeighted] = useState(false);
  const [base, setBase] = useState("حبة");
  const [packs, setPacks] = useState<Pack[]>([]);
  const [expiry, setExpiry] = useState<boolean | null>(null);
  const [alert, setAlert] = useState({ on: false, qty: "", unit: -1 });
  const [cats, setCats] = useState<Dept[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState(false);
  // Clothing and shoes: one item per colour and size, each with its own barcode and stock.
  const [variants, setVariants] = useState(false);
  const [sizes, setSizes] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [sizeSet, setSizeSet] = useState(0);
  useEffect(() => void call<Dept[]>("/categories").then(setCats), [call]);
  useEffect(() => void call<{ tenant: { business_type?: string } }>("/me").then((m) => {
    if (m.tenant.business_type === "clothing") { setVariants(true); setExpiry(false); }
  }).catch(() => {}), [call]);
  const combos = Math.max(sizes.length, 1) * Math.max(colors.length, 1);

  const baseName = weighted ? "كيلو" : base.trim() || "حبة";
  const setPack = (i: number, patch: Partial<Pack>) => setPacks((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const packOk = packs.every((p) => p.name.trim() && Number(p.qty) > 1);
  const alertFactor = alert.unit >= 0 ? Number(packs[alert.unit]?.qty) || 1 : 1;
  const ok = variants
    ? name.trim().length >= 2 && sizes.length + colors.length > 0 && combos <= 100 && (!alert.on || Number(alert.qty) > 0)
    : name.trim().length >= 2 && packOk && expiry !== null && (!alert.on || Number(alert.qty) > 0);

  async function addDept() {
    const n = prompt("اسم القسم الجديد");
    if (!n) return;
    const r = await call<{ id: string }>("/categories", { body: { name: n } });
    setCats(await call<Dept[]>("/categories"));
    setDept(r.id);
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      if (variants) {
        const made = await call<CatalogProduct[]>("/products/variants", {
          body: { name: name.trim(), categoryId: dept || null, sizes, colors, unitName: base.trim() || "حبة", minStockMilli: alert.on ? toMinor(Number(alert.qty) || 0) : 0 },
        });
        onCreated(made[0]);
        return;
      }
      const p = await call<CatalogProduct>("/products", {
        body: {
          name: name.trim(), categoryId: dept || null, isWeighted: weighted, autoCode: true, trackExpiry: !!expiry, quick,
          minStockMilli: alert.on ? toMinor((Number(alert.qty) || 0) * alertFactor) : 0,
          units: [
            { name: baseName, factorMilli: 1000, priceMinor: 0, isBase: true, barcodes: !weighted && barcode ? [barcode] : [] },
            ...packs.map((k) => ({ name: k.name.trim(), factorMilli: toMinor(Number(k.qty)), priceMinor: 0, isBase: false, barcodes: k.barcode ? [k.barcode] : [] })),
          ],
        },
      });
      onCreated(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="بطاقة صنف جديدة" onClose={onClose}>
      <div className="item-card">
        <label>اسم الصنف<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>

        <div className="row" style={{ alignItems: "end" }}>
          <label style={{ flex: 1, minWidth: 180 }}>القسم
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <select value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="">— بدون قسم —</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
              </select>
              <button type="button" onClick={addDept} aria-label="قسم جديد">+</button>
            </div>
          </label>
          <label>طريقة البيع
            <div className="seg">
              <button type="button" className={!weighted ? "active" : ""} onClick={() => setWeighted(false)}>بالعدد</button>
              <button type="button" className={weighted ? "active" : ""} onClick={() => { setWeighted(true); setVariants(false); }}>بالوزن ⚖️</button>
            </div>
          </label>
        </div>

        <div className="seg" role="group" aria-label="نوع الصنف">
          <button type="button" className={!variants ? "active" : ""} onClick={() => setVariants(false)}>صنف واحد</button>
          <button type="button" className={variants ? "active" : ""} onClick={() => { setVariants(true); setWeighted(false); }}>👕 مقاسات وألوان</button>
        </div>

        {variants ? (
          <fieldset className="item-box stack">
            <legend>المقاسات والألوان</legend>
            <div className="row" style={{ gap: 6 }}>
              <span className="muted">المقاسات:</span>
              {SIZE_SETS.map(([n], i) => <button type="button" key={n} className={sizeSet === i ? "active ghost" : "ghost"} style={{ padding: "2px 8px" }} onClick={() => setSizeSet(i)}>{n}</button>)}
            </div>
            <Chips label="اكتب مقاس واضغط Enter" value={sizes} onChange={setSizes} suggest={SIZE_SETS[sizeSet][1]} />
            <span className="muted">الألوان:</span>
            <Chips label="اكتب لون واضغط Enter" value={colors} onChange={setColors} suggest={COLORS} />
            {sizes.length + colors.length > 0 && (
              <div className={combos > 100 ? "error" : "hint"}>
                {combos > 100 ? "أكثر من 100 نوع، قسّمهم على بطاقتين" : `يتعمل ${combos} صنف، كل واحد بباركود ومخزون خاص بيه: مثلاً «${[name.trim() || "الصنف", colors[0], sizes[0]].filter(Boolean).join(" - ")}»`}
              </div>
            )}
          </fieldset>
        ) : weighted ? (
          <div className="hint">⚖️ يتباع بالكيلو، وكود الميزان يتعطى له تلقائياً.</div>
        ) : (
          <div className="row" style={{ alignItems: "end" }}>
            <label style={{ width: 130 }}>وحدة البيع
              <input list="item-base-units" value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
            <label style={{ flex: 1, minWidth: 180 }}>الباركود
              <input className="num" value={barcode} onChange={(e) => setBarcode(e.target.value.replace(/\s/g, ""))} placeholder="امسحه أو اتركه فاضي" />
            </label>
          </div>
        )}
        {!variants && !weighted && !barcode && <div className="hint">🏷️ ما فيش باركود؟ يتعمل له باركود خاص بالمحل تلقائياً وتقدر تطبعه ملصق.</div>}

        {!variants && <fieldset className="item-box">
          <legend>التعبئة</legend>
          {packs.length === 0 && <div className="muted">يجي فرادى. لو يجي في صندوق أو جالون ضيف التعبئة.</div>}
          {packs.map((k, i) => (
            <div className="pack-row" key={i}>
              <input list="item-packs" value={k.name} onChange={(e) => setPack(i, { name: e.target.value })} aria-label="نوع التعبئة" />
              <span className="muted">فيه</span>
              <input className="num" inputMode="decimal" value={k.qty} onChange={(e) => setPack(i, { qty: e.target.value })} aria-label="العدد" />
              <span>{baseName}</span>
              <input className="num" value={k.barcode} onChange={(e) => setPack(i, { barcode: e.target.value.replace(/\s/g, "") })} placeholder="باركود التعبئة (اختياري)" aria-label="باركود التعبئة" />
              <button type="button" className="danger" onClick={() => { setPacks((ps) => ps.filter((_, j) => j !== i)); setAlert((a) => ({ ...a, unit: -1 })); }} aria-label="شيل">✕</button>
            </div>
          ))}
          {packs.length < 3 && (
            <div><button type="button" onClick={() => setPacks((ps) => [...ps, ps.length ? { name: "كرتونة", qty: "", barcode: "" } : { name: weighted ? "كيس" : "صندوق", qty: weighted ? "25" : "24", barcode: "" }])}>+ تعبئة (صندوق، جالون، كرتونة…)</button></div>
          )}
          {packs.some((k) => Number(k.qty) > 1) && (
            <div className="hint">{packs.filter((k) => Number(k.qty) > 1).map((k) => `${k.name} = ${k.qty} ${baseName}`).join(" · ")}</div>
          )}
        </fieldset>}

        {!variants && <div className="row" style={{ alignItems: "center" }}>
          <span>خاضع للصلاحية؟</span>
          <div className="seg">
            <button type="button" className={expiry === true ? "active" : ""} onClick={() => setExpiry(true)}>نعم</button>
            <button type="button" className={expiry === false ? "active" : ""} onClick={() => setExpiry(false)}>لا</button>
          </div>
          {expiry && <span className="muted">تاريخ الصلاحية يتطلب في كل فاتورة توريد.</span>}
        </div>}

        {!variants && (
          <label className="row" style={{ color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={quick} onChange={(e) => setQuick(e.target.checked)} />
            ⭐ زر سريع في شاشة الكاشير (للخبز والخضرة والأصناف اللي ما عندهاش باركود)
          </label>
        )}

        <label className="row" style={{ color: "var(--ink)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={alert.on} onChange={(e) => setAlert({ ...alert, on: e.target.checked })} />
          نبهني لما يقل المخزون (اختياري)
        </label>
        {alert.on && (
          <div className="row" style={{ alignItems: "center" }}>
            <span>لما يوصل</span>
            <input className="num" inputMode="decimal" value={alert.qty} onChange={(e) => setAlert({ ...alert, qty: e.target.value })} style={{ width: 90 }} aria-label="حد التنبيه" autoFocus />
            <select value={alert.unit} onChange={(e) => setAlert({ ...alert, unit: Number(e.target.value) })} style={{ width: "auto" }} aria-label="وحدة حد التنبيه">
              <option value={-1}>{baseName}</option>
              {packs.map((k, i) => k.name.trim() && Number(k.qty) > 1 && <option key={i} value={i}>{k.name}</option>)}
            </select>
            <span className="muted">أو أقل</span>
          </div>
        )}

        <div className="hint">💰 الأسعار والكمية تدخلهم في فاتورة التوريد، مش في بطاقة الصنف.</div>
        {!variants && expiry === null && name.trim().length >= 2 && <div className="muted">اختار إذا كان الصنف خاضع للصلاحية.</div>}
        {error && <div className="error">{error}</div>}
        <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!ok || busy} onClick={save}>حفظ البطاقة</button></div>
      </div>
      <datalist id="item-base-units">{BASE_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      <datalist id="item-packs">{PACKS.map((u) => <option key={u} value={u} />)}</datalist>
    </Modal>
  );
}
