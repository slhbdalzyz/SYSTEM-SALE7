import { fillTemplate, formatMoney, readShopSettings, waLink, type ShopSettings } from "@pos/shared";

/** The address a customer opens to see an invoice: this app with ?r=<invoice id>. */
export const receiptUrl = (saleId: string) => `${location.origin}${location.pathname}?r=${saleId}`;

/** Opens WhatsApp on the customer's chat with the invoice message ready to send. */
export function sendInvoice(o: { shopName: string; settings?: ShopSettings | null; saleId: string; number: string; totalMinor: number; phone?: string | null }) {
  const s = o.settings ?? readShopSettings({});
  const text = fillTemplate(s.whatsapp.invoiceMessage, { shop: o.shopName, number: o.number, total: formatMoney(o.totalMinor), link: receiptUrl(o.saleId) });
  window.open(waLink(o.phone, text), "_blank", "noopener");
}

/** Opens WhatsApp with a reminder of what the customer owes. */
export function sendDebtReminder(o: { shopName: string; settings?: ShopSettings | null; name: string; balanceMinor: number; phone?: string | null }) {
  const s = o.settings ?? readShopSettings({});
  const text = fillTemplate(s.whatsapp.debtMessage, { shop: o.shopName, name: o.name, balance: formatMoney(o.balanceMinor) });
  window.open(waLink(o.phone, text), "_blank", "noopener");
}

/** Opens WhatsApp on the supplier's chat with an order for what is running out. */
export function sendSupplierOrder(o: { shopName: string; supplierName?: string | null; phone?: string | null; lines: { name: string; qty: string; unit: string }[] }) {
  const text = [
    `السلام عليكم${o.supplierName ? ` ${o.supplierName}` : ""}،`,
    `معاك ${o.shopName}. نبو نطلبو:`,
    ...o.lines.map((l, i) => `${i + 1}. ${l.name}: ${l.qty} ${l.unit}`),
    "",
    "ياريت تأكدلنا الأسعار وموعد التوصيل. شكراً",
  ].join("\n");
  window.open(waLink(o.phone, text), "_blank", "noopener");
}
