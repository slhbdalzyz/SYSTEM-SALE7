import { z } from "zod";
import { DEFAULT_DEBT_MESSAGE, DEFAULT_INVOICE_MESSAGE } from "./whatsapp";
import { tillLayoutSchema } from "./tillLayout";

const text = (max: number) => z.string().trim().max(max).default("");

/** Libyan notes and coins, in dinars, for counting the drawer note by note. */
export const DEFAULT_NOTES = [50, 20, 10, 5, 1, 0.5, 0.25];

export const shiftSettingsSchema = z.object({
  /** 1: the cashier counts the drawer note by note; the total adds itself up. */
  countNotes: z.boolean().default(false),
  notes: z.array(z.number().positive().max(1000)).max(15).default(DEFAULT_NOTES),
  /** 2: the cashier never sees the expected cash or the difference; only the owner does. */
  blind: z.boolean().default(false),
  /** 3: before closing, the till lists held bills, open tables and sales not sent yet. */
  preChecks: z.boolean().default(false),
  /** 4: a difference bigger than this needs a reason and/or a manager's PIN. */
  diffCheck: z.boolean().default(false),
  diffLimitMinor: z.number().int().min(0).default(5000),
  needReason: z.boolean().default(true),
  needManager: z.boolean().default(false),
  /** 5: the cashier leaves change in the drawer for the next shift, which opens with it. */
  handover: z.boolean().default(false),
  floatMinor: z.number().int().min(0).default(0),
  /** 6: the cashier also enters the card machine's total and the transfers seen. */
  cardCheck: z.boolean().default(false),
  /** 7: a shift still open at this time (HH:MM, Libya) closes by itself; "" = never. */
  autoCloseAt: z.string().regex(/^(|([01]\d|2[0-3]):[0-5]\d)$/).default(""),
  /** 8: the till can print a report of the shift so far without closing it. */
  xReport: z.boolean().default(false),
  /** 9: the closing report goes to this WhatsApp number. */
  whatsappZ: z.boolean().default(false),
  whatsappPhone: text(40),
  /** 10: a shortage becomes a deduction on the cashier's pay. */
  shortageToPayroll: z.boolean().default(false),
});
export type ShiftSettings = z.infer<typeof shiftSettingsSchema>;

export const DEFAULT_LOAN_MESSAGE = "السلام عليكم {name}،\nسجّلنا عندنا في {shop}: {what} بقيمة {amount}{due}.\nالباقي: {left}. شكراً 🌹";
export const DEFAULT_LOAN_REMINDER = "السلام عليكم {name}،\nنذكّركم بالسلفة اللي عند {shop}: الباقي {left}{due}.\nشكراً لتعاملكم معنا 🌹";

export const loanSettingsSchema = z.object({
  /** A cashier lends more than this (in dirham) only with a manager's PIN or the owner's yes from the phone; 0 = no limit. */
  cashierLimitMinor: z.number().int().min(0).max(1e12).default(0),
  /** Days a loan is given when the cashier doesn't pick a day; 0 = no due day. */
  defaultDays: z.number().int().min(0).max(365).default(7),
  /** Loans at or over this (in dirham) print a slip to be signed; 0 = only when the cashier asks. */
  slipOverMinor: z.number().int().min(0).max(1e12).default(0),
  /** The owner's phone hears of a loan whose day came and that isn't back. */
  alertOverdue: z.boolean().default(true),
  /** The WhatsApp message after a loan or a deposit; {name} {shop} {what} {amount} {due} {left}. */
  message: z.string().trim().min(1).max(600).default(DEFAULT_LOAN_MESSAGE).catch(DEFAULT_LOAN_MESSAGE),
  /** The WhatsApp reminder of a loan that is due. */
  reminder: z.string().trim().min(1).max(600).default(DEFAULT_LOAN_REMINDER).catch(DEFAULT_LOAN_REMINDER),
});
export type LoanSettings = z.infer<typeof loanSettingsSchema>;

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
  /** How a shift closes. Every option is off until the owner turns it on in «🧾 قفل الوردية». */
  shift: shiftSettingsSchema.default({}),
  /** Cash lent from the drawer and money left with the shop («🤝 السلف والأمانات»). */
  loans: loanSettingsSchema.default({}),
  /** The cashier screen: its layout for the shop, a till or a cashier, its buttons and keys («🖥 واجهة الكاشير»). */
  tillLayout: tillLayoutSchema.default({}),
  /** Side-menu pages the owner put away once done with them. */
  menu: z.object({
    /** «من الدفتر للنظام»: hidden after the shop moved off paper. */
    hidePaper: z.boolean().default(false),
  }).default({}),
  /** The shop's features the owner turned on or off (see modules.ts); anything missing follows the kind of shop. */
  modules: z.record(z.string(), z.boolean()).default({}),
  /**
   * Ways of paying the owner added (a new wallet, another bank's card). Each one is counted in the
   * treasury as card or bank transfer money, and shows on receipts and reports under its own name.
   */
  payMethods: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]{4,12}$/),
    name: z.string().trim().min(1).max(40),
    account: z.enum(["card", "transfer"]).default("card"),
    /** The bank account it goes into; none = the shop's default account. */
    bankId: z.string().uuid().nullable().optional(),
    active: z.boolean().default(true),
  })).max(30).default([]),
  /** Built-in ways of paying this shop does not take, kept off the till (card, sadad, edfali…). */
  hiddenMethods: z.array(z.string()).default([]),
});
export type PayMethod = ShopSettings["payMethods"][number];
export type ShopSettings = z.infer<typeof shopSettingsSchema>;

/** Settings as stored (possibly old or partial), with every default filled in. */
export function readShopSettings(raw: unknown): ShopSettings {
  const r = shopSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : shopSettingsSchema.parse({});
}
