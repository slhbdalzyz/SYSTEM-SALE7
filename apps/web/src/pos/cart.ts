import { applyOffers, computeLine, computeTotals, tierPrice, type CatalogProduct, type CatalogUnit, type CustomerTier, type Offer, type PriceTier, type SaleInput } from "@pos/shared";

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
  /** The item's other packings (piece, box…), so the cashier can switch the one sold. Only when it has several. */
  units?: { id: string; name: string; priceMinor: number; isBase: boolean; tierPrices?: Partial<Record<PriceTier, number>> }[];
  /** The unit's normal price and its prices for kinds of customer, so the price follows the customer picked. */
  listPriceMinor?: number;
  tierPrices?: Partial<Record<PriceTier, number>>;
  productName?: string;
  /** Filled in by priceCart from the running offers; never stored on the line itself. */
  promoMinor?: number;
  offerId?: string | null;
  offerName?: string | null;
  /** A medicine sold only against a prescription. */
  rx?: boolean;
  /** Restaurants: how the customer wants it (no onions). */
  note?: string | null;
  /** Electronics: each piece has its own number, scanned when it is sold. */
  serialized?: boolean;
  serials?: string[];
  warrantyMonths?: number;
  /** The cashier chose to sell it without scanning the number. */
  noSerial?: boolean;
  /** A service: nothing from stock; the cashier can note what was done (the program, the device). */
  service?: boolean;
}

export function lineFor(product: CatalogProduct, unit: CatalogUnit, qtyMilli: number, tier: CustomerTier | null = null): CartLine {
  return {
    key: crypto.randomUUID(),
    productId: product.id,
    unitId: unit.id,
    name: product.units.length > 1 ? `${product.name} (${unit.name})` : product.name,
    unitName: unit.name,
    priceMinor: tierPrice(unit, tier),
    qtyMilli,
    discountMinor: 0,
    ...(unit.tierPrices ? { listPriceMinor: unit.priceMinor, tierPrices: unit.tierPrices } : {}),
    taxBp: product.taxBp,
    isWeighted: product.isWeighted,
    categoryId: product.categoryId,
    isBaseUnit: unit.isBase,
    ...(product.rx ? { rx: true } : {}),
    ...(product.serialized ? { serialized: true, serials: [] } : {}),
    ...(product.warrantyMonths ? { warrantyMonths: product.warrantyMonths } : {}),
    ...(product.isService ? { service: true } : {}),
    ...(product.units.length > 1 && !product.isWeighted
      ? { units: product.units.map((u) => ({ id: u.id, name: u.name, priceMinor: u.priceMinor, isBase: u.isBase, ...(u.tierPrices ? { tierPrices: u.tierPrices } : {}) })), productName: product.name }
      : {}),
  };
}

/** The same line sold in another of the item's packings (a box instead of a piece), at that packing's price. */
export function switchUnit(line: CartLine, unitId: string, tier: CustomerTier | null = null): CartLine {
  const u = line.units?.find((x) => x.id === unitId);
  if (!u || u.id === line.unitId) return line;
  return {
    ...line, unitId: u.id, unitName: u.name, priceMinor: tierPrice(u, tier), isBaseUnit: u.isBase, discountMinor: 0,
    listPriceMinor: u.priceMinor, tierPrices: u.tierPrices,
    name: `${line.productName ?? line.name.replace(/ \([^)]*\)$/, "")} (${u.name})`,
  };
}

/**
 * The customer changed (a contractor picked, or taken off): lines still at the old customer's price
 * move to the new one's. A price the cashier typed stays as it is.
 */
export function repriceFor(lines: CartLine[], from: CustomerTier | null, to: CustomerTier | null): CartLine[] {
  return lines.map((l) => {
    if (!l.tierPrices) return l;
    const unit = { priceMinor: l.listPriceMinor ?? l.priceMinor, tierPrices: l.tierPrices };
    return l.priceMinor === tierPrice(unit, from) ? { ...l, priceMinor: tierPrice(unit, to) } : l;
  });
}

/** Adds a line, or raises the quantity of the same counted item already in the cart. */
export function addLine(lines: CartLine[], line: CartLine): { lines: CartLine[]; key: string } {
  if (!line.isWeighted) {
    const same = lines.find((l) => l.unitId === line.unitId && l.priceMinor === line.priceMinor && l.discountMinor === 0 && !l.note && !line.note);
    if (same) {
      const serials = same.serialized || line.serialized ? [...new Set([...(same.serials ?? []), ...(line.serials ?? [])])] : undefined;
      return { lines: lines.map((l) => (l === same ? { ...l, qtyMilli: l.qtyMilli + line.qtyMilli, ...(serials ? { serials } : {}) } : l)), key: same.key };
    }
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
  a: { id: string; number: string; shiftId: string | null; lines: CartLine[]; offers: Offer[]; invoiceDiscountMinor: number; payments: SaleInput["payments"]; customerId?: string | null; employeeId?: string | null; prescription?: SaleInput["prescription"]; orderType?: SaleInput["orderType"]; tableName?: string | null; deal?: Deal | null },
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
      ...(l.note ? { note: l.note } : {}),
      ...(l.serials?.length ? { serials: l.serials } : {}),
      ...(l.warrantyMonths ? { warrantyMonths: l.warrantyMonths } : {}),
    })),
    invoiceDiscountMinor: a.invoiceDiscountMinor,
    payments: a.payments,
    totalMinor: totals.total,
    employeeId: a.employeeId ?? null,
    customerId: a.customerId ?? null,
    ...(a.prescription ? { prescription: a.prescription } : {}),
    ...(a.orderType ? { orderType: a.orderType, tableName: a.tableName ?? null } : {}),
    ...(a.deal?.quoteId ? { quoteId: a.deal.quoteId } : {}),
    ...(a.deal?.project ? { project: a.deal.project } : {}),
    ...(a.deal?.delivery ? { delivery: a.deal.delivery } : {}),
  };
}

/** What goes with a bill beyond its lines: the quote it came from, the building site, a delivery. */
export interface Deal {
  quoteId?: string | null;
  quoteNumber?: number | null;
  project?: string | null;
  delivery?: { address: string; phone?: string; note?: string } | null;
}
