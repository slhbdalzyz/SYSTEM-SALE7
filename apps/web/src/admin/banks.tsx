import { useEffect, useState } from "react";
import type { Call } from "./Admin";

export interface Bank { id: string; bankName: string; name: string | null; accountNumber: string | null; iban: string | null; isDefault: boolean; active: boolean }

export const bankLabel = (b: Pick<Bank, "bankName" | "name">) => (b.name ? `${b.bankName} · ${b.name}` : b.bankName);

/** The shop's bank accounts that are still in use, the main one first. */
export function useBanks(call: Call) {
  const [banks, setBanks] = useState<Bank[]>([]);
  useEffect(() => void call<Bank[]>("/money/banks").then((l) => setBanks(l.filter((b) => b.active))).catch(() => setBanks([])), [call]);
  return banks;
}

/**
 * Which bank account the money goes out of (or into). Shown only when the shop has more than one:
 * with a single account (or none) everything lands in the main one by itself.
 */
export function BankSelect({ banks, value, onChange, label = "الحساب المصرفي", allowNone }: {
  banks: Bank[]; value: string | null; onChange: (id: string | null) => void; label?: string; allowNone?: string;
}) {
  if (banks.length < (allowNone ? 1 : 2)) return null;
  const main = banks.find((b) => b.isDefault);
  return (
    <label>{label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{allowNone ?? `🏦 ${main ? bankLabel(main) : "الحساب الرئيسي"} (الرئيسي)`}</option>
        {banks.filter((b) => allowNone || !b.isDefault).map((b) => <option key={b.id} value={b.id}>🏦 {bankLabel(b)}</option>)}
      </select>
    </label>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Prints a simple A4 table (a bank statement, a reconciliation) through the browser. */
export async function printTable(o: { title: string; sub: string[]; header: string[]; rows: (string | number)[][]; foot?: string[] }) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const cell = (v: string | number) => `<td class="${typeof v === "number" ? "n" : ""}">${esc(String(v))}</td>`;
  doc.open();
  doc.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>
    @page { size: A4; margin: 12mm }
    body { font-family: Tahoma, Arial, sans-serif; font-size: 11pt; color: #000; margin: 0 }
    h1 { font-size: 16pt; margin: 0 0 4px } .sub { color: #333; margin: 0 0 2px }
    table { width: 100%; border-collapse: collapse; margin-top: 10px } th, td { border: 1px solid #999; padding: 4px 6px; text-align: right }
    th { background: #eee } td.n { direction: ltr; text-align: left; white-space: nowrap } .foot { margin-top: 10px; font-weight: bold }
  </style></head><body>
    <h1>${esc(o.title)}</h1>${o.sub.map((s) => `<p class="sub">${esc(s)}</p>`).join("")}
    <table><thead><tr>${o.header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${o.rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table>
    ${(o.foot ?? []).map((f) => `<p class="foot">${esc(f)}</p>`).join("")}
    <p class="sub" style="margin-top:16px;font-size:9pt">طُبع ${esc(new Date().toLocaleString("en-GB"))}</p>
  </body></html>`);
  doc.close();
  await new Promise((r) => setTimeout(r, 300));
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 60_000);
}
