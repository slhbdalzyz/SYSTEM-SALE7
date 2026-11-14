import { DEFAULT_SCALE_CONFIG, foldVariants, parseScaleBarcode, type CatalogProduct, type CatalogUnit, type ScaleBarcodeConfig } from "@pos/shared";
import { db } from "./localdb";

export interface Hit {
  product: CatalogProduct;
  unit: CatalogUnit;
  /** Set when the code itself carried a weight (scale label). */
  qtyMilli?: number;
}

/**
 * Turns whatever the scanner typed into a product: a product barcode, a scale label, or a SKU.
 * Scale labels that carry a price are converted to the weight that price buys, so the line still shows kg.
 */
export async function findByCode(code: string, scale: ScaleBarcodeConfig = DEFAULT_SCALE_CONFIG): Promise<Hit | null> {
  const c = code.trim();
  if (!c) return null;
  const bc = await db.barcodes.get(c);
  if (bc) {
    const product = await db.products.get(bc.productId);
    const unit = product?.units.find((u) => u.id === bc.unitId);
    if (product?.active && unit) return { product, unit };
  }
  const s = parseScaleBarcode(c, scale);
  if (s) {
    const candidates = await db.products.where("scaleCode").anyOf([s.itemCode, String(Number(s.itemCode))]).toArray();
    const product = candidates.find((p) => p.active);
    const unit = product?.units.find((u) => u.isBase);
    if (product && unit) {
      if (s.mode === "weight") return { product, unit, qtyMilli: s.qtyMilli };
      if (unit.priceMinor > 0) return { product, unit, qtyMilli: Math.round((s.priceMinor * 1000) / unit.priceMinor) };
    }
  }
  const bySku = await db.products.where("sku").equals(c).first();
  if (bySku?.active) return { product: bySku, unit: bySku.units.find((u) => u.isBase) ?? bySku.units[0] };
  return null;
}

/** A search hit; a model sold in several sizes or colours shows once, with how many pieces it has. */
export type Found = CatalogProduct & { variants?: number };

/**
 * Every word typed has to be in the name, in any order ("قميص اسود" finds "قميص - أسود - L"), and
 * the pieces of one model fold into a single hit that opens the size and colour grid.
 */
export async function searchProducts(text: string, limit = 12): Promise<Found[]> {
  const words = norm(text).split(/\s+/).filter(Boolean);
  if (words.join("").length < 2) return [];
  const hits = await db.products.filter((p) => p.active && words.every((w) => norm(p.name).includes(w))).limit(limit * 8).toArray();
  return foldVariants(hits).slice(0, limit).map(({ item, count }) => (count > 1 ? { ...item, variants: count } : item));
}

/** All the pieces of one model still on sale. */
export async function modelPieces(groupId: string): Promise<CatalogProduct[]> {
  return db.products.filter((p) => p.active && p.groupId === groupId).toArray();
}

/** Lower case, and the Arabic letters people type in more than one way made the same. */
function norm(s: string) {
  return s.toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[-–·]/g, " ");
}
