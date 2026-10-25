// Draws a receipt on a canvas the width of the paper. The browser does the Arabic shaping,
// so the printer only ever gets black and white dots.
import { computeLine, computeTotals, formatMoney, formatQty } from "@pos/shared";
import type { ReceiptData } from "../pos/Receipt";

type Row =
  | { kind: "center"; text: string; size?: number; bold?: boolean }
  | { kind: "pair"; right: string; left: string; size?: number; bold?: boolean }
  | { kind: "item"; name: string; detail: string; amount: string }
  | { kind: "rule" }
  | { kind: "space"; h: number };

const METHOD = { cash: "كاش", card: "بطاقة", credit: "آجل" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

export function receiptRows(d: ReceiptData): Row[] {
  const head = (title: string, at: string): Row[] => [
    { kind: "center", text: d.storeName, size: 30, bold: true },
    { kind: "center", text: title, size: 24, bold: true },
    { kind: "center", text: when(at) },
    { kind: "center", text: `${d.deviceName} · ${d.cashierName}` },
    { kind: "rule" },
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
      { kind: "pair", right: "المبلغ المرجع", left: formatMoney(r.totalMinor), size: 26, bold: true },
      { kind: "pair", right: "طريقة الإرجاع", left: METHOD[r.method] },
      { kind: "pair", right: "السبب", left: r.reason },
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
    ];
  }
  const s = d.sale!;
  const t = computeTotals(s.lines, s.invoiceDiscountMinor);
  return [
    ...head(`فاتورة ${s.number}`, s.createdAt),
    ...(d.customerName ? [{ kind: "pair", right: "العميل", left: d.customerName } as Row, { kind: "rule" } as Row] : []),
    ...s.lines.map((l): Row => ({
      kind: "item",
      name: l.name,
      detail: `${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)} × ${formatMoney(l.priceMinor, "")}${l.discountMinor ? ` (خصم ${formatMoney(l.discountMinor, "")})` : ""}${l.promoMinor ? ` (${l.offerName ?? "عرض"} −${formatMoney(l.promoMinor, "")})` : ""}`,
      amount: formatMoney(computeLine(l).total, ""),
    })),
    { kind: "rule" },
    ...(t.discount > 0 ? [{ kind: "pair", right: "الخصم", left: formatMoney(t.discount) } as Row] : []),
    ...(s.lines.some((l) => l.promoMinor) ? [{ kind: "pair", right: "وفّرت من العروض", left: formatMoney(s.lines.reduce((a, l) => a + (l.promoMinor ?? 0), 0)) } as Row] : []),
    ...(t.tax > 0 ? [{ kind: "pair", right: "منها ضريبة", left: formatMoney(t.tax) } as Row] : []),
    { kind: "pair", right: "الإجمالي", left: formatMoney(t.total), size: 30, bold: true },
    ...s.payments.map((p): Row => ({ kind: "pair", right: METHOD[p.method], left: formatMoney(p.amountMinor) })),
    ...((d.changeMinor ?? 0) > 0 ? [{ kind: "pair", right: "الباقي", left: formatMoney(d.changeMinor ?? 0) } as Row] : []),
    { kind: "rule" },
    { kind: "space", h: 6 },
    { kind: "center", text: d.footer ?? "شكراً لزيارتكم" },
  ];
}

const FONT = `"Cairo", "Segoe UI", Tahoma, Arial, sans-serif`;

/** Lays the rows out on a canvas `dots` wide (384 for 58 mm, 576 for 80 mm paper). */
export function drawReceipt(rows: Row[], dots: number): HTMLCanvasElement {
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
