// Invoices on ordinary office paper (A4 or A5), for shops that print on a normal printer instead
// of a thermal roll. A sale gets a proper invoice with a table; anything else (a return, a debt
// payment, the shift report, a kitchen slip) prints the same lines as the roll, centred on the page.
import { METHOD_LABELS, ORDER_TYPE_LABELS, computeLine, computeTotals, formatMoney, formatQty, warrantyLabel, warrantyUntil } from "@pos/shared";
import type { ReceiptData } from "../pos/Receipt";
import { receiptRows } from "./receiptImage";

export type PageSize = "A4" | "A5";

const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
const qty = (m: number) => formatQty(m, m % 1000 !== 0);

export interface PageLook {
  size: PageSize;
  /** 1 = normal. */
  textScale: number;
  /** Extra blank edge, in millimetres, on top of the page's own. */
  marginMm: number;
}

function style(look: PageLook) {
  const a5 = look.size === "A5";
  const base = (a5 ? 10 : 11.5) * (look.textScale || 1);
  const edge = (a5 ? 7 : 10) + (look.marginMm || 0);
  return `
  @page { size: ${look.size}; margin: ${edge}mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #000; }
  body { font-family: "Cairo", "Segoe UI", Tahoma, Arial, sans-serif; font-size: ${base}pt; line-height: 1.45; }
  .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: embed; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; border-bottom: 2px solid #000; padding-bottom: 3mm; }
  .shop h1 { margin: 0; font-size: 1.7em; }
  .shop img { max-height: ${a5 ? 16 : 22}mm; max-width: 45mm; display: block; margin-bottom: 1mm; }
  .muted { color: #444; }
  .doc { text-align: left; }
  .doc h2 { margin: 0; font-size: 1.35em; }
  .meta { display: flex; flex-wrap: wrap; gap: 1mm 8mm; margin: 3mm 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 2mm; }
  th, td { border: 1px solid #888; padding: 1.4mm 2mm; text-align: right; vertical-align: top; }
  th { background: #eee; font-weight: 700; }
  td.n, th.n { text-align: left; white-space: nowrap; }
  td small { color: #444; display: block; }
  .bottom { display: flex; justify-content: space-between; gap: 8mm; margin-top: 4mm; align-items: flex-start; }
  .totals { width: auto; min-width: 45%; border-collapse: collapse; margin: 0; margin-inline-start: auto; }
  .totals td { border: 0; border-bottom: 1px solid #ccc; padding: 1mm 2mm; }
  .totals tr.grand td { font-size: 1.3em; font-weight: 800; border-bottom: 2px solid #000; }
  .bank { border: 1px solid #888; padding: 2mm 3mm; border-radius: 2mm; }
  .foot { margin-top: 6mm; text-align: center; }
  .sign { display: flex; justify-content: space-between; margin-top: 12mm; }
  .copy { text-align: center; font-weight: 800; letter-spacing: .2em; }
  .rows { max-width: ${a5 ? 110 : 130}mm; margin: 0 auto; }
  .rows .pair { display: flex; justify-content: space-between; gap: 4mm; }
  .rows hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  .page + .page { break-before: page; }`;
}

/** What goes under the logo: name, branch, address, phone, tax number, as the shop chose for receipts. */
function shopBlock(d: ReceiptData) {
  const set = d.shop?.settings;
  const r = set?.receipt;
  const lines = [
    d.shop && r?.showBranch && d.storeName !== d.shop.name ? d.storeName : null,
    r?.header,
    r?.showAddress ? [set?.address, set?.city].filter(Boolean).join("، ") : null,
    r?.showPhone ? [set?.phone, set?.phone2].filter(Boolean).join(" · ") : null,
    r?.showTaxNumber && set?.taxNumber ? `الرقم الضريبي: ${set.taxNumber}` : null,
    r?.showTaxNumber && set?.commercialReg ? `السجل التجاري: ${set.commercialReg}` : null,
  ].filter(Boolean);
  return `<div class="shop">
    ${r?.showLogo && set?.logo ? `<img src="${esc(set.logo)}" alt="">` : ""}
    <h1>${esc(d.shop?.name ?? d.storeName)}</h1>
    ${lines.map((l) => `<div class="muted">${esc(l)}</div>`).join("")}
  </div>`;
}

function bankBlock(d: ReceiptData) {
  const set = d.shop?.settings;
  const bank = set?.bank;
  if (!set?.receipt.showBank || !bank || !(bank.accountNumber || bank.iban)) return "";
  return `<div class="bank"><b>${esc([bank.name, bank.branch].filter(Boolean).join(" - ") || "الحساب المصرفي")}</b>
    ${bank.accountName ? `<div>${esc(bank.accountName)}</div>` : ""}
    ${bank.accountNumber ? `<div>رقم الحساب: <span class="num">${esc(bank.accountNumber)}</span></div>` : ""}
    ${bank.iban ? `<div>IBAN: <span class="num">${esc(bank.iban)}</span></div>` : ""}</div>`;
}

