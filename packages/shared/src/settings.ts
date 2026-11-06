import { z } from "zod";
import { DEFAULT_DEBT_MESSAGE, DEFAULT_INVOICE_MESSAGE } from "./whatsapp";

const text = (max: number) => z.string().trim().max(max).default("");

/**
 * The shop's own settings: who it is (printed on every receipt), its bank account, what the
 * receipt shows, and how the till behaves. One document per shop; every field has a default so
 * a shop that never opened the settings page still gets a sensible receipt.
 */
export const shopSettingsSchema = z.object({
  phone: text(40),
  phone2: text(40),
  email: text(120),
  address: text(200),
  city: text(80),
  taxNumber: text(60),
  commercialReg: text(60),
  /** A small image as a data: URL, printed at the top of the receipt. */
  logo: z.string().max(200_000).refine((s) => s === "" || /^data:image\/(png|jpeg|webp);base64,/.test(s), "صورة غير صالحة").default(""),
  bank: z.object({
    name: text(80),
    branch: text(80),
    accountName: text(120),
    accountNumber: text(60),
    iban: text(60),
  }).default({}),
  receipt: z.object({
    /** A line under the shop's name (a slogan, opening hours…). */
    header: text(120),
    /** The thank-you line; a branch's own footer wins over it. */
    footer: text(200),
    showLogo: z.boolean().default(true),
    showBranch: z.boolean().default(true),
    showAddress: z.boolean().default(true),
    showPhone: z.boolean().default(true),
    showTaxNumber: z.boolean().default(false),
    showBank: z.boolean().default(false),
    showCashier: z.boolean().default(true),
    showSavings: z.boolean().default(true),
    copies: z.number().int().min(1).max(3).default(1),
  }).default({}),
  /** The messages sent on WhatsApp; {shop} {number} {total} {link} {name} {balance} are filled in. */
  whatsapp: z.object({
    invoiceMessage: z.string().trim().min(1).max(600).default(DEFAULT_INVOICE_MESSAGE).catch(DEFAULT_INVOICE_MESSAGE),
    debtMessage: z.string().trim().min(1).max(600).default(DEFAULT_DEBT_MESSAGE).catch(DEFAULT_DEBT_MESSAGE),
    /** After each sale to a customer with a phone, the till offers to send the invoice. */
    offerAfterSale: z.boolean().default(true),
  }).default({}),
  till: z.object({
    /** Print the receipt as soon as a sale is paid (off: the cashier presses print). */
    autoPrint: z.boolean().default(true),
    /** Cashiers (not only the owner and managers) may change a line's price. */
    cashierPriceChange: z.boolean().default(false),
    /** Cashiers may give a discount on the invoice, up to this percent (0 = not allowed). */
    cashierMaxDiscountPct: z.number().int().min(0).max(100).default(10),
    /** Selling an item with no price asks for one instead of refusing. */
    askPriceWhenZero: z.boolean().default(true),
    /** Ask before clearing a cart with items in it. */
    confirmClear: z.boolean().default(true),
  }).default({}),
});
export type ShopSettings = z.infer<typeof shopSettingsSchema>;

/** Settings as stored (possibly old or partial), with every default filled in. */
export function readShopSettings(raw: unknown): ShopSettings {
  const r = shopSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : shopSettingsSchema.parse({});
}
