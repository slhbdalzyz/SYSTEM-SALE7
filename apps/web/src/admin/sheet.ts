import { toMinor } from "@pos/shared";
import { strFromU8, unzipSync } from "fflate";

/** What a spreadsheet can bring in, and the columns of each. The first name is the template's header. */
export const SHEETS = {
  products: {
    title: "الأصناف",
    cols: {
      name: ["اسم الصنف", "الاسم", "الصنف", "name", "item"],
      barcode: ["الباركود", "باركود", "الكود", "barcode", "code"],
      category: ["القسم", "التصنيف", "category"],
      unit: ["الوحدة", "unit"],
      price: ["سعر البيع", "السعر", "price"],
      cost: ["التكلفة", "سعر الشراء", "cost"],
      qty: ["الكمية الموجودة", "الكمية", "المخزون", "qty", "quantity", "stock"],
      min: ["حد التنبيه", "الحد الأدنى", "min"],
      weighted: ["بالوزن", "موزون", "weighted"],
    },
    example: [
      ["سكر 1 كيلو", "6281000000011", "المواد الغذائية", "كيس", "4.500", "3.800", "24", "5", "لا"],
      ["طماطم", "", "الخضروات والفواكه", "كيلو", "3.500", "2.500", "40.5", "", "نعم"],
    ],
  },
  customers: {
    title: "العملاء وديونهم",
    cols: {
      name: ["اسم العميل", "الاسم", "العميل", "name"],
      phone: ["رقم الهاتف", "الهاتف", "التلفون", "الرقم", "phone"],
      balance: ["الدين القديم", "الدين", "الرصيد", "المبلغ", "balance", "debt"],
      limit: ["حد الدين", "الحد", "limit"],
    },
    example: [["محمد الطاهر", "0912345678", "125.500", "300"], ["سالم علي", "", "40", ""]],
  },
  suppliers: {
    title: "الموردين وأرصدتهم",
    cols: {
      name: ["اسم المورد", "الاسم", "المورد", "الشركة", "name"],
      phone: ["رقم الهاتف", "الهاتف", "التلفون", "phone"],
      balance: ["المستحق له", "الرصيد", "الدين", "المبلغ", "balance"],
    },
    example: [["شركة النسيم للتوزيع", "0925550000", "8000"], ["مخبز الفجر", "", "350"]],
  },
} as const;
export type SheetKind = keyof typeof SHEETS;

/** A spreadsheet's text template (opens in Excel; the BOM keeps the Arabic readable). */
export function templateCsv(kind: SheetKind): string {
  const s = SHEETS[kind];
  const head = Object.values(s.cols).map((c) => c[0]);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + [head, ...s.example].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

/** Reads CSV text: commas or semicolons, quoted fields, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A number as people write it: Arabic digits, "1,250.5", "12,5", "125 د.ل". NaN when there is none. */
export function readNumber(v: unknown): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim().replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٫]/g, ".").replace(/[٬\s]/g, "");
  s = s.replace(/[^\d.,-]/g, "").replace(/^[.,]+|[.,]+$/g, "");
  if (!s) return NaN;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (/,\d{3}$/.test(s) && s.split(",").length > 2) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  return Number(s);
}

const norm = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").replace(/[*:]/g, "").toLowerCase();
const yes = (v: unknown) => ["نعم", "اي", "أي", "ايه", "yes", "y", "1", "true", "✓", "x"].includes(norm(v));

/** `lines[i]` is the spreadsheet line `rows[i]` came from. */
export interface Mapped<T> { rows: T[]; lines: number[]; errors: { row: number; message: string }[]; missing: string[] }

