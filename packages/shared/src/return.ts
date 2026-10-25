import { computeLine } from "./cart";

export interface SoldLine {
  qtyMilli: number;
  priceMinor: number;
  discountMinor: number;
  taxBp?: number;
  costMinor: number;
}

/**
 * What a customer gets back for returning part of a line. The refund is the line's net share of the
 * invoice (after its own discount and its slice of the invoice discount), pro rata to the quantity.
 */
export function refundFor(line: SoldLine, invoice: { linesNetMinor: number; invoiceDiscountMinor: number }, qtyMilli: number) {
  const net = computeLine(line).total;
  const share = invoice.linesNetMinor > 0 ? Math.round((invoice.invoiceDiscountMinor * net) / invoice.linesNetMinor) : 0;
  const paidForLine = net - share;
  const ratio = qtyMilli / line.qtyMilli;
  return {
    totalMinor: Math.round(paidForLine * ratio),
    costMinor: Math.round(line.costMinor * ratio),
    taxMinor: Math.round(computeLine(line).tax * ratio),
  };
}
