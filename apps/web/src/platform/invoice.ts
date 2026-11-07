import { formatMoney } from "@pos/shared";
import { METHOD_LABEL } from "../billing";

export interface SubscriptionInvoice {
  id: string;
  invoice_no: number;
  months: number;
  bonus_months: number;
  amount_minor: number;
  discount_minor: number;
  coupon_code: string | null;
  method: string;
  reference: string | null;
  period_from: string;
  period_to: string;
  created_at: string;
  plan_name: string;
  price_minor: number;
  tenant_name: string;
  tenant_phone: string | null;
  tenant_city: string | null;
  company: { name?: string; phone?: string; address?: string; taxNo?: string };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const d = (s: string) => new Date(s).toLocaleDateString("en-GB");

/** The invoice as a printable page; the browser's print dialog saves it as PDF. */
export function invoiceHtml(v: SubscriptionInvoice) {
  const c = v.company ?? {};
  const full = v.price_minor * v.months;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فاتورة اشتراك ${v.invoice_no}</title>
<style>
  body { font-family: system-ui, "Segoe UI", Tahoma, sans-serif; color: #1a1a1a; margin: 32px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
  h1 { margin: 0 0 4px; font-size: 22px; } h2 { margin: 0; font-size: 18px; }
  .muted { color: #666; font-size: 13px; } .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: embed; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; } th, td { padding: 10px 8px; border-bottom: 1px solid #ddd; text-align: right; }
  th { background: #f4f4f4; font-size: 13px; } .total td { font-weight: 700; font-size: 16px; border-top: 2px solid #1a1a1a; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; } .box { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
  .foot { margin-top: 32px; text-align: center; } @media print { body { margin: 12mm; } button { display: none; } }
</style></head><body>
<div class="top">
  <div><h1>${esc(c.name || "Sale7 POS")}</h1><div class="muted">${esc(c.address)}</div><div class="muted num">${esc(c.phone)}</div>${c.taxNo ? `<div class="muted">الرقم الضريبي: <span class="num">${esc(c.taxNo)}</span></div>` : ""}</div>
  <div style="text-align:left"><h2>فاتورة اشتراك</h2><div class="num" style="font-size:20px;font-weight:700">#${v.invoice_no}</div><div class="muted num">${d(v.created_at)}</div></div>
</div>
<div class="grid">
  <div class="box"><div class="muted">إلى</div><b>${esc(v.tenant_name)}</b><div class="muted">${esc(v.tenant_city)}</div><div class="muted num">${esc(v.tenant_phone)}</div></div>
  <div class="box"><div class="muted">فترة الاشتراك</div><b class="num">${d(v.period_from)} ← ${d(v.period_to)}</b><div class="muted">طريقة الدفع: ${esc(METHOD_LABEL[v.method] ?? v.method)}${v.reference ? ` · <span class="num">${esc(v.reference)}</span>` : ""}</div></div>
</div>
<table>
  <thead><tr><th>البيان</th><th>المدة</th><th>سعر الشهر</th><th>المبلغ</th></tr></thead>
  <tbody>
    <tr><td>اشتراك باقة «${esc(v.plan_name)}»</td><td>${v.months} شهر${v.bonus_months ? ` + ${v.bonus_months} مجاناً` : ""}</td><td class="num">${formatMoney(v.price_minor)}</td><td class="num">${formatMoney(full)}</td></tr>
    ${v.discount_minor ? `<tr><td>خصم${v.coupon_code ? ` (كوبون ${esc(v.coupon_code)})` : ""}</td><td></td><td></td><td class="num">- ${formatMoney(v.discount_minor)}</td></tr>` : ""}
    ${!v.discount_minor && full !== v.amount_minor ? `<tr><td>تعديل على المبلغ</td><td></td><td></td><td class="num">${formatMoney(v.amount_minor - full)}</td></tr>` : ""}
    <tr class="total"><td colspan="3">المدفوع</td><td class="num">${formatMoney(v.amount_minor)}</td></tr>
  </tbody>
</table>
<div class="foot muted">شكراً لاشتراككم. هذه الفاتورة صادرة من النظام.</div>
<div class="foot"><button onclick="print()">طباعة / حفظ PDF</button></div>
</body></html>`;
}

export function printInvoice(v: SubscriptionInvoice) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(invoiceHtml(v));
  w.document.close();
  setTimeout(() => w.print(), 300);
  return true;
}
