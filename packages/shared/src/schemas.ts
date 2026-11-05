import { z } from "zod";

export const ROLES = ["owner", "manager", "cashier"] as const;
export type Role = (typeof ROLES)[number];

export const PAYMENT_METHODS = ["cash", "card", "credit"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const minor = z.number().int();
const posMinor = z.number().int().nonnegative();
const milli = z.number().int().positive();

export const saleLineSchema = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid(),
  name: z.string().min(1).max(200),
  qtyMilli: milli,
  priceMinor: posMinor,
  discountMinor: posMinor.default(0),
  promoMinor: posMinor.default(0),
  offerId: z.string().uuid().nullable().optional(),
  offerName: z.string().max(120).nullable().optional(),
  taxBp: z.number().int().min(0).max(10000).default(0),
});

export const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: posMinor,
});

/** A sale as the cashier device sends it. The id is made on the device, so re-sending is safe. */
export const saleInputSchema = z.object({
  id: z.string().uuid(),
  number: z.string().min(1).max(40),
  shiftId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  lines: z.array(saleLineSchema).min(1).max(500),
  invoiceDiscountMinor: posMinor.default(0),
  payments: z.array(paymentSchema).min(1).max(5),
  totalMinor: minor,
  customerId: z.string().uuid().nullable().optional(),
});
export type SaleInput = z.infer<typeof saleInputSchema>;
export type SaleLineInput = z.infer<typeof saleLineSchema>;

export const unitInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(40),
  factorMilli: milli.default(1000),
  priceMinor: posMinor,
  isBase: z.boolean().default(false),
  barcodes: z.array(z.string().min(1).max(64)).default([]),
});

export const productInputSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(64).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  isWeighted: z.boolean().default(false),
  scaleCode: z.string().regex(/^\d{1,6}$/).nullable().optional(),
  taxBp: z.number().int().min(0).max(10000).default(0),
  costMinor: posMinor.default(0),
  minStockMilli: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
  units: z.array(unitInputSchema).min(1).max(10),
});
export type ProductInput = z.infer<typeof productInputSchema>;

export interface CatalogUnit {
  id: string;
  name: string;
  factorMilli: number;
  priceMinor: number;
  isBase: boolean;
  barcodes: string[];
}

export const offerInputSchema = z.object({
  name: z.string().min(2).max(120),
  kind: z.enum(["percent", "amount", "buy_get", "bundle"]),
  percentBp: z.number().int().min(1).max(10000).nullable().optional(),
  amountMinor: z.number().int().positive().nullable().optional(),
  buyQty: z.number().int().min(1).max(100).nullable().optional(),
  getQty: z.number().int().min(1).max(100).nullable().optional(),
  bundleQty: z.number().int().min(2).max(100).nullable().optional(),
  bundlePriceMinor: z.number().int().nonnegative().nullable().optional(),
  productIds: z.array(z.string().uuid()).max(500).default([]),
  categoryIds: z.array(z.string().uuid()).max(100).default([]),
  storeIds: z.array(z.string().uuid()).max(100).default([]),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  hourFrom: z.number().int().min(0).max(23).nullable().optional(),
  hourTo: z.number().int().min(0).max(24).nullable().optional(),
  active: z.boolean().default(true),
});
export type OfferInput = z.infer<typeof offerInputSchema>;

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  categoryId: string | null;
  isWeighted: boolean;
  scaleCode: string | null;
  taxBp: number;
  costMinor: number;
  minStockMilli: number;
  active: boolean;
  updatedAt: string;
  units: CatalogUnit[];
}

/** A manager confirms a sensitive step (a return, for now) on the cashier's device with their PIN. */
export const approvalSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().regex(/^\d{4,8}$/),
});

export const REFUND_METHODS = ["cash", "card", "credit"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** Returns are priced by the server from the original sale; the device only says what comes back. */
export const returnInputSchema = z.object({
  id: z.string().uuid(),
  number: z.string().min(1).max(40),
  originalSaleId: z.string().uuid(),
  shiftId: z.string().uuid().nullable().optional(),
  lines: z.array(z.object({ saleLineId: z.string().uuid(), qtyMilli: milli })).min(1).max(500),
  refundMethod: z.enum(REFUND_METHODS),
  reason: z.string().min(2).max(200),
  approval: approvalSchema.optional(),
});
export type ReturnInput = z.infer<typeof returnInputSchema>;

export const customerInputSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().regex(/^[+\d][\d\s-]{5,19}$/).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
  active: z.boolean().optional(),
});

export interface CatalogCustomer {
  id: string;
  name: string;
  phone: string | null;
  creditLimitMinor: number | null;
  balanceMinor: number;
  active: boolean;
}

/** Room left on a customer's credit. null means no limit. */
export function creditRoom(c: Pick<CatalogCustomer, "creditLimitMinor" | "balanceMinor">): number | null {
  if (c.creditLimitMinor === null) return null;
  return Math.max(c.creditLimitMinor - c.balanceMinor, 0);
}
