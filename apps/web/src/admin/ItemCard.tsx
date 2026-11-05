import { useEffect, useState } from "react";
import { toMinor, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Pack { name: string; qty: string; barcode: string }
interface Dept { id: string; name: string; icon: string | null }

const BASE_UNITS = ["حبة", "علبة", "قنينة", "كيس", "باكو", "لتر", "متر"];
const PACKS = ["صندوق", "كرتونة", "شد", "جالون", "كيس", "باكو", "درزن", "طبقة"];

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
  useEffect(() => void call<Dept[]>("/categories").then(setCats), [call]);

  const baseName = weighted ? "كيلو" : base.trim() || "حبة";
  const setPack = (i: number, patch: Partial<Pack>) => setPacks((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const packOk = packs.every((p) => p.name.trim() && Number(p.qty) > 1);
  const alertFactor = alert.unit >= 0 ? Number(packs[alert.unit]?.qty) || 1 : 1;
  const ok = name.trim().length >= 2 && packOk && expiry !== null && (!alert.on || Number(alert.qty) > 0);

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
      const p = await call<CatalogProduct>("/products", {
        body: {
          name: name.trim(), categoryId: dept || null, isWeighted: weighted, autoCode: true, trackExpiry: !!expiry,
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
              <button type="button" className={weighted ? "active" : ""} onClick={() => setWeighted(true)}>بالوزن ⚖️</button>
            </div>
          </label>
        </div>

        {weighted ? (
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
        {!weighted && !barcode && <div className="hint">🏷️ ما فيش باركود؟ يتعمل له باركود خاص بالمحل تلقائياً وتقدر تطبعه ملصق.</div>}

        <fieldset className="item-box">
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
        </fieldset>

        <div className="row" style={{ alignItems: "center" }}>
          <span>خاضع للصلاحية؟</span>
          <div className="seg">
            <button type="button" className={expiry === true ? "active" : ""} onClick={() => setExpiry(true)}>نعم</button>
            <button type="button" className={expiry === false ? "active" : ""} onClick={() => setExpiry(false)}>لا</button>
          </div>
          {expiry && <span className="muted">تاريخ الصلاحية يتطلب في كل فاتورة توريد.</span>}
        </div>

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
        {expiry === null && name.trim().length >= 2 && <div className="muted">اختار إذا كان الصنف خاضع للصلاحية.</div>}
        {error && <div className="error">{error}</div>}
        <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button><button className="primary" disabled={!ok || busy} onClick={save}>حفظ البطاقة</button></div>
      </div>
      <datalist id="item-base-units">{BASE_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      <datalist id="item-packs">{PACKS.map((u) => <option key={u} value={u} />)}</datalist>
    </Modal>
  );
}
