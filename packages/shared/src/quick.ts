import { z } from "zod";

/** Till quick keys: a product in a set unit and quantity, or at a price typed each time. */
export const QUICK_COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#475569"] as const;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();

export const quickGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color,
});

export const quickKeyInputSchema = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  qtyMilli: z.number().int().min(1).max(1_000_000_000).default(1000),
  openPrice: z.boolean().default(false),
  label: z.string().trim().max(40).nullable().optional(),
  color,
  image: z.string().max(40_000).regex(/^data:image\/(png|jpeg|webp);base64,/).nullable().optional(),
  storeId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
});
export type QuickKeyInput = z.infer<typeof quickKeyInputSchema>;

export interface QuickGroup { id: string; name: string; color: string | null; sort: number }

export interface QuickKey {
  id: string;
  groupId: string | null;
  productId: string;
  unitId: string | null;
  qtyMilli: number;
  openPrice: boolean;
  label: string | null;
  color: string | null;
  image: string | null;
  storeId: string | null;
  userId: string | null;
  sort: number;
  /** For the admin page: what the key sells, as the catalog has it now. */
  productName?: string;
  unitName?: string | null;
  priceMinor?: number | null;
}

/** What a key says on the till: its own label, or the product with the quantity when it isn't one. */
export function quickKeyLabel(k: Pick<QuickKey, "label" | "qtyMilli">, productName: string, unitName?: string | null): string {
  if (k.label) return k.label;
  const qty = k.qtyMilli !== 1000 ? ` × ${k.qtyMilli % 1000 ? (k.qtyMilli / 1000).toString() : k.qtyMilli / 1000}` : "";
  return `${productName}${unitName ? ` ${unitName}` : ""}${qty}`;
}
