import { formatMoney, quickKeyLabel, type CatalogProduct, type QuickGroup, type QuickKey } from "@pos/shared";

export type QuickSize = "sm" | "md" | "lg";

/** What a key sells right now, from the catalog on the device. */
export function keyInfo(k: QuickKey, p: CatalogProduct | undefined) {
  if (!p) return null;
  const unit = p.units.find((u) => u.id === k.unitId) ?? p.units.find((u) => u.isBase) ?? p.units[0];
  const showUnit = !!k.unitId && !unit?.isBase;
  const label = quickKeyLabel(k, p.name, showUnit ? unit?.name : null);
  const price = k.openPrice ? "سعر مفتوح" : p.isWeighted && k.qtyMilli === 1000 ? "⚖️ بالوزن" : unit ? formatMoney(Math.round((unit.priceMinor * k.qtyMilli) / 1000), "") : "";
  return { label, price, unit };
}

/** One key as the till draws it; the admin page draws the same face. */
export function KeyFace({ k, label, price, hotkey }: { k: Pick<QuickKey, "color" | "image" | "openPrice">; label: string; price: string; hotkey?: number }) {
  return (
    <>
      {hotkey !== undefined && <kbd className="qk-hot">{hotkey}</kbd>}
      {k.image ? <img src={k.image} alt="" className="qk-img" /> : null}
      <span className="qk-name">{label}</span>
      <small className="num qk-price">{price}</small>
    </>
  );
}

export const keyStyle = (color: string | null | undefined) => (color ? ({ "--qk": color } as React.CSSProperties) : undefined);

/**
 * The quick keys on the till: the main page and a tab for each group. The first nine keys on
 * screen answer to Ctrl+1 … Ctrl+9.
 */
export function QuickPad({ groups, keys, products, group, setGroup, size, onPress }: {
  groups: QuickGroup[]; keys: QuickKey[]; products: Map<string, CatalogProduct>; group: string | null; setGroup: (g: string | null) => void;
  size: QuickSize; onPress: (k: QuickKey, p: CatalogProduct) => void;
}) {
  const shown = visibleKeys(keys, products, group);
  return (
    <div className={`quick-pad qk-${size}`} aria-label="أزرار سريعة">
      {groups.length > 0 && (
        <div className="qk-groups" role="tablist">
          <button role="tab" className={group === null ? "active" : ""} onClick={() => setGroup(null)}>⭐ الأساسية</button>
          {groups.map((g) => (
            <button role="tab" key={g.id} className={group === g.id ? "active" : ""} style={keyStyle(g.color)} onClick={() => setGroup(g.id)}>{g.name}</button>
          ))}
        </div>
      )}
      <div className="quick-keys">
        {shown.map(({ k, p }, i) => {
          const info = keyInfo(k, p)!;
          return (
            <button key={k.id} className={k.color ? "tinted" : ""} style={keyStyle(k.color)} onClick={() => onPress(k, p)} title={i < 9 ? `${info.label} (Ctrl+${i + 1})` : info.label}>
              <KeyFace k={k} label={info.label} price={info.price} hotkey={i < 9 ? i + 1 : undefined} />
            </button>
          );
        })}
        {!shown.length && <span className="muted">ما فيش أزرار في هالمجموعة</span>}
      </div>
    </div>
  );
}

/** The keys on screen for a group, in order, skipping products the device doesn't have (or stopped selling). */
export function visibleKeys(keys: QuickKey[], products: Map<string, CatalogProduct>, group: string | null) {
  return keys
    .filter((k) => (k.groupId ?? null) === group)
    .map((k) => ({ k, p: products.get(k.productId)! }))
    .filter((x) => x.p && x.p.active);
}

/** Shrinks a picked photo to a small square JPEG, so a key's picture stays a few KB. */
export async function shrinkImage(file: File, side = 96): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("الصورة ما تفتحتش"));
      i.src = url;
    });
    const c = document.createElement("canvas");
    c.width = c.height = side;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, side, side);
    const s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, side, side);
    return c.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}
