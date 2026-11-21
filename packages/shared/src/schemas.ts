import { z } from "zod";

export const ROLES = ["owner", "manager", "accountant", "data_entry", "cashier"] as const;
export type Role = (typeof ROLES)[number];

export const PAYMENT_METHODS = ["cash", "card", "credit", "payroll", "sadad", "edfali", "mobicash", "cheque", "transfer", "points"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** What the till, receipts and reports call each way of paying. */
export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "كاش", card: "بطاقة", credit: "آجل", payroll: "على الراتب", sadad: "سداد", edfali: "إدفع لي", mobicash: "موبي كاش", cheque: "صك", transfer: "تحويل مصرفي", points: "نقاط",
};
/** Paid at the till other than in cash, on the customer's account, or off a salary. */
export const OTHER_METHODS = ["card", "sadad", "edfali", "mobicash", "transfer", "cheque"] as const;

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
  /** Restaurants: how the customer wants it (no onions, extra hot). */
  note: z.string().trim().max(200).nullable().optional(),
  /** Electronics: the serial numbers / IMEIs of the pieces sold on this line. */
  serials: z.array(z.string().trim().min(3).max(40)).max(200).optional(),
  /** For the printed receipt only; the server takes the warranty from the item. */
  warrantyMonths: z.number().int().min(0).max(120).optional(),
});

export const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: posMinor,
  /** A way of paying the shop added itself (its name); the money still counts as card or transfer. */
  label: z.string().trim().min(1).max(40).optional(),
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
  /** The employee whose salary pays the "payroll" part. */
  employeeId: z.string().uuid().nullable().optional(),
  /** The prescription the cashier saw, when the sale has a prescription-only medicine. */
  prescription: z.object({
    doctor: z.string().trim().max(120).optional(),
    number: z.string().trim().max(60).optional(),
    patient: z.string().trim().max(120).optional(),
  }).nullable().optional(),
  /** Restaurants: eaten in, taken away or delivered, and at which table. */
  orderType: z.enum(["dine_in", "takeaway", "delivery"]).nullable().optional(),
  tableName: z.string().trim().max(60).nullable().optional(),
  /** The quote this sale was opened from. */
  quoteId: z.string().uuid().nullable().optional(),
  /** Building materials: the site or job the goods are for, on the customer's account. */
  project: z.string().trim().max(80).nullable().optional(),
  /** Goods to be taken to the customer. */
  delivery: z.object({ address: z.string().trim().min(2).max(200), phone: z.string().trim().max(30).optional(), note: z.string().trim().max(200).optional() }).nullable().optional(),
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
  /** Prices for wholesale, contractor and workshop customers; left out = the normal price. */
  tierPrices: z.object({ wholesale: z.number().int().nonnegative().nullable().optional(), contractor: z.number().int().nonnegative().nullable().optional(), workshop: z.number().int().nonnegative().nullable().optional() }).optional(),
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
  /** Supply lines of this item must carry an expiry date. */
  trackExpiry: z.boolean().default(false),
  /** Give the base unit an in-store barcode (or a weighed item a scale code) when it has none. */
  autoCode: z.boolean().default(false),
  /** Shown as a button on the till's quick keys (bread, vegetables, things without a barcode). */
  quick: z.boolean().default(false),
  /** Pharmacies: the scientific name (paracetamol), to find the medicine and its alternatives. */
  genericName: z.string().trim().max(200).nullable().optional(),
  /** Sold only against a prescription: the till asks for it. */
  rx: z.boolean().default(false),
  /** Electronics: every piece has its own serial number / IMEI, scanned when it is sold. */
  serialized: z.boolean().default(false),
  /** Months of warranty from the day it is sold (0 = none). */
  warrantyMonths: z.number().int().min(0).max(120).default(0),
  /** Car parts: the maker's part number (alternatives share it) and the cars it fits. */
  partNumber: z.string().trim().max(80).nullable().optional(),
  fits: z.string().trim().max(300).nullable().optional(),
  /** Where it sits in the store room (shelf, box). */
  location: z.string().trim().max(60).nullable().optional(),
  /** A service (software, fitting, installing): sold with no stock; parts it uses go through a recipe. */
  isService: z.boolean().default(false),
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
  tierPrices?: Partial<Record<"wholesale" | "contractor" | "workshop", number>>;
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
  trackExpiry: boolean;
  quick?: boolean;
  /** Variants of one item (sizes, colours) share a group. */
  groupId?: string | null;
  attrs?: Record<string, string> | null;
  genericName?: string | null;
  rx?: boolean;
  serialized?: boolean;
  warrantyMonths?: number;
  /** The serial numbers / IMEIs of the pieces in stock, so the till finds the phone by its own number. */
  serials?: string[];
  partNumber?: string | null;
  fits?: string | null;
  location?: string | null;
  isService?: boolean;
  updatedAt: string;
  units: CatalogUnit[];
}

/** A manager confirms a sensitive step (a return, for now) on the cashier's device with their PIN. */
export const approvalSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().regex(/^\d{4,8}$/),
});

export const REFUND_METHODS = ["cash", "card", "credit", "payroll"] as const;
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
  priceTier: z.enum(["retail", "wholesale", "contractor", "workshop"]).optional(),
});

export interface CatalogCustomer {
  id: string;
  name: string;
  phone: string | null;
  creditLimitMinor: number | null;
  balanceMinor: number;
  /** Loyalty points held (when the shop has points switched on). */
  points?: number;
  /** Retail, wholesale, contractor or workshop: the prices this customer pays. */
  priceTier?: "retail" | "wholesale" | "contractor" | "workshop";
  active: boolean;
}

/** Room left on a customer's credit. null means no limit. */
export function creditRoom(c: Pick<CatalogCustomer, "creditLimitMinor" | "balanceMinor">): number | null {
  if (c.creditLimitMinor === null) return null;
  return Math.max(c.creditLimitMinor - c.balanceMinor, 0);
}
