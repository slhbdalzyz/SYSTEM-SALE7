import { useState } from "react";
import { formatMoney, formatQty, toMinor, variantGrid, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";
import { COLORS, Chips, SIZE_SETS } from "./ItemCard";
import type { LabelDraft } from "./Labels";

type Piece = CatalogProduct & { stockMilli: number | null };
interface Dept { id: string; name: string; icon: string | null }

const base = (p: CatalogProduct) => p.units.find((u) => u.isBase) ?? p.units[0];

/**
 * One clothing model on one page: what is left of each colour and size, the price and cost every
 * piece shares, new colours or sizes, and a tag for each piece.
 */
export function ModelSheet({ call, pieces, cats, onEditPiece, onLabels, onChanged, onClose }: {
  call: Call;
  pieces: Piece[];
  cats: Dept[];
  onEditPiece: (p: Piece) => void;
  onLabels?: (d: LabelDraft[]) => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const g = variantGrid(pieces);
  const group = pieces[0].groupId!;
  const first = pieces[0];
  const prices = [...new Set(pieces.map((p) => base(p).priceMinor))];
  const [f, setF] = useState({
    name: g.name, categoryId: first.categoryId ?? "", price: prices.length === 1 ? String(prices[0] / 1000) : "",
    cost: String(first.costMinor / 1000), min: String(first.minStockMilli / 1000),
  });
  const [add, setAdd] = useState<{ sizes: string[]; colors: string[] } | null>(null);
  const [sizeSet, setSizeSet] = useState(/^\d/.test(g.sizes[0] ?? "") ? 1 : 0);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const stock = (p: Piece | undefined) => p?.stockMilli ?? 0;
  const total = pieces.reduce((a, p) => a + stock(p), 0);
  const out = pieces.filter((p) => p.active && stock(p) <= 0).length;

  async function run(fn: () => Promise<string>) {
    setMsg(null);
    setBusy(true);
    try {
      const text = await fn();
      await onChanged();
      setMsg({ text });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => {
    const body: Record<string, unknown> = {
      name: f.name.trim(), categoryId: f.categoryId || null, costMinor: toMinor(Number(f.cost) || 0), minStockMilli: toMinor(Number(f.min) || 0),
    };
    if (f.price !== "") body.priceMinor = toMinor(Number(f.price) || 0);
    const r = await call<{ pieces: number }>(`/products/groups/${group}`, { method: "PATCH", body });
    return `تم الحفظ على ${r.pieces} قطعة`;
  });

  const addMore = () => add && run(async () => {
    const made = await call<CatalogProduct[]>(`/products/groups/${group}/add`, { body: add });
    setAdd(null);
    return `تمت إضافة ${made.length} نوع جديد، كل واحد بباركود`;
  });

  return (
    <Modal title={`👕 ${g.name}`} onClose={onClose} wide>
      <div className="muted">
        {pieces.length} نوع · المخزون <b className="num">{formatQty(total, false)}</b> قطعة
        {out > 0 && <> · <span className="badge bad">{out} خالص</span></>}
      </div>

      <div className="variant-grid" style={{ gridTemplateColumns: `auto repeat(${g.sizes.length}, minmax(52px, 1fr)) auto` }}>
        <span />
        {g.sizes.map((s) => <b key={s} className="vg-head">{s || "—"}</b>)}
        <b className="vg-head muted">المجموع</b>
        {g.colors.map((c) => (
          <div key={c} style={{ display: "contents" }}>
            <b className="vg-color">{c || "—"}</b>
            {g.sizes.map((s) => {
              const p = g.at(c, s);
              if (!p) return <span key={s} className="vg-none">—</span>;
              const q = stock(p);
              const cls = q <= 0 ? "out" : p.minStockMilli > 0 && q <= p.minStockMilli ? "low" : "";
              return (
                <button key={s} className={`vg-stock ${cls}`} style={{ opacity: p.active ? 1 : 0.45 }} onClick={() => onEditPiece(p)}
                  title={`${p.name}\n${base(p).barcodes[0] ?? ""}\n${formatMoney(base(p).priceMinor)}`}>
                  {formatQty(q, false)}
                </button>
              );
            })}
            <span className="vg-stock muted">{formatQty(g.sizes.reduce((a, s) => a + stock(g.at(c, s)), 0), false)}</span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: ".85rem" }}>اضغط على أي خانة تفتح القطعة نفسها (الباركود، توقيفها…). الأحمر خالص، والبرتقالي تحت حد التنبيه.</div>

      <fieldset className="item-box stack">
        <legend>للموديل كله</legend>
        <div className="kpis">
          <label>اسم الموديل<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>القسم
            <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              <option value="">—</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ""}{c.name}</option>)}
            </select>
          </label>
          <label>سعر البيع (د.ل)<input className="num" value={f.price} placeholder={prices.length > 1 ? "أسعار مختلفة، اتركه يبقوا" : ""} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
          <label>التكلفة<input className="num" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>
          <label>نبّهني لما يوصل كل مقاس<input className="num" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></label>
        </div>
        <div className="row"><span className="spacer" /><button className="primary" disabled={busy || f.name.trim().length < 2} onClick={() => void save()}>حفظ على كل القطع</button></div>
      </fieldset>

      {add ? (
        <fieldset className="item-box stack">
          <legend>مقاسات أو ألوان جديدة</legend>
          {g.sizes.some(Boolean) && (
            <>
              <div className="row" style={{ gap: 6 }}>
                <span className="muted">مقاسات:</span>
                {SIZE_SETS.map(([n], i) => <button type="button" key={n} className={sizeSet === i ? "active ghost" : "ghost"} style={{ padding: "2px 8px" }} onClick={() => setSizeSet(i)}>{n}</button>)}
              </div>
              <Chips label="مقاس جديد" value={add.sizes} onChange={(sizes) => setAdd({ ...add, sizes })} suggest={SIZE_SETS[sizeSet][1].filter((s) => !g.sizes.includes(s))} />
            </>
          )}
          {g.colors.some(Boolean) && (
            <>
              <span className="muted">ألوان:</span>
              <Chips label="لون جديد" value={add.colors} onChange={(colors) => setAdd({ ...add, colors })} suggest={COLORS.filter((c) => !g.colors.includes(c))} />
            </>
          )}
          <div className="row">
            <span className="spacer" />
            <button onClick={() => setAdd(null)}>إلغاء</button>
            <button className="primary" disabled={busy || add.sizes.length + add.colors.length === 0} onClick={() => void addMore()}>أضف</button>
          </div>
        </fieldset>
      ) : null}

      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="row">
        {!add && <button onClick={() => setAdd({ sizes: [], colors: [] })}>+ مقاس أو لون جديد</button>}
        {onLabels && (
          <button onClick={() => onLabels(pieces.filter((p) => p.active).map((p) => ({ productId: p.id, unitId: base(p).id, copies: Math.max(1, Math.round(stock(p) / 1000)) })))}>
            🏷️ ملصقات لكل القطع
          </button>
        )}
        <span className="spacer" />
        <button onClick={onClose}>تم</button>
      </div>
    </Modal>
  );
}
