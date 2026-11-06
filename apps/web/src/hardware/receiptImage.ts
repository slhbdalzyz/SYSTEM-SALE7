// Draws a receipt on a canvas the width of the paper. The browser does the Arabic shaping,
// so the printer only ever gets black and white dots.
import { METHOD_LABELS, computeLine, computeTotals, formatMoney, formatQty } from "@pos/shared";
import type { ReceiptData } from "../pos/Receipt";

export type Row =
  | { kind: "image"; src: string }
  | { kind: "center"; text: string; size?: number; bold?: boolean }
  | { kind: "pair"; right: string; left: string; size?: number; bold?: boolean }
  | { kind: "item"; name: string; detail: string; amount: string }
  | { kind: "rule" }
  | { kind: "space"; h: number };

const METHOD = METHOD_LABELS;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

export function receiptRows(d: ReceiptData): Row[] {
  const shop = d.shop;
  const r = shop?.settings.receipt;
  const set = shop?.settings;
  const center = (text: string | false | null | undefined, size?: number, bold?: boolean): Row[] => (text ? [{ kind: "center", text, size, bold }] : []);
  // The shop (its logo, name, branch, address, phone, tax number), then what this paper is.
  const head = (title: string, at: string): Row[] => [
    ...(r?.showLogo && set?.logo ? [{ kind: "image", src: set.logo } as Row] : []),
    ...center(shop?.name ?? d.storeName, 30, true),
    ...center(shop && r?.showBranch && d.storeName !== shop.name && d.storeName, 20),
    ...center(r?.header),
    ...center(r?.showAddress && [set?.address, set?.city].filter(Boolean).join("، ")),
    ...center(r?.showPhone && [set?.phone, set?.phone2].filter(Boolean).join(" · ")),
    ...center(r?.showTaxNumber && set?.taxNumber && `الرقم الضريبي: ${set.taxNumber}`),
    ...center(r?.showTaxNumber && set?.commercialReg && `السجل التجاري: ${set.commercialReg}`),
    { kind: "rule" },
    ...center(d.copy ? "*** نسخة ***" : null, 22, true),
    { kind: "center", text: title, size: 24, bold: true },
    { kind: "center", text: when(at) },
    ...center(r?.showCashier === false ? d.deviceName : `${d.deviceName} · ${d.cashierName}`),
    { kind: "rule" },
  ];
  const bank = set?.bank;
  const tail: Row[] = [
    ...(r?.showBank && bank && (bank.accountNumber || bank.iban)
      ? [
          { kind: "center", text: [bank.name, bank.branch].filter(Boolean).join(" - ") || "الحساب المصرفي", bold: true } as Row,
          ...center(bank.accountName),
          ...center(bank.accountNumber && `رقم الحساب: ${bank.accountNumber}`),
          ...center(bank.iban && `IBAN: ${bank.iban}`),
          { kind: "rule" } as Row,
        ]
      : []),
    { kind: "space", h: 6 },
    { kind: "center", text: d.footer || r?.footer || "شكراً لزيارتكم" },
  ];
  if (d.ret) {
    const r = d.ret;
    return [
      ...head(`مرتجع ${r.number}`, new Date().toISOString()),
      { kind: "pair", right: "عن الفاتورة", left: r.originalNumber },
      ...(r.customerName ? [{ kind: "pair", right: "العميل", left: r.customerName } as Row] : []),
      { kind: "rule" },
      ...r.lines.map((l): Row => ({ kind: "item", name: l.name, detail: `× ${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}`, amount: formatMoney(l.totalMinor, "") })),
      { kind: "rule" },
      { kind: "pair", right: "المبلغ المرجع", left: formatMoney(r.refundMinor ?? r.totalMinor), size: 26, bold: true },
      { kind: "pair", right: "طريقة الإرجاع", left: METHOD[r.method] },
      ...(r.pointsBack > 0 ? [{ kind: "pair", right: "نقاط رجعت", left: `${r.pointsBack} (${formatMoney(r.pointsMinor)})` } as Row] : []),
      ...(r.pointsTaken > 0 ? [{ kind: "pair", right: "نقاط انسحبت", left: String(r.pointsTaken) } as Row] : []),
      { kind: "pair", right: "السبب", left: r.reason },
      { kind: "rule" },
      ...tail,
    ];
  }
  if (d.shift) {
    const z = d.shift;
    const diff = z.countedCashMinor - z.expectedCashMinor;
    const m = (v: number) => formatMoney(v);
    return [
      ...head("تقرير قفل الوردية", z.closedAt),
      { kind: "pair", right: "فتحت", left: when(z.openedAt) },
      { kind: "pair", right: "قفلت", left: when(z.closedAt) },
      { kind: "rule" },
      { kind: "pair", right: `المبيعات (${z.sales} فاتورة)`, left: m(z.salesMinor), size: 24, bold: true },
      ...(Object.entries(z.byMethod) as [keyof typeof METHOD, number][]).filter(([, v]) => v).map(([k, v]): Row => ({ kind: "pair", right: `  ${METHOD[k]}`, left: m(v) })),
      ...(z.discountMinor > 0 ? [{ kind: "pair", right: "الخصومات", left: m(z.discountMinor) } as Row] : []),
      ...(z.promoMinor > 0 ? [{ kind: "pair", right: "العروض", left: m(z.promoMinor) } as Row] : []),
      ...(z.returns ? [{ kind: "pair", right: `المرتجعات (${z.returns})`, left: `−${m(z.returnsMinor)}` } as Row] : []),
      ...(z.debtPaidCashMinor ? [{ kind: "pair", right: "تسديد ديون (كاش)", left: m(z.debtPaidCashMinor) } as Row] : []),
      ...(z.drawerMoves ?? []).map((v): Row => ({ kind: "pair", right: `${v.kind === "in" ? "إيداع" : "سحب"}: ${v.reason}`, left: `${v.kind === "in" ? "+" : "−"}${m(v.amountMinor)}` })),
      { kind: "rule" },
      { kind: "pair", right: "كاش أول الوردية", left: m(z.openingCashMinor) },
      { kind: "pair", right: "الكاش المتوقع", left: m(z.expectedCashMinor), bold: true },
      { kind: "pair", right: "الكاش الموجود", left: m(z.countedCashMinor), bold: true },
      { kind: "pair", right: diff === 0 ? "مطابق ✓" : diff > 0 ? "زيادة" : "عجز", left: m(Math.abs(diff)), size: 26, bold: true },
      ...(z.items.length ? [{ kind: "rule" } as Row, { kind: "center", text: "الأكثر مبيعاً", bold: true } as Row,
        ...z.items.map((l): Row => ({ kind: "item", name: l.name, detail: `× ${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}`, amount: formatMoney(l.totalMinor, "") }))] : []),
      { kind: "rule" },
      { kind: "space", h: 30 },
      { kind: "center", text: "توقيع الكاشير ____________" },
      { kind: "space", h: 20 },
      { kind: "center", text: "توقيع المسؤول ____________" },
    ];
  }
  if (d.payment) {
    const p = d.payment;
    return [
      ...head("إيصال تسديد", p.at),
      { kind: "pair", right: "العميل", left: p.customerName },
      { kind: "pair", right: "المبلغ", left: formatMoney(p.amountMinor), size: 26, bold: true },
      { kind: "pair", right: "الطريقة", left: METHOD[p.method] },
      { kind: "pair", right: "الرصيد المتبقي", left: formatMoney(p.balanceMinor) },
      { kind: "rule" },
      ...tail,
    ];
  }
  const s = d.sale!;
  const t = computeTotals(s.lines, s.invoiceDiscountMinor);
  // Offer savings get their own line; "الخصم" is only what the cashier took off.
  const promo = s.lines.reduce((a, l) => a + (l.promoMinor ?? 0), 0);
  return [
    ...head(`فاتورة ${s.number}`, s.createdAt),
    ...(d.customerName ? [{ kind: "pair", right: "العميل", left: d.customerName } as Row, { kind: "rule" } as Row] : []),
    ...(d.employeeName ? [{ kind: "pair", right: "على راتب", left: d.employeeName } as Row, { kind: "rule" } as Row] : []),
    ...s.lines.map((l): Row => ({
      kind: "item",
      name: l.name,
      detail: `${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)} × ${formatMoney(l.priceMinor, "")}${l.discountMinor ? ` (خصم ${formatMoney(l.discountMinor, "")})` : ""}${l.promoMinor ? ` (${l.offerName ?? "عرض"} −${formatMoney(l.promoMinor, "")})` : ""}`,
      amount: formatMoney(computeLine(l).total, ""),
    })),
    { kind: "rule" },
    ...(t.discount - promo > 0 ? [{ kind: "pair", right: "الخصم", left: formatMoney(t.discount - promo) } as Row] : []),
    ...(r?.showSavings !== false && promo > 0 ? [{ kind: "pair", right: "وفّرت من العروض", left: formatMoney(promo) } as Row] : []),
    ...(t.tax > 0 ? [{ kind: "pair", right: "منها ضريبة", left: formatMoney(t.tax) } as Row] : []),
    { kind: "pair", right: "الإجمالي", left: formatMoney(t.total), size: 30, bold: true },
    ...s.payments.map((p): Row => ({ kind: "pair", right: METHOD[p.method], left: formatMoney(p.amountMinor) })),
    ...((d.changeMinor ?? 0) > 0 ? [{ kind: "pair", right: "الباقي", left: formatMoney(d.changeMinor ?? 0) } as Row] : []),
    ...(d.points
      ? [
          { kind: "rule" } as Row,
          ...(d.points.spent > 0 ? [{ kind: "pair", right: "نقاط مصروفة", left: String(d.points.spent) } as Row] : []),
          ...(d.points.earned > 0 ? [{ kind: "pair", right: "نقاط كسبتها", left: `+${d.points.earned}` } as Row] : []),
          { kind: "pair", right: "رصيد نقاطك", left: String(d.points.balance), bold: true } as Row,
        ]
      : []),
    { kind: "rule" },
    ...tail,
  ];
}

