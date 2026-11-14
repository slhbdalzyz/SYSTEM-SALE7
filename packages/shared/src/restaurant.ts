/** Restaurants and cafés: what goes to the kitchen, and what a dish takes out of stock. */

export const ORDER_TYPES = ["dine_in", "takeaway", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const ORDER_TYPE_LABELS: Record<OrderType, string> = { dine_in: "محلي", takeaway: "سفري", delivery: "توصيل" };
export const ORDER_TYPE_ICONS: Record<OrderType, string> = { dine_in: "🍽️", takeaway: "🥡", delivery: "🛵" };

/** Notes a cashier taps instead of typing. */
export const QUICK_NOTES = ["بدون بصل", "بدون صوص", "حار", "بدون حار", "زيادة جبنة", "سكر قليل", "بدون سكر", "بدون ثلج", "مستوي زيادة", "مقطّع"];

export const KITCHEN_STATUSES = ["new", "preparing", "ready", "served"] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];
export const KITCHEN_LABELS: Record<KitchenStatus, string> = { new: "جديد", preparing: "قيد التحضير", ready: "جاهز", served: "تم التسليم" };

export interface KitchenLine { name: string; qtyMilli: number; note?: string | null; cancelled?: boolean }

/** What a line looked like when it last went to the kitchen. */
export interface SentLine { name: string; qtyMilli: number; note?: string | null }

/**
 * What the kitchen has not heard yet: new dishes and raised quantities, and dishes taken off or
 * lowered since the last ticket (sent as cancelled). A changed note sends the dish again with it.
 */
export function kitchenDelta(
  lines: { key: string; name: string; qtyMilli: number; note?: string | null }[],
  sent: Record<string, SentLine>,
): KitchenLine[] {
  const out: KitchenLine[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    seen.add(l.key);
    const was = sent[l.key];
    const note = l.note || null;
    if (!was) {
      out.push({ name: l.name, qtyMilli: l.qtyMilli, note });
      continue;
    }
    if ((was.note || null) !== note) {
      out.push({ name: was.name, qtyMilli: was.qtyMilli, note: was.note || null, cancelled: true });
      out.push({ name: l.name, qtyMilli: l.qtyMilli, note });
      continue;
    }
    const d = l.qtyMilli - was.qtyMilli;
    if (d > 0) out.push({ name: l.name, qtyMilli: d, note });
    if (d < 0) out.push({ name: l.name, qtyMilli: -d, note, cancelled: true });
  }
  for (const [key, was] of Object.entries(sent)) {
    if (!seen.has(key)) out.push({ name: was.name, qtyMilli: was.qtyMilli, note: was.note || null, cancelled: true });
  }
  return out;
}

/** The lines as they now stand, to compare with next time. */
export function sentSnapshot(lines: { key: string; name: string; qtyMilli: number; note?: string | null }[]): Record<string, SentLine> {
  return Object.fromEntries(lines.map((l) => [l.key, { name: l.name, qtyMilli: l.qtyMilli, note: l.note || null }]));
}

/**
 * The ingredients a sale takes out of stock: each dish with a recipe gives its ingredients times
 * the quantity sold (in the dish's base unit); a dish without one comes out itself.
 */
export function recipeUsage(
  sold: { productId: string; baseMilli: number }[],
  recipes: Map<string, { ingredientId: string; qtyMilli: number }[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (id: string, q: number) => out.set(id, (out.get(id) ?? 0) + q);
  for (const s of sold) {
    const r = recipes.get(s.productId);
    if (!r?.length) add(s.productId, s.baseMilli);
    else for (const i of r) add(i.ingredientId, Math.round((i.qtyMilli * s.baseMilli) / 1000));
  }
  return out;
}

/** What one of the dish costs from its ingredients' cost per base unit. */
export function recipeCost(recipe: { ingredientId: string; qtyMilli: number }[], costPerUnit: Map<string, number>): number {
  return Math.round(recipe.reduce((a, i) => a + ((costPerUnit.get(i.ingredientId) ?? 0) * i.qtyMilli) / 1000, 0));
}
