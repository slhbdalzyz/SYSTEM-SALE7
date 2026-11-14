import type { CatalogProduct } from "./schemas";

/** Letter sizes in the order a shop hangs them, smallest first. */
const LETTER_SIZES = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "4XL", "5XL"];

/** Sizes in shop order: letters small to big, numbers low to high, anything else as first seen. */
export function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => {
    const i = LETTER_SIZES.indexOf(s.toUpperCase());
    if (i >= 0) return [0, i] as const;
    const n = Number(s.replace(",", "."));
    if (Number.isFinite(n)) return [1, n] as const;
    return [2, 0] as const;
  };
  const first = new Map(sizes.map((s, i) => [s, i]));
  return [...new Set(sizes)].sort((a, b) => {
    const [ka, va] = rank(a);
    const [kb, vb] = rank(b);
    return ka - kb || va - vb || first.get(a)! - first.get(b)!;
  });
}

export const isVariant = (p: Pick<CatalogProduct, "groupId" | "attrs">) => !!p.groupId && !!p.attrs && !!(p.attrs.color || p.attrs.size);

/** "قميص - أسود - L" → "قميص": the name the whole model is known by. */
export function variantBaseName(p: Pick<CatalogProduct, "name" | "attrs">): string {
  let name = p.name;
  for (const v of [p.attrs?.size, p.attrs?.color]) {
    if (v && name.endsWith(` - ${v}`)) name = name.slice(0, -(v.length + 3));
  }
  return name;
}

/** What tells one piece from the others of its model: "أسود · L". */
export const variantLabel = (p: Pick<CatalogProduct, "attrs">) => [p.attrs?.color, p.attrs?.size].filter(Boolean).join(" · ");

export interface VariantGrid<P> {
  name: string;
  colors: string[];
  sizes: string[];
  /** The piece in that colour and size, if the model comes in it. "" stands for "no colour" or "no size". */
  at: (color: string, size: string) => P | undefined;
  items: P[];
}

/** Lays one model's pieces out as colours (rows) by sizes (columns). */
export function variantGrid<P extends Pick<CatalogProduct, "name" | "attrs">>(items: P[]): VariantGrid<P> {
  const colors = [...new Set(items.map((p) => p.attrs?.color ?? ""))];
  const sizes = sortSizes(items.map((p) => p.attrs?.size ?? ""));
  const key = (c: string, s: string) => `${c}\u0000${s}`;
  const map = new Map(items.map((p) => [key(p.attrs?.color ?? "", p.attrs?.size ?? ""), p]));
  return { name: items[0] ? variantBaseName(items[0]) : "", colors, sizes, at: (c, s) => map.get(key(c, s)), items };
}

/** Pieces of the same model folded into one entry (the first one found), so a search shows each model once. */
export function foldVariants<P extends Pick<CatalogProduct, "groupId" | "attrs">>(items: P[]): { item: P; count: number }[] {
  const out: { item: P; count: number }[] = [];
  const seen = new Map<string, { item: P; count: number }>();
  for (const p of items) {
    if (!isVariant(p)) { out.push({ item: p, count: 1 }); continue; }
    const g = seen.get(p.groupId!);
    if (g) { g.count++; continue; }
    const e = { item: p, count: 1 };
    seen.set(p.groupId!, e);
    out.push(e);
  }
  return out;
}
