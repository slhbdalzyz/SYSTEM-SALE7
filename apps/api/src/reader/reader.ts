// Reading a photo of a page from the shop's notebook into rows the owner checks before saving.
// The routes talk to a PageReader; which one depends on the deployment: Claude when its API key is
// set, a stand-in for the demo and tests, or none (the page then says reading photos is off).

export const PAPER_KINDS = ["products", "customers", "suppliers"] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** One line read off the page, by the column names the hand-typing grid uses; "" when not written. */
export type PaperRow = Record<string, string>;

export interface PageReader {
  name: string;
  read(kind: PaperKind, image: { data: string; mediaType: ImageType }): Promise<PaperRow[]>;
}

export class ReaderError extends Error {}

/** The columns read for each kind of page, with what each holds (the reader's instructions use these). */
export const PAPER_COLUMNS: Record<PaperKind, Record<string, string>> = {
  products: {
    name: "اسم الصنف كما هو مكتوب",
    category: "القسم إن كان مكتوباً، وإلا فارغ",
    unit: "وحدة البيع (حبة، كيلو، علبة، كرتونة…) إن كانت مكتوبة",
    price: "سعر البيع بالدينار، أرقام فقط",
    cost: "سعر الشراء أو التكلفة بالدينار، أرقام فقط",
    qty: "الكمية الموجودة، أرقام فقط",
  },
  customers: {
    name: "اسم العميل",
    phone: "رقم الهاتف، أرقام فقط",
    balance: "المبلغ اللي عليه بالدينار (الباقي بعد ما دفع إن كان مكتوب دفع وأخذ)، أرقام فقط",
  },
  suppliers: {
    name: "اسم المورد",
    phone: "رقم الهاتف، أرقام فقط",
    balance: "المبلغ المستحق له بالدينار، أرقام فقط",
  },
};

let current: PageReader | null = null;
export const setReader = (r: PageReader | null) => { current = r; };
export const getReader = () => current;

/** Keeps only the known columns, as trimmed strings, and drops empty lines. */
export function cleanRows(kind: PaperKind, rows: unknown): PaperRow[] {
  if (!Array.isArray(rows)) return [];
  const keys = Object.keys(PAPER_COLUMNS[kind]);
  return rows
    .map((r) => Object.fromEntries(keys.map((k) => [k, String((r as Record<string, unknown>)?.[k] ?? "").trim().slice(0, 200)])))
    .filter((r) => r.name)
    .slice(0, 300);
}
