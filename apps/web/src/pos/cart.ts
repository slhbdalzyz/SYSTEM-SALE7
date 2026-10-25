import { applyOffers, computeLine, computeTotals, type CatalogProduct, type CatalogUnit, type Offer, type SaleInput } from "@pos/shared";

export interface CartLine {
  key: string;
  productId: string;
  unitId: string;
  name: string;
  unitName: string;
  priceMinor: number;
  qtyMilli: number;
  discountMinor: number;
  taxBp: number;
  isWeighted: boolean;
  categoryId?: string | null;
  isBaseUnit?: boolean;
  /** Filled in by priceCart from the running offers; never stored on the line itself. */
  promoMinor?: number;
  offerId?: string | null;
  offerName?: string | null;
}

export function lineFor(product: CatalogProduct, unit: CatalogUnit, qtyMilli: number): CartLine {
  return {
    key: crypto.randomUUID(),
    productId: product.id,
    unitId: unit.id,
    name: product.units.length > 1 ? `${product.name} (${unit.name})` : product.name,
    unitName: unit.name,
    priceMinor: unit.priceMinor,
    qtyMilli,
    discountMinor: 0,
    taxBp: product.taxBp,
    isWeighted: product.isWeighted,
    categoryId: product.categoryId,
    isBaseUnit: unit.isBase,
  };
}

/** Adds a line, or raises the quantity of the same counted item already in the cart. */
export function addLine(lines: CartLine[], line: CartLine): { lines: CartLine[]; key: string } {
  if (!line.isWeighted) {
    const same = lines.find((l) => l.unitId === line.unitId && l.priceMinor === line.priceMinor && l.discountMinor === 0);
    if (same) return { lines: lines.map((l) => (l === same ? { ...l, qtyMilli: l.qtyMilli + line.qtyMilli } : l)), key: same.key };
  }
  return { lines: [...lines, line], key: line.key };
}

/** The cart with running offers applied, as it would be sold at this moment. */
export function priceCart(lines: CartLine[], offers: Offer[], at = new Date()): { lines: CartLine[]; applied: ReturnType<typeof applyOffers>["applied"] } {
  const r = applyOffers(
    lines.map((l) => ({ productId: l.productId, categoryId: l.categoryId ?? null, priceMinor: l.priceMinor, qtyMilli: l.qtyMilli, isBaseUnit: l.isBaseUnit ?? false, isWeighted: l.isWeighted })),
    offers,
    at,
    null,
  );
  const names = new Map(offers.map((o) => [o.id, o.name]));
  return {
    lines: lines.map((l, i) => ({ ...l, promoMinor: r.promo[i], offerId: r.offerIds[i], offerName: r.offerIds[i] ? names.get(r.offerIds[i]!) ?? null : null })),
    applied: r.applied,
  };
}

export function cartTotals(lines: CartLine[], invoiceDiscountMinor: number) {
  return computeTotals(lines, invoiceDiscountMinor);
}

export function lineTotal(l: CartLine) {
  return computeLine(l).total;
}

export function toSaleInput(
  a: { id: string; number: string; shiftId: string | null; lines: CartLine[]; offers: Offer[]; invoiceDiscountMinor: number; payments: SaleInput["payments"]; customerId?: string | null },
): SaleInput {
  const at = new Date();
  const lines = priceCart(a.lines, a.offers, at).lines;
  const totals = computeTotals(lines, a.invoiceDiscountMinor);
  return {
    id: a.id,
    number: a.number,
    shiftId: a.shiftId,
    createdAt: at.toISOString(),
    lines: lines.map((l) => ({
      productId: l.productId,
      unitId: l.unitId,
      name: l.name,
      qtyMilli: l.qtyMilli,
      priceMinor: l.priceMinor,
      discountMinor: l.discountMinor,
      promoMinor: l.promoMinor ?? 0,
      offerId: l.offerId ?? null,
      offerName: l.offerName ?? null,
      taxBp: l.taxBp,
    })),
    invoiceDiscountMinor: a.invoiceDiscountMinor,
    payments: a.payments,
    totalMinor: totals.total,
    customerId: a.customerId ?? null,
  };
}
