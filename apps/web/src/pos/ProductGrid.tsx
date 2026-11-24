// Items as tiles by department, to tap instead of scanning: the restaurant's menu, the clothes
// shop's models (one tile per model; its sizes and colours open on tap), a touch screen.
import { useEffect, useState } from "react";
import { foldVariants, formatMoney, variantBaseName } from "@pos/shared";
import { api } from "../api";
import { db, getMeta, setMeta } from "../localdb";
import type { Found } from "../lookup";
import { session } from "../session";

interface Category { id: string; name: string; icon?: string | null }
const NONE = "none";

export function ProductGrid({ onPick, big }: { onPick: (p: Found) => void; big?: boolean }) {
  const [cats, setCats] = useState<Category[]>([]);
  const [cat, setCat] = useState<string | null>(null);
  const [items, setItems] = useState<Found[]>([]);

  useEffect(() => {
    void (async () => {
      const cached = (await getMeta<Category[]>("categories")) ?? [];
      setCats(cached);
      try {
        const fresh = await api<Category[]>("/categories", { token: session.staffToken });
        await setMeta("categories", fresh);
        setCats(fresh);
      } catch {
        /* offline: the departments saved last time */
      }
    })();
  }, []);

  // Only departments that have something on sale, plus the items with none.
  const [used, setUsed] = useState<Set<string> | null>(null);
  useEffect(() => {
    void db.products.filter((p) => p.active).toArray().then((all) => setUsed(new Set(all.map((p) => p.categoryId ?? NONE))));
  }, [cats]);
  const shown = [...cats.filter((c) => used?.has(c.id)), ...(used?.has(NONE) ? [{ id: NONE, name: "بدون قسم" }] : [])];
  const current = cat && shown.some((c) => c.id === cat) ? cat : shown[0]?.id ?? null;

  useEffect(() => {
    if (!current) return setItems([]);
    void db.products.filter((p) => p.active && (current === NONE ? !p.categoryId : p.categoryId === current)).limit(400).toArray()
      .then((list) => setItems(foldVariants(list).slice(0, 120).map(({ item, count }) => (count > 1 ? { ...item, variants: count } : item))));
  }, [current]);

  if (!shown.length) return null;
  return (
    <div className={`pgrid ${big ? "big" : ""}`}>
      <div className="pgrid-cats" role="tablist" aria-label="الأقسام">
        {shown.map((c) => (
          <button key={c.id} role="tab" aria-selected={c.id === current} className={c.id === current ? "active" : ""} onClick={() => setCat(c.id)}>
            {"icon" in c && c.icon ? `${c.icon} ` : ""}{c.name}
          </button>
        ))}
      </div>
      <div className="pgrid-items">
        {items.map((p) => (
          <button key={p.id} className="tile" onClick={() => onPick(p)} title={p.name}>
            <span className="tile-name">{p.variants ? variantBaseName(p) : p.name}</span>
            <span className="tile-sub">
              {p.variants ? <small>👕 {p.variants}</small> : p.isWeighted ? <small>⚖️</small> : null}
              <b className="num">{formatMoney((p.units.find((u) => u.isBase) ?? p.units[0]).priceMinor, "")}</b>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