function salePage(d: ReceiptData) {
  const s = d.sale!;
  const r = d.shop?.settings.receipt;
  const t = computeTotals(s.lines, s.invoiceDiscountMinor);
  const promo = s.lines.reduce((a, l) => a + (l.promoMinor ?? 0), 0);
  const rows = s.lines.map((l, i) => {
    const notes = [
      l.note ? `«${esc(l.note)}»` : "",
      l.discountMinor ? `خصم ${formatMoney(l.discountMinor, "")}` : "",
      l.promoMinor ? `${esc(l.offerName ?? "عرض")} −${formatMoney(l.promoMinor, "")}` : "",
      ...(l.serials ?? []).map((sn) => `IMEI / S.N: <span class="num">${esc(sn)}</span>`),
      l.warrantyMonths ? `${esc(warrantyLabel(l.warrantyMonths))} حتى ${(warrantyUntil(s.createdAt, l.warrantyMonths) ?? "").split("-").reverse().join("/")}` : "",
    ].filter(Boolean);
    return `<tr><td class="n">${i + 1}</td><td>${esc(l.name)}${notes.map((n) => `<small>${n}</small>`).join("")}</td>
      <td class="n num">${qty(l.qtyMilli)}</td><td class="n num">${formatMoney(l.priceMinor, "")}</td><td class="n num">${formatMoney(computeLine(l).total, "")}</td></tr>`;
  }).join("");
  const tr = (label: string, v: string, cls = "") => `<tr class="${cls}"><td>${label}</td><td class="n num">${v}</td></tr>`;
  const totals = [
    t.discount - promo > 0 ? tr("الخصم", formatMoney(t.discount - promo)) : "",
    r?.showSavings !== false && promo > 0 ? tr("وفّرت من العروض", formatMoney(promo)) : "",
    t.tax > 0 ? tr("منها ضريبة", formatMoney(t.tax)) : "",
    tr("الإجمالي", formatMoney(t.total), "grand"),
    ...s.payments.map((p) => tr(esc(METHOD_LABELS[p.method]), formatMoney(p.amountMinor))),
    (d.changeMinor ?? 0) > 0 ? tr("الباقي", formatMoney(d.changeMinor ?? 0)) : "",
    d.points?.spent ? tr("نقاط مصروفة", String(d.points.spent)) : "",
    d.points?.earned ? tr("نقاط كسبتها", `+${d.points.earned}`) : "",
    d.points ? tr("رصيد النقاط", String(d.points.balance)) : "",
  ].join("");
  const meta = [
    `التاريخ: <span class="num">${when(s.createdAt)}</span>`,
    r?.showCashier === false ? esc(d.deviceName) : `${esc(d.deviceName)} · ${esc(d.cashierName)}`,
    d.customerName ? `العميل: <b>${esc(d.customerName)}</b>` : "",
    d.employeeName ? `على راتب: <b>${esc(d.employeeName)}</b>` : "",
    s.orderType ? `${esc(ORDER_TYPE_LABELS[s.orderType])}${s.tableName ? ` · ${esc(s.tableName)}` : ""}` : "",
  ].filter(Boolean);
  return `
    <div class="head">${shopBlock(d)}<div class="doc"><h2>فاتورة مبيعات</h2><div class="num">${esc(s.number)}</div></div></div>
    ${d.copy ? `<div class="copy">*** نسخة ***</div>` : ""}
    <div class="meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
    <table><thead><tr><th class="n">#</th><th>الصنف</th><th class="n">الكمية</th><th class="n">السعر</th><th class="n">الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="bottom"><div>${bankBlock(d)}</div><table class="totals">${totals}</table></div>
    <div class="foot">${esc(d.footer || r?.footer || "شكراً لزيارتكم")}</div>`;
}

/** Anything that is not a sale: the roll's own lines, centred. */
function rowsPage(d: ReceiptData) {
  return `<div class="rows">${receiptRows(d).map((r) => {
    if (r.kind === "image") return `<div style="text-align:center"><img src="${esc(r.src)}" alt="" style="max-height:20mm;max-width:45mm"></div>`;
    if (r.kind === "rule") return "<hr>";
    if (r.kind === "space") return `<div style="height:${r.h / 4}mm"></div>`;
    const fs = "size" in r && r.size ? `font-size:${(r.size / 22).toFixed(2)}em;` : "";
    const fw = "bold" in r && r.bold ? "font-weight:700;" : "";
    if (r.kind === "center") return `<div style="text-align:center;${fs}${fw}">${esc(r.text)}</div>`;
    if (r.kind === "pair") return `<div class="pair" style="${fs}${fw}"><span>${esc(r.right)}</span><span class="num">${esc(r.left)}</span></div>`;
    return `<div class="pair"><div><div>${esc(r.name)}</div><div class="num muted">${esc(r.detail)}</div></div><span class="num" style="align-self:end">${esc(r.amount)}</span></div>`;
  }).join("")}</div>`;
}

/** The whole printable document, every copy on its own page. */
export function pageHtml(d: ReceiptData, look: PageLook, copies = 1): string {
  const pages = Array.from({ length: Math.max(1, copies) }, (_, i) => {
    const doc = i ? { ...d, copy: true } : d;
    return `<section class="page">${doc.sale && !doc.kitchen ? salePage(doc) : rowsPage(doc)}</section>`;
  }).join("");
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(d.sale?.number ?? "طباعة")}</title><style>${style(look)}</style></head><body>${pages}</body></html>`;
}

/** Prints on A4/A5 through the browser's print dialog, from a hidden frame (no pop-up to block). */
export async function printPage(d: ReceiptData, look: PageLook, copies = 1): Promise<void> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px";
  document.body.appendChild(frame);
  try {
    await new Promise<void>((ok) => {
      frame.onload = () => ok();
      frame.srcdoc = pageHtml(d, look, copies);
    });
    const w = frame.contentWindow!;
    await w.document.fonts?.ready;
    await Promise.all(Array.from(w.document.images).map((img) => img.decode().catch(() => undefined)));
    w.focus();
    w.print();
  } finally {
    // Some browsers return from print() before the dialog closes; give it time before removing the frame.
    setTimeout(() => frame.remove(), 60_000);
  }
}
