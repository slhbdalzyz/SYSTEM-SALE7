import { z } from "zod";

/**
 * Zakat on a shop's trade goods (عروض التجارة), once a year on the day the year (الحول) turns:
 * the goods at their value that day, plus cash and bank, plus what customers owe and will pay,
 * minus what the shop owes and must pay now. Fixed assets (fridges, shelves, the scale) are not
 * counted. Due only when that reaches the nisab: the value of 85 g of gold. 2.5% for a hijri year,
 * 2.577% when the shop keeps a gregorian year (it is eleven days longer).
 */

export const HIJRI_MONTHS = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
export const GREGORIAN_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

export const zakatSettingsSchema = z.object({
  /** Which calendar the shop's year runs on: the day it turns, and the rate. */
  calendar: z.enum(["hijri", "gregorian"]).default("hijri"),
  month: z.number().int().min(1).max(12).default(9),
  day: z.number().int().min(1).max(30).default(1),
  /** How goods are valued: what they would cost to buy again (wholesale), or the shelf price. */
  valuation: z.enum(["cost", "price"]).default("cost"),
  nisabGrams: z.number().int().min(1).max(1000).default(85),
  /** The last price of a gram of gold entered, in dirham, offered again next time. */
  goldGramMinor: z.number().int().min(0).default(0),
  /** Days before the year turns that the owner's phone is told. */
  remindDays: z.number().int().min(0).max(60).default(7),
});
export type ZakatSettings = z.infer<typeof zakatSettingsSchema>;

export function readZakatSettings(raw: unknown): ZakatSettings {
  const r = zakatSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : zakatSettingsSchema.parse({});
}

/** Rate in parts per 100 000: 2.5% hijri, 2.577% gregorian. */
export const zakatRate = (calendar: ZakatSettings["calendar"]) => (calendar === "hijri" ? 2500 : 2577);

const TZ = "Africa/Tripoli";
let hijriFmt: Intl.DateTimeFormat | null = null;

/** A day's hijri date (Umm al-Qura), as seen in Libya. */
export function hijriDate(d: Date): { year: number; month: number; day: number } {
  hijriFmt ??= new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", { day: "numeric", month: "numeric", year: "numeric", timeZone: TZ });
  const p = Object.fromEntries(hijriFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { year: parseInt(p.year, 10), month: parseInt(p.month, 10), day: parseInt(p.day, 10) };
}

function gregorianDate(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { day: "numeric", month: "numeric", year: "numeric", timeZone: TZ }).formatToParts(d).map((x) => [x.type, x.value]));
  return { year: parseInt(p.year, 10), month: parseInt(p.month, 10), day: parseInt(p.day, 10) };
}

export function formatHijri(d: Date) {
  const h = hijriDate(d);
  return `${h.day} ${HIJRI_MONTHS[h.month - 1]} ${h.year}هـ`;
}

/**
 * The next day the shop's year turns (today counts), and how many days away it is. A hijri month
 * has 29 or 30 days, so the 30th falls back to the month's last day.
 */
export function nextHawl(s: Pick<ZakatSettings, "calendar" | "month" | "day">, now = new Date()): { date: Date; daysLeft: number; year: number } {
  // Midday of today as it is in Libya, so every step lands well inside one day.
  const g = gregorianDate(now);
  const noon = new Date(Date.UTC(g.year, g.month - 1, g.day, 10));
  const read = s.calendar === "hijri" ? hijriDate : gregorianDate;
  for (let i = 0; i < 400; i++) {
    const d = new Date(noon.getTime() + i * 86_400_000);
    const t = read(d);
    const hit = t.month === s.month && t.day === s.day;
    // The wanted day does not exist this month (e.g. the 30th of a 29-day month): take its last day.
    const next = read(new Date(d.getTime() + 86_400_000));
    const lastOfMonth = t.month === s.month && next.month !== s.month && t.day < s.day;
    if (hit || lastOfMonth) return { date: d, daysLeft: i, year: t.year };
  }
  return { date: noon, daysLeft: 0, year: read(noon).year };
}

export interface ZakatInput {
  inventoryMinor: number;
  cashMinor: number;
  receivablesMinor: number;
  otherAssetsMinor: number;
  payablesMinor: number;
  otherDebtsMinor: number;
  goldGramMinor: number;
  nisabGrams: number;
  calendar: ZakatSettings["calendar"];
}

export interface ZakatResult {
  assetsMinor: number;
  debtsMinor: number;
  baseMinor: number;
  nisabMinor: number;
  /** null when the gold price was not given, so the nisab cannot be checked. */
  reachesNisab: boolean | null;
  rate: number;
  zakatMinor: number;
}

export function computeZakat(i: ZakatInput): ZakatResult {
  const assetsMinor = Math.max(0, i.inventoryMinor) + i.cashMinor + Math.max(0, i.receivablesMinor) + Math.max(0, i.otherAssetsMinor);
  const debtsMinor = Math.max(0, i.payablesMinor) + Math.max(0, i.otherDebtsMinor);
  const baseMinor = Math.max(0, assetsMinor - debtsMinor);
  const nisabMinor = i.goldGramMinor * i.nisabGrams;
  const reachesNisab = i.goldGramMinor > 0 ? baseMinor >= nisabMinor : null;
  const rate = zakatRate(i.calendar);
  const zakatMinor = reachesNisab === false ? 0 : Math.round((baseMinor * rate) / 100_000);
  return { assetsMinor, debtsMinor, baseMinor, nisabMinor, reachesNisab, rate, zakatMinor };
}
