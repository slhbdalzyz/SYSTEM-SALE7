import { computeLine, computeTotals, type PaymentMethod } from "@pos/shared";
import type { LocalSale } from "../localdb";

/** What a shift did, worked out on the till from its own sales, so it prints even offline. */
export interface ShiftReport {
  openedAt: string;
  closedAt: string;
  openingCashMinor: number;
  sales: number;
  salesMinor: number;
  /** Money in by way: cash is net of change given back. */
  byMethod: Partial<Record<PaymentMethod, number>>;
  discountMinor: number;
  promoMinor: number;
  returns: number;
  returnsMinor: number;
  debtPaidCashMinor: number;
  /** Money put into or taken out of the drawer during the shift. */
  drawerMoves?: { kind: "in" | "out"; amountMinor: number; reason: string }[];
  expectedCashMinor: number;
  countedCashMinor: number;
  items: { name: string; qtyMilli: number; totalMinor: number }[];
}

export function shiftReport(shift: { openedAt: string; openingCashMinor: number }, list: LocalSale[], countedCashMinor: number, closedAt = new Date().toISOString()): ShiftReport {
  const byMethod: Partial<Record<PaymentMethod, number>> = {};
  const items = new Map<string, { name: string; qtyMilli: number; totalMinor: number }>();
  const drawerMoves: NonNullable<ShiftReport["drawerMoves"]> = [];
  let sales = 0, salesMinor = 0, discountMinor = 0, promoMinor = 0, returns = 0, returnsMinor = 0, debtPaidCashMinor = 0, cash = 0;
  for (const s of list) {
    cash += s.cashInMinor - s.changeMinor;
    if (s.kind === "return") {
      returns++;
      returnsMinor += -s.totalMinor;
      continue;
    }
    if (s.kind === "drawer") {
      drawerMoves.push({ kind: s.cashInMinor >= 0 ? "in" : "out", amountMinor: Math.abs(s.cashInMinor), reason: s.reason ?? "" });
      continue;
    }
    if (s.kind === "payment") {
      debtPaidCashMinor += s.cashInMinor;
      continue;
    }
    if (!s.input) continue;
    sales++;
    salesMinor += s.totalMinor;
    for (const p of s.input.payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountMinor;
    if (s.changeMinor > 0) byMethod.cash = (byMethod.cash ?? 0) - s.changeMinor;
    const t = computeTotals(s.input.lines, s.input.invoiceDiscountMinor);
    const promo = s.input.lines.reduce((a, l) => a + (l.promoMinor ?? 0), 0);
    promoMinor += promo;
    discountMinor += t.discount - promo;
    for (const l of s.input.lines) {
      const it = items.get(l.productId) ?? { name: l.name, qtyMilli: 0, totalMinor: 0 };
      it.qtyMilli += l.qtyMilli;
      it.totalMinor += computeLine(l).total;
      items.set(l.productId, it);
    }
  }
  return {
    openedAt: shift.openedAt, closedAt, openingCashMinor: shift.openingCashMinor, sales, salesMinor, byMethod, discountMinor, promoMinor,
    returns, returnsMinor, debtPaidCashMinor, drawerMoves, expectedCashMinor: shift.openingCashMinor + cash, countedCashMinor,
    items: [...items.values()].sort((a, b) => b.totalMinor - a.totalMinor).slice(0, 10),
  };
}
