// Pieces every report screen shares: the period presets, the comparison period, number tiles
// that show the change, panels, and printing a report on paper or as PDF.
import type { ReactNode } from "react";
import { formatMoney } from "@pos/shared";

export const local = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(d);
export const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const span = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);

export const PRESETS: Record<string, () => [string, string]> = {
  "اليوم": () => [local(), local()],
  "أمس": () => [addDays(local(), -1), addDays(local(), -1)],
  "آخر 7 أيام": () => [addDays(local(), -6), local()],
  "آخر 30 يوم": () => [addDays(local(), -29), local()],
  "هذا الشهر": () => [`${local().slice(0, 7)}-01`, local()],
  "الشهر الماضي": () => {
    const first = `${local().slice(0, 7)}-01`;
    const end = addDays(first, -1);
    return [`${end.slice(0, 7)}-01`, end];
  },
  "هذه السنة": () => [`${local().slice(0, 4)}-01-01`, local()],
};

export type Compare = "none" | "prev" | "year";
export const COMPARE_LABELS: Record<Compare, string> = { none: "بدون مقارنة", prev: "مع الفترة اللي قبلها", year: "مع نفس الفترة العام اللي فات" };

/** The stretch to set against [from, to]: the same number of days just before, or a year back. */
export function compareRange(from: string, to: string, c: Compare): [string, string] | null {
  if (c === "none") return null;
  if (c === "year") {
    const back = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`.replace(/-02-29$/, "-02-28");
    return [back(from), back(to)];
  }
  // A whole month against the whole month before, not the same count of days.
  if (from.endsWith("-01") && addDays(to, 1).endsWith("-01")) {
    const end = addDays(from, -1);
    return [`${end.slice(0, 7)}-01`, end];
  }
  const n = span(from, to) + 1;
  return [addDays(from, -n), addDays(from, -1)];
}

export const money = (n: number) => formatMoney(n);
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
export const dinars = (n: number) => (n / 1000).toFixed(3);
export const dm = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;
export const dmy = (d: string | null | undefined) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "");
export const changePct = (now: number, then: number) => (then ? Math.round(((now - then) / Math.abs(then)) * 100) : null);

/** ▲ 12% / ▼ 5%, green when it is good news (for costs, going down is the good news). */
export function Delta({ now, then, lowerIsBetter }: { now: number; then: number | undefined; lowerIsBetter?: boolean }) {
  if (then === undefined) return null;
  const p = changePct(now, then);
  if (p === null) return now ? <span className="delta muted">جديد</span> : null;
  const good = lowerIsBetter ? p <= 0 : p >= 0;
  return <span className={`delta ${p === 0 ? "muted" : good ? "ok" : "bad"}`}>{p > 0 ? "▲" : p < 0 ? "▼" : "="} {Math.abs(p)}%</span>;
}

export function Kpi({ label, value, note, tone, now, was, lowerIsBetter, wasLabel }: {
  label: string; value: string; note?: ReactNode; tone?: "ok" | "bad";
  /** With `was`, the tile shows the change against the comparison period. */
  now?: number; was?: number; lowerIsBetter?: boolean; wasLabel?: string;
}) {
  return (
    <div className="kpi">
      <span className="muted">{label}</span>
      <b className={`num ${tone ?? ""}`}>{value}</b>
      {was !== undefined && now !== undefined && (
        <small className="muted"><Delta now={now} then={was} lowerIsBetter={lowerIsBetter} /> {wasLabel ?? "كانت"} <span className="num">{money(was)}</span></small>
      )}
      {note && <small className="muted">{note}</small>}
    </div>
  );
}

export function Panel({ title, children, onCsv, extra }: { title: string; children: ReactNode; onCsv?: () => void; extra?: ReactNode }) {
  return (
    <div className="card panel">
      <div className="panel-head"><b>{title}</b><span className="spacer" />{extra}{onCsv && <button className="ghost" onClick={onCsv}>⬇ Excel</button>}</div>
      {children}
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export { esc as escHtml };

/** Prints an A4 page made of the given HTML body; the browser's print box also saves it as PDF. */
export function printHtml(title: string, body: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;inset-inline-start:-9999px";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: A4; margin: 14mm; }
    body { font-family: system-ui, "Segoe UI", Tahoma, sans-serif; color: #111; font-size: 12px; }
    h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 2px solid #111; padding-bottom: 3px; }
    .sub { color: #555; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 4px 6px; border-bottom: 1px solid #ddd; text-align: start; }
    th { background: #f2f2f2; } .num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .tile { border: 1px solid #ccc; border-radius: 8px; padding: 8px; } .tile b { display: block; font-size: 15px; margin-top: 2px; }
    .ok { color: #137333; } .bad { color: #b3261e; } .muted { color: #666; }
  </style></head><body>${body}</body></html>`);
  doc.close();
  const go = () => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  setTimeout(go, 200);
}
