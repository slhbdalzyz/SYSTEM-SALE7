import { formatMoney } from "@pos/shared";
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
  /** X report: the shift so far, still open: nothing counted. */
  x?: boolean;
  /** The cashier does not see what the drawer should hold, nor the difference. */
  blind?: boolean;
  /** The drawer counted note by note: dinars → how many. */
  notes?: Record<string, number> | null;
  /** The card machine's total and the transfers, as entered and as the till's sales say. */
  card?: { counted: number; expected: number } | null;
  transfer?: { counted: number; expected: number } | null;
  /** Change left in the drawer for the next shift; the rest goes to the safe. */
  floatMinor?: number | null;
  reason?: string | null;
  approvedBy?: string | null;
}

/** Card money in a shift (any way that lands in the card account), and transfers. */
export function nonCash(byMethod: ShiftReport["byMethod"]) {
  let card = 0, transfer = 0;
  for (const [m, v] of Object.entries(byMethod) as [string, number][]) {
    if (m === "cash" || m === "credit" || m === "payroll" || m === "points") continue;
    if (m === "transfer" || m === "cheque") transfer += v;
    else card += v;
  }
  return { card, transfer };
}

/** The closing report as a WhatsApp message to the owner (always with the difference). */
export function zText(z: ShiftReport, who: { shop: string; device: string; cashier: string }) {
  const m = (v: number) => formatMoney(v);
  const diff = z.countedCashMinor - z.expectedCashMinor;
  const t = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  const lines = [
    `🧾 تقرير قفل الوردية — ${who.shop}`,
    `${who.cashier} · ${who.device}`,
    `من ${t(z.openedAt)} لين ${t(z.closedAt)}`,
    `المبيعات: ${z.sales} فاتورة · ${m(z.salesMinor)}`,
    ...(z.returns ? [`المرتجعات: ${z.returns} · ${m(z.returnsMinor)}`] : []),
    `الكاش المتوقع: ${m(z.expectedCashMinor)}`,
    `الكاش الموجود: ${m(z.countedCashMinor)}`,
    diff === 0 ? "الدرج مطابق ✓" : `${diff > 0 ? "زيادة" : "عجز"}: ${m(Math.abs(diff))}`,
    ...(z.card ? [`البطاقة: ${m(z.card.counted)} من ${m(z.card.expected)}`] : []),
    ...(z.transfer ? [`التحويلات: ${m(z.transfer.counted)} من ${m(z.transfer.expected)}`] : []),
    ...(z.floatMinor !== null && z.floatMinor !== undefined ? [`فكّة للوردية الجاية: ${m(z.floatMinor)} · للخزنة: ${m(Math.max(0, z.countedCashMinor - z.floatMinor))}`] : []),
    ...(z.reason ? [`سبب الفرق: ${z.reason}`] : []),
    ...(z.approvedBy ? [`وافق: ${z.approvedBy}`] : []),
  ];
  return lines.join("\n");
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
