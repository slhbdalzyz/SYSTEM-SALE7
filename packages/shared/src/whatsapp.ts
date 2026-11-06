/**
 * WhatsApp without any account or API: a wa.me link opens WhatsApp (phone or desktop) on the
 * customer's chat with the message already written; the cashier only presses send.
 */

/** A phone number as WhatsApp wants it: digits only, with the country code (Libya 218 by default). */
export function waNumber(phone: string, country = "218"): string | null {
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = country + d.slice(1);
  else if (d.length === 9 && d.startsWith("9")) d = country + d; // 91xxxxxxx
  d = d.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Fills {name}-style blanks in a message; unknown blanks are left as they are. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** The link that opens a chat with the message; with no number WhatsApp asks whom to send it to. */
export function waLink(phone: string | null | undefined, text: string): string {
  const n = phone ? waNumber(phone) : null;
  return `https://wa.me/${n ?? ""}?text=${encodeURIComponent(text)}`;
}

export const DEFAULT_INVOICE_MESSAGE = "شكراً لتسوقكم من {shop} 🌟\nفاتورة رقم {number} بقيمة {total}\nتفاصيل الفاتورة: {link}";
export const DEFAULT_DEBT_MESSAGE = "السلام عليكم {name}،\nنذكّركم بأن الرصيد المستحق لدى {shop} هو {balance}.\nشكراً لتعاملكم معنا 🌹";
