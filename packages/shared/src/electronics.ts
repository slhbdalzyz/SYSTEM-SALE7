/**
 * Electronics and phone shops: each phone has its own serial number or IMEI, sold with a warranty,
 * and devices come in for repair.
 */

/** A serial as typed or scanned, made comparable: no spaces or dashes, capital letters. */
export function normSerial(s: string): string {
  return s.replace(/[\s\-_/.]/g, "").toUpperCase();
}

/** A phone's IMEI: 15 digits whose last one is the Luhn check digit. */
export function isImei(s: string): boolean {
  const d = normSerial(s);
  if (!/^\d{15}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Looks like a mistyped IMEI: all digits, near 15 long, but not a valid one. */
export function looksLikeBadImei(s: string): boolean {
  const d = normSerial(s);
  return /^\d{14,17}$/.test(d) && !isImei(d);
}

/** Every serial written in a block of text (one per line, or separated by commas), cleaned, without repeats. */
export function parseSerials(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,،;\t]+/)) {
    const s = normSerial(part);
    if (s.length >= 3) seen.add(s);
  }
  return [...seen];
}

/** The last day of the warranty for a piece sold on `soldAt` (YYYY-MM-DD), or null with none. */
export function warrantyUntil(soldAt: string | Date, months: number): string | null {
  if (!months || months <= 0) return null;
  const d = new Date(soldAt);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  // The same day of the month, months later; a day the month does not have becomes its last day.
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, m, Math.min(day, last)));
  return end.toISOString().slice(0, 10);
}

export type WarrantyState = { state: "none" } | { state: "active"; daysLeft: number } | { state: "expired"; daysAgo: number };
export function warrantyState(until: string | null | undefined, today: string): WarrantyState {
  if (!until) return { state: "none" };
  const days = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
  return days >= 0 ? { state: "active", daysLeft: days } : { state: "expired", daysAgo: -days };
}

export function warrantyLabel(months: number): string {
  if (!months) return "";
  if (months % 12 === 0) { const y = months / 12; return y === 1 ? "ضمان سنة" : y === 2 ? "ضمان سنتين" : `ضمان ${y} سنوات`; }
  return months === 1 ? "ضمان شهر" : months === 2 ? "ضمان شهرين" : `ضمان ${months} ${months <= 10 ? "شهور" : "شهر"}`;
}

/** How many pieces a cart line holds, and how many of them still need their number. */
export function serialsMissing(l: { qtyMilli: number; serials?: string[] }): number {
  const pieces = Math.max(0, Math.round(l.qtyMilli / 1000));
  return Math.max(0, pieces - (l.serials?.length ?? 0));
}

export const REPAIR_STATUSES = ["received", "working", "waiting_parts", "ready", "delivered", "cancelled"] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  received: "📥 مستلم",
  working: "🔧 قيد الصيانة",
  waiting_parts: "⏳ ينتظر قطعة",
  ready: "✅ جاهز للتسليم",
  delivered: "🤝 تم التسليم",
  cancelled: "✖️ ملغي",
};
/** Where a repair can go from each step. */
export const REPAIR_NEXT: Record<RepairStatus, RepairStatus[]> = {
  received: ["working", "waiting_parts", "ready", "cancelled"],
  working: ["waiting_parts", "ready", "cancelled"],
  waiting_parts: ["working", "ready", "cancelled"],
  ready: ["delivered", "working"],
  delivered: [],
  cancelled: ["received"],
};

/** What the customer still has to pay when collecting: the final price (or the estimate) less the deposit. */
export function repairDue(r: { estimateMinor: number; depositMinor: number; finalMinor?: number | null }): number {
  return Math.max(0, (r.finalMinor ?? r.estimateMinor) - r.depositMinor);
}

/** The message sent to the customer on WhatsApp when the device is ready. */
export function repairReadyMessage(r: { shop: string; number: number; device: string; dueText: string }): string {
  return `السلام عليكم، جهازك (${r.device}) جاهز في ${r.shop}. رقم الإيصال ${r.number}.${r.dueText ? ` المتبقي: ${r.dueText}.` : ""} نستنوك، شكراً.`;
}
