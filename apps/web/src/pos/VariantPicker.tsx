import { useEffect, useState } from "react";
import { formatMoney, variantGrid, type CatalogProduct } from "@pos/shared";
import { modelPieces } from "../lookup";
import { Modal } from "./dialogs";

const priceOf = (p: CatalogProduct) => (p.units.find((u) => u.isBase) ?? p.units[0]).priceMinor;

/**
 * One model, colours down and sizes across: a tap puts that piece in the cart. Shown when the
 * cashier finds a model by name; a scanned tag already names the exact piece and skips this.
 */
export function VariantPicker({ groupId, onPick, onClose }: { groupId: string; onPick: (p: CatalogProduct) => void; onClose: () => void }) {
  const [items, setItems] = useState<CatalogProduct[] | null>(null);
  useEffect(() => void modelPieces(groupId).then(setItems), [groupId]);
  if (!items) return null;
  const g = variantGrid(items);
  const prices = new Set(items.map(priceOf));
  const one = prices.size === 1 ? [...prices][0] : null;
  return (
    <Modal title={g.name} onClose={onClose}>
      {one !== null && <div className="muted">السعر <b className="num">{formatMoney(one)}</b> لكل المقاسات</div>}
      <div className="variant-grid" style={{ gridTemplateColumns: `auto repeat(${g.sizes.length}, minmax(56px, 1fr))` }}>
        <span />
        {g.sizes.map((s) => <b key={s} className="vg-head">{s || "—"}</b>)}
        {g.colors.map((c) => (
          <div key={c} style={{ display: "contents" }}>
            <b className="vg-color">{c || "—"}</b>
            {g.sizes.map((s) => {
              const p = g.at(c, s);
              return p ? (
                <button key={s} className="vg-cell" onClick={() => onPick(p)} aria-label={`${c} ${s}`}>
                  <span>{s || c}</span>
                  {one === null && <small className="num">{formatMoney(priceOf(p), "")}</small>}
                </button>
              ) : <span key={s} className="vg-none">—</span>;
            })}
          </div>
        ))}
      </div>
    </Modal>
  );
}
