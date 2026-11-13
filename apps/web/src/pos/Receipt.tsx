import type { SaleInput, ShopSettings } from "@pos/shared";
import type { KitchenLine, OrderType } from "@pos/shared";
import { receiptRows } from "../hardware/receiptImage";
import type { ReturnDone } from "./ReturnDialog";
import type { ShiftReport } from "./shiftReport";

export interface ReceiptData {
  /** The branch's name (the shop's own name comes from `shop` when known). */
  storeName: string;
  /** The branch's own thank-you line, over the shop's. */
  footer?: string | null;
  deviceName: string;
  cashierName: string;
  /** The shop's name and settings: logo, address, phone, bank account, what to show. */
  shop?: { name: string; settings: ShopSettings } | null;
  /** Printed again later: marked as a copy. */
  copy?: boolean;
  sale?: SaleInput;
  changeMinor?: number;
  customerName?: string | null;
  /** Not printed: where the till offers to send the invoice on WhatsApp. */
  customerPhone?: string | null;
  employeeName?: string | null;
  ret?: ReturnDone;
  payment?: { customerName: string; amountMinor: number; method: "cash" | "card"; balanceMinor: number; at: string };
  /** Loyalty points on this sale, worked out on the till. */
  points?: { earned: number; spent: number; balance: number };
  /** The shift-close (Z) report. */
  shift?: ShiftReport;
  /** A slip for the kitchen: what to make, with no prices. */
  kitchen?: { label: string; orderType: OrderType; at: string; lines: KitchenLine[] };
}

/**
 * The receipt as the browser prints it. Drawn from the same rows as the thermal printer's
 * picture, so both papers always say the same thing.
 */
export function Receipt({ data, preview }: { data: ReceiptData | null; preview?: boolean }) {
  // The preview is a picture of the paper on screen; only the plain one goes to the printer.
  const cls = preview ? "receipt-paper" : "receipt";
  if (!data) return <div className={cls} />;
  return (
    <div className={cls}>
      {receiptRows(data).map((r, i) => {
        if (r.kind === "image") return <div key={i} style={{ textAlign: "center" }}><img src={r.src} alt="" style={{ maxWidth: "50%", maxHeight: 60 }} /></div>;
        if (r.kind === "rule") return <hr key={i} />;
        if (r.kind === "space") return <div key={i} style={{ height: r.h / 3 }} />;
        if (r.kind === "center") return <div key={i} style={{ textAlign: "center", fontWeight: r.bold ? 700 : 400, fontSize: r.size ? `${Math.round(r.size / 2)}px` : undefined }}>{r.text}</div>;
        if (r.kind === "pair") {
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: r.bold ? 700 : 400, fontSize: r.size ? `${Math.round(r.size / 2)}px` : undefined }}>
              <span>{r.right}</span><span className="num">{r.left}</span>
            </div>
          );
        }
        return (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <div><div>{r.name}</div><div className="num">{r.detail}</div></div>
            <span className="num" style={{ alignSelf: "end" }}>{r.amount}</span>
          </div>
        );
      })}
    </div>
  );
}
