import { toMinor } from "@pos/shared";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** What a spreadsheet can bring in, and the columns of each. The first name is the template's header. */
export const SHEETS = {
  products: {
    title: "الأصناف",
    cols: {
      name: ["اسم الصنف", "الاسم", "الصنف", "name", "item"],
      barcode: ["الباركود", "باركود", "الكود", "barcode", "code"],
      category: ["القسم", "التصنيف", "category"],
      unit: ["الوحدة", "unit"],
      pack: ["العبوة الكبيرة", "وحدة الجملة", "العبوة", "pack"],
      packQty: ["فيها كم", "العدد في العبوة", "عدد الحبات", "pack qty"],
      packPrice: ["سعر العبوة", "سعر الجملة", "pack price"],
      packBarcode: ["باركود العبوة", "باركود الجملة", "pack barcode"],
      price: ["سعر البيع", "السعر", "price"],
      cost: ["التكلفة", "سعر الشراء", "cost"],
      qty: ["الكمية الموجودة", "الكمية", "المخزون", "qty", "quantity", "stock"],
      min: ["حد التنبيه", "الحد الأدنى", "min"],
      weighted: ["بالوزن", "موزون", "weighted"],
      service: ["خدمة", "خدمة بدون مخزون", "service"],
    },
    example: [
      ["سكر 1 كيلو", "6281000000011", "المواد الغذائية", "كيس", "شوال", "10", "42", "", "4.500", "3.800", "24", "5", "لا", "لا"],
      ["بيبسي علبة", "6281000000028", "المشروبات", "علبة", "صندوق", "24", "30", "6281000000035", "1.500", "1.000", "96", "24", "لا", "لا"],
      ["طماطم", "", "الخضروات والفواكه", "كيلو", "", "", "", "", "3.500", "2.500", "40.5", "", "نعم", "لا"],
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

/** Words for a packing that holds several pieces: typed as the unit, they mean the line is per box. */
export const BIG_UNITS = ["صندوق", "كرتونة", "كرتون", "شد", "باكو", "شوال", "طرد", "درزن", "دستة"];

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
      const p0 = num("price", "السعر"), c0 = num("cost", "التكلفة"), q0 = num("qty", "الكمية");
      const min = num("min", "حد التنبيه"), per = num("packQty", "العدد في العبوة"), packPriceIn = num("packPrice", "سعر العبوة");
      if (p0 === null || c0 === null || q0 === null || min === null || per === null || packPriceIn === null) return;
      let price = p0, cost = c0, qty = q0;
      const code = (k: string) => String(cell(r, k) ?? "").replace(/\.0+$/, "").replace(/\s/g, "");
      const barcode = code("barcode");
      // A service (a repair, a fitting) has no stock: no quantity, no weighing, no box.
      const service = yes(cell(r, "service"));
      const weighted = !service && yes(cell(r, "weighted"));
      let unit = str(r, "unit");
      let pack = str(r, "pack");
      let packPrice = packPriceIn;
      if (per !== undefined && !weighted && !service) {
        if (per < 2 || !Number.isInteger(per)) return errors.push({ row: line, message: `العدد في العبوة لازم رقم صحيح أكبر من 1: ${per}` });
        // «صندوق فيه 24» typed in the unit box: the whole line is per box, and the piece is worked out from it.
        if (!pack && BIG_UNITS.includes(unit)) {
          pack = unit;
          unit = "حبة";
          if (price !== undefined && packPrice === undefined) { packPrice = price; price = Math.round((price / per) * 1000) / 1000; }
          if (cost !== undefined) cost = Math.round((cost / per) * 1000) / 1000;
          if (qty !== undefined) qty = qty * per;
        }
        pack ||= "صندوق";
      } else if (pack && !weighted && !service) {
        return errors.push({ row: line, message: `اكتب كم حبة في الـ${pack}` });
      }
      const withPack = per !== undefined && !weighted && !service;
      const packCode = withPack ? code("packBarcode") : "";
      lines.push(line);
      rows.push({
        name, ...(barcode ? { barcode } : {}), ...(str(r, "category") ? { category: str(r, "category") } : {}), ...(unit ? { unit } : {}),
        priceMinor: toMinor(price ?? 0), costMinor: toMinor(cost ?? 0), qtyMilli: service ? 0 : toMinor(qty ?? 0), minStockMilli: service ? 0 : toMinor(min ?? 0), weighted,
        ...(service ? { service: true } : {}),
        ...(withPack ? { packUnit: pack, packFactorMilli: toMinor(per!), ...(packPrice !== undefined ? { packPriceMinor: toMinor(packPrice) } : {}), ...(packCode ? { packBarcode: packCode } : {}) } : {}),
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

const xml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/**
 * A one-sheet .xlsx file, right to left, with a bold first row. Numbers are written as numbers;
 * everything else, barcodes and phones included, as text, so Excel keeps their digits.
 */
export function writeXlsx(title: string, rows: (string | number | null)[][]): Blob {
  const cells = rows.map((r, ri) =>
    `<row r="${ri + 1}">` +
    r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      const style = ri === 0 ? ` s="1"` : "";
      if (v === null || v === "") return "";
      if (typeof v === "number") return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    }).join("") +
    `</row>`).join("");
  const widths = (rows[0] ?? []).map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 40 : 16}" customWidth="1"/>`).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(title.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths ? `<cols>${widths}</cols>` : ""}<sheetData>${cells}</sheetData></worksheet>`,
  };
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  return new Blob([new Uint8Array(zipped)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** The template's headers for a sheet, in order: what «من الدفتر للنظام» reads back. */
export const headersOf = (kind: SheetKind) => Object.values(SHEETS[kind].cols).map((c) => c[0]);