const FONT = `"Cairo", "Segoe UI", Tahoma, Arial, sans-serif`;

/** Loads the pictures a receipt shows (the logo), so drawing it stays synchronous. */
export async function loadReceiptImages(rows: Row[]): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  for (const r of rows) {
    if (r.kind !== "image" || out.has(r.src)) continue;
    const img = new Image();
    img.src = r.src;
    try {
      await img.decode();
      out.set(r.src, img);
    } catch {
      /* a broken logo is left out */
    }
  }
  return out;
}

/** Lays the rows out on a canvas `dots` wide (384 for 58 mm, 576 for 80 mm paper). */
export function drawReceipt(rows: Row[], dots: number, images = new Map<string, HTMLImageElement>()): HTMLCanvasElement {
  const pad = Math.round(dots * 0.02);
  const base = dots >= 576 ? 22 : 20;
  const scale = base / 22;
  const canvas = document.createElement("canvas");
  canvas.width = dots;
  canvas.height = 4000;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, dots, canvas.height);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  ctx.direction = "rtl";
  const font = (size = 22, bold = false) => {
    ctx.font = `${bold ? "700" : "400"} ${Math.round(size * scale)}px ${FONT}`;
    return Math.round(size * scale * 1.45);
  };
  const wrap = (text: string, max: number) => {
    const words = text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width > max && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  let y = pad;
  for (const r of rows) {
    if (r.kind === "space") y += r.h;
    else if (r.kind === "image") {
      const img = images.get(r.src);
      if (!img) continue;
      // At most half the paper wide and 160 dots high, centred.
      const k = Math.min((dots * 0.5) / img.width, 160 / img.height, 1);
      const w = Math.round(img.width * k);
      const h = Math.round(img.height * k);
      ctx.drawImage(img, Math.round((dots - w) / 2), y, w, h);
      y += h + 8;
    }
    else if (r.kind === "rule") {
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad, y + 6);
      ctx.lineTo(dots - pad, y + 6);
      ctx.stroke();
      ctx.setLineDash([]);
      y += 14;
    } else if (r.kind === "center") {
      const lh = font(r.size, r.bold);
      ctx.textAlign = "center";
      for (const line of wrap(r.text, dots - 2 * pad)) {
        ctx.fillText(line, dots / 2, y);
        y += lh;
      }
    } else if (r.kind === "pair") {
      const lh = font(r.size, r.bold);
      ctx.textAlign = "right";
      ctx.fillText(r.right, dots - pad, y);
      ctx.textAlign = "left";
      ctx.direction = "ltr";
      ctx.fillText(r.left, pad, y);
      ctx.direction = "rtl";
      y += lh;
    } else {
      let lh = font(22, true);
      ctx.textAlign = "right";
      for (const line of wrap(r.name, dots - 2 * pad)) {
        ctx.fillText(line, dots - pad, y);
        y += lh;
      }
      lh = font(20);
      ctx.fillText(r.detail, dots - pad, y);
      ctx.textAlign = "left";
      ctx.direction = "ltr";
      font(20, true);
      ctx.fillText(r.amount, pad, y);
      ctx.direction = "rtl";
      y += lh + 4;
    }
  }
  const out = document.createElement("canvas");
  out.width = dots;
  out.height = y + pad;
  out.getContext("2d")!.drawImage(canvas, 0, 0);
  return out;
}
