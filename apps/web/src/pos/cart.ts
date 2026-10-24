import { computeLine, computeTotals, type CatalogProduct, type CatalogUnit, type SaleInput } from "@pos/shared";

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

export function cartTotals(lines: CartLine[], invoiceDiscountMinor: number) {
  return computeTotals(lines, invoiceDiscountMinor);
}

export function lineTotal(l: CartLine) {
  return computeLine(l).total;
}

export function toSaleInput(
  a: { id: string; number: string; shiftId: string | null; lines: CartLine[]; invoiceDiscountMinor: number; payments: SaleInput["payments"] },
): SaleInput {
  const totals = computeTotals(a.lines, a.invoiceDiscountMinor);
  return {
    id: a.id,
    number: a.number,
    shiftId: a.shiftId,
    createdAt: new Date().toISOString(),
    lines: a.lines.map((l) => ({
      productId: l.productId,
      unitId: l.unitId,
      name: l.name,
      qtyMilli: l.qtyMilli,
      priceMinor: l.priceMinor,
      discountMinor: l.discountMinor,
      taxBp: l.taxBp,
    })),
    invoiceDiscountMinor: a.invoiceDiscountMinor,
    payments: a.payments,
    totalMinor: totals.total,
  };
}
