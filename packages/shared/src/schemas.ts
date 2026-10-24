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
