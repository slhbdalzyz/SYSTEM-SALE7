import { formatMoney, formatQty } from "@pos/shared";

const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface QuoteDoc {
  number: number; createdAt: string; validUntil: string | null; customerName: string | null; phone: string | null; project: string | null; note: string | null;
  lines: { name: string; qtyMilli: number; priceMinor: number; discountMinor?: number }[]; totalMinor: number;
}

/** A price quote on A4 (or the thermal printer), opened in its own window and printed. */
export function printQuote(q: QuoteDoc, shop: { name: string; phone?: string | null; address?: string | null }) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return;
  const rows = q.lines.map((l, i) => {
    const total = Math.round((l.qtyMilli * l.priceMinor) / 1000) - (l.discountMinor ?? 0);
    return `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td class="n">${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}</td><td class="n">${formatMoney(l.priceMinor, "")}</td><td class="n">${formatMoney(total, "")}</td></tr>`;
  }).join("");
  w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>عرض سعر ${q.number}</title><style>
    body{font-family:system-ui,Tahoma,sans-serif;max-width:190mm;margin:0 auto;padding:10mm;color:#000}
    h1{margin:0}table{width:100%;border-collapse:collapse;margin-top:6mm}th,td{border:1px solid #999;padding:4px 6px;text-align:right}th{background:#eee}
    .n{text-align:left;font-variant-numeric:tabular-nums}.head{display:flex;justify-content:space-between;gap:8mm}.tot{font-size:1.3em;font-weight:700;text-align:left;margin-top:4mm}
    .muted{color:#555}@media print{body{padding:0}}
  </style></head><body>
  <div class="head"><div><h1>${esc(shop.name)}</h1><div class="muted">${esc([shop.address, shop.phone].filter(Boolean).join(" · "))}</div></div>
  <div><h2 style="margin:0">عرض سعر رقم ${q.number}</h2><div>${new Date(q.createdAt).toLocaleDateString("en-GB")}</div>${q.validUntil ? `<div class="muted">صالح حتى ${q.validUntil.slice(0, 10).split("-").reverse().join("/")}</div>` : ""}</div></div>
  <p>${q.customerName ? `السادة: <b>${esc(q.customerName)}</b>` : ""}${q.phone ? ` · ${esc(q.phone)}` : ""}${q.project ? `<br>المشروع: ${esc(q.project)}` : ""}</p>
  <table><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="tot">الإجمالي: ${formatMoney(q.totalMinor)}</div>
  ${q.note ? `<p>${esc(q.note)}</p>` : ""}
  <p class="muted">الأسعار قابلة للتغيير بعد انتهاء صلاحية العرض. للشراء اذكر رقم العرض ${q.number}.</p>
  <script>onload=()=>{print();}</script></body></html>`);
  w.document.close();
}

/** The quote as a WhatsApp message. */
export function quoteText(q: QuoteDoc, shop: string): string {
  const lines = q.lines.map((l) => `• ${l.name} × ${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)} = ${formatMoney(Math.round((l.qtyMilli * l.priceMinor) / 1000) - (l.discountMinor ?? 0), "")}`).join("\n");
  return `عرض سعر رقم ${q.number} من ${shop}\n${lines}\nالإجمالي: ${formatMoney(q.totalMinor)}${q.validUntil ? `\nصالح حتى ${q.validUntil.slice(0, 10).split("-").reverse().join("/")}` : ""}`;
}
