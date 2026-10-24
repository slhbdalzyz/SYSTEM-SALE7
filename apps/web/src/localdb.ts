import Dexie, { type Table } from "dexie";
import type { CatalogCustomer, CatalogProduct, SaleInput } from "@pos/shared";

export type OutboxKind = "shift_open" | "sale" | "shift_close";

export interface OutboxItem {
  seq?: number;
  kind: OutboxKind;
  refId: string;
  payload: unknown;
  createdAt: string;
  error?: string;
}

/** A sale kept on the device too, for reprinting and for the shift's cash count while offline. */
export interface LocalSale {
  id: string;
  number: string;
  shiftId: string | null;
  createdAt: string;
  totalMinor: number;
  cashInMinor: number;
  changeMinor: number;
  cashierName: string;
  /** For returns there is no SaleInput; the receipt data is kept instead. */
  input: SaleInput | null;
  kind?: "sale" | "return" | "payment";
}

export interface LocalShift {
  id: string;
  openedAt: string;
  openingCashMinor: number;
  cashierName: string;
  closedAt?: string;
}

export interface HeldCart {
  id: string;
  createdAt: string;
  label: string;
  lines: unknown[];
}

class PosDb extends Dexie {
  products!: Table<CatalogProduct, string>;
  barcodes!: Table<{ code: string; productId: string; unitId: string }, string>;
  outbox!: Table<OutboxItem, number>;
  sales!: Table<LocalSale, string>;
  shifts!: Table<LocalShift, string>;
  held!: Table<HeldCart, string>;
  meta!: Table<{ key: string; value: unknown }, string>;
  customers!: Table<CatalogCustomer, string>;

  constructor() {
    super("pos");
    this.version(1).stores({
      products: "id, name, scaleCode, sku",
      barcodes: "code, productId",
      outbox: "++seq, kind, refId",
      sales: "id, shiftId, createdAt",
      shifts: "id, closedAt",
      held: "id",
      meta: "key",
    });
    this.version(2).stores({ customers: "id, name, phone" });
  }
}

export const db = new PosDb();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}

/** Replaces or merges products in the local catalog and rebuilds their barcode index. */
export async function storeCatalog(products: CatalogProduct[], full: boolean) {
  await db.transaction("rw", db.products, db.barcodes, async () => {
    if (full) {
      await db.products.clear();
      await db.barcodes.clear();
    } else {
      await db.barcodes.where("productId").anyOf(products.map((p) => p.id)).delete();
    }
    await db.products.bulkPut(products);
    await db.barcodes.bulkPut(products.flatMap((p) => p.units.flatMap((u) => u.barcodes.map((code) => ({ code, productId: p.id, unitId: u.id })))));
  });
}

/** Next invoice number for this device: P1-000123. */
export async function nextInvoiceNumber(prefix: string): Promise<string> {
  return db.transaction("rw", db.meta, async () => {
    const n = ((await getMeta<number>("invoiceSeq")) ?? 0) + 1;
    await setMeta("invoiceSeq", n);
    return `${prefix}-${String(n).padStart(6, "0")}`;
  });
}
