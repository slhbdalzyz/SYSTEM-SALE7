import { lineAmount } from "./money";

export interface CartLineInput {
  priceMinor: number;
  qtyMilli: number;
  discountMinor?: number;
  /** Taken off by a running offer; counts as discount. */
  promoMinor?: number;
  /** Tax rate in basis points (100 = 1%). Prices are tax-inclusive. */
  taxBp?: number;
}

export interface CartLineTotals {
  gross: number;
  discount: number;
  total: number;
  tax: number;
}

export function computeLine(l: CartLineInput): CartLineTotals {
  const gross = lineAmount(l.priceMinor, l.qtyMilli);
  const discount = Math.min((l.discountMinor ?? 0) + (l.promoMinor ?? 0), gross);
  const total = gross - discount;
  const bp = l.taxBp ?? 0;
  const tax = bp > 0 ? Math.round((total * bp) / (10000 + bp)) : 0;
  return { gross, discount, total, tax };
}

export interface CartTotals {
  subtotal: number;
  lineDiscount: number;
  invoiceDiscount: number;
  discount: number;
  tax: number;
  total: number;
}

/** Totals for a whole invoice. The invoice discount is spread over tax proportionally. */
export function computeTotals(lines: CartLineInput[], invoiceDiscountMinor = 0): CartTotals {
  const per = lines.map(computeLine);
  const subtotal = per.reduce((s, l) => s + l.gross, 0);
  const lineDiscount = per.reduce((s, l) => s + l.discount, 0);
  const afterLines = subtotal - lineDiscount;
  const invoiceDiscount = Math.min(Math.max(invoiceDiscountMinor, 0), afterLines);
  const total = afterLines - invoiceDiscount;
  const lineTax = per.reduce((s, l) => s + l.tax, 0);
  const tax = afterLines > 0 ? Math.round((lineTax * total) / afterLines) : 0;
  return { subtotal, lineDiscount, invoiceDiscount, discount: lineDiscount + invoiceDiscount, tax, total };
}