/** Finds each column by its header (any of its names), then turns the rows into what the server takes. */
export function mapSheet(kind: SheetKind, table: unknown[][]): Mapped<Record<string, unknown>> {
  const cols = SHEETS[kind].cols as Record<string, readonly string[]>;
  const headAt = table.findIndex((r) => r.some((c) => cols.name.map(norm).includes(norm(c))));
  if (headAt < 0) return { rows: [], lines: [], errors: [], missing: [cols.name[0]] };
  const head = table[headAt].map(norm);
  const at: Record<string, number> = {};
  for (const [k, names] of Object.entries(cols)) at[k] = head.findIndex((h) => names.map(norm).includes(h));
  const rows: Record<string, unknown>[] = [];
  const lines: number[] = [];
  const errors: { row: number; message: string }[] = [];
  const cell = (r: unknown[], k: string) => (at[k] >= 0 ? r[at[k]] : undefined);
  const str = (r: unknown[], k: string) => String(cell(r, k) ?? "").trim();
  table.slice(headAt + 1).forEach((r, i) => {
    const line = headAt + i + 2; // as the spreadsheet numbers it
    if (r.every((c) => String(c ?? "").trim() === "")) return;
    const name = str(r, "name");
    if (!name) return errors.push({ row: line, message: "بدون اسم" });
    const num = (k: string, label: string, allowNeg = false): number | undefined | null => {
      const raw = cell(r, k);
      if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
      const n = readNumber(raw);
      if (!Number.isFinite(n) || (!allowNeg && n < 0)) { errors.push({ row: line, message: `${label} مش رقم: ${raw}` }); return null; }
      return n;
    };
    if (kind === "products") {
      const price = num("price", "السعر"), cost = num("cost", "التكلفة"), qty = num("qty", "الكمية"), min = num("min", "حد التنبيه");
      if ([price, cost, qty, min].includes(null)) return;
      const barcode = String(cell(r, "barcode") ?? "").replace(/\.0+$/, "").replace(/\s/g, "");
      lines.push(line);
      rows.push({
        name, ...(barcode ? { barcode } : {}), ...(str(r, "category") ? { category: str(r, "category") } : {}), ...(str(r, "unit") ? { unit: str(r, "unit") } : {}),
        priceMinor: toMinor(price ?? 0), costMinor: toMinor(cost ?? 0), qtyMilli: toMinor(qty ?? 0), minStockMilli: toMinor(min ?? 0), weighted: yes(cell(r, "weighted")),
      });
    } else {
      const bal = num("balance", "المبلغ", true), limit = kind === "customers" ? num("limit", "حد الدين") : undefined;
      if (bal === null || limit === null) return;
      // Excel drops the leading 0 of a number typed as a number: 912345678 is 0912345678.
      const phone = str(r, "phone").replace(/\.0+$/, "").replace(/^(9[1-5]\d{7})$/, "0$1");
      lines.push(line);
      rows.push({ name, ...(phone ? { phone } : {}), balanceMinor: toMinor(bal ?? 0), ...(limit !== undefined ? { creditLimitMinor: toMinor(limit) } : {}) });
    }
  });
  return { rows, lines, errors, missing: [] };
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");
const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Reads the first sheet of an .xlsx file (a zip of XML) into rows of cells: text, numbers, yes/no. */
export function readXlsx(data: Uint8Array): unknown[][] {
  const files = unzipSync(data, { filter: (f) => f.name === "xl/sharedStrings.xml" || f.name === "xl/workbook.xml" || f.name === "xl/_rels/workbook.xml.rels" || f.name.startsWith("xl/worksheets/sheet") });
  const read = (n: string) => (files[n] ? strFromU8(files[n]) : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // The first sheet in the workbook's order, found through its relationship id.
  const rid = read("xl/workbook.xml").match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
  const target = rid && read("xl/_rels/workbook.xml.rels").match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1];
  const sheetName = target ? `xl/${target.replace(/^\/?xl\//, "")}` : Object.keys(files).filter((n) => n.startsWith("xl/worksheets/sheet")).sort()[0];
  const xml = read(sheetName ?? "");
  const rows: unknown[][] = [];
  let next = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const at = Number(rm[1].match(/\br="(\d+)"/)?.[1] ?? next + 1) - 1;
    next = at + 1;
    const row: unknown[] = [];
    let col = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/\br="([A-Z]+)\d*"/)?.[1];
      const c = ref ? colIndex(ref) : col;
      col = c + 1;
      const type = attrs.match(/\bt="(\w+)"/)?.[1] ?? "n";
      const body = cm[2] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val: unknown = "";
      if (type === "s") val = shared[Number(v)] ?? "";
      else if (type === "inlineStr") val = texts(body);
      else if (type === "str" || type === "e") val = unxml(v ?? "");
      else if (type === "b") val = v === "1";
      else if (v !== undefined && v !== "") val = Number(v);
      row[c] = val;
    }
    rows[at] = Array.from(row, (x) => x ?? "");
  }
  return Array.from(rows, (r) => r ?? []);
}

/** Reads an .xlsx or .csv file into rows of cells. */
export async function readSheetFile(file: File): Promise<unknown[][]> {
  if (/\.csv$|\.txt$/i.test(file.name) || file.type === "text/csv") return parseCsv(await file.text());
  return readXlsx(new Uint8Array(await file.arrayBuffer()));
}
