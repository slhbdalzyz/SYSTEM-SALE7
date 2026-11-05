import { formatMoney, formatQty, computeLine, computeTotals, type SaleInput } from "@pos/shared";

import type { ReturnDone } from "./ReturnDialog";

export interface ReceiptData {
  storeName: string;
  footer?: string | null;
  deviceName: string;
  cashierName: string;
  sale?: SaleInput;
  changeMinor?: number;
  customerName?: string | null;
  ret?: ReturnDone;
  payment?: { customerName: string; amountMinor: number; method: "cash" | "card"; balanceMinor: number; at: string };
}

const METHOD = { cash: "كاش", card: "بطاقة", credit: "آجل" } as const;

function Head({ data, title, number, at }: { data: ReceiptData; title: string; number?: string; at: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <b style={{ fontSize: 14 }}>{data.storeName}</b>
      <div>{title}{number && <> رقم <span className="num">{number}</span></>}</div>
      <div className="num">{new Date(at).toLocaleString("en-GB")}</div>
      <div>{data.deviceName} · {data.cashierName}</div>
    </div>
  );
}

export function Receipt({ data }: { data: ReceiptData | null }) {
  if (!data) return <div className="receipt" />;
  if (data.ret) {
    const r = data.ret;
    return (
      <div className="receipt">
        <Head data={data} title="مرتجع" number={r.number} at={new Date().toISOString()} />
        <div>عن الفاتورة <span className="num">{r.originalNumber}</span>{r.customerName && <> · {r.customerName}</>}</div>
        <hr />
        <table><tbody>{r.lines.map((l, i) => (
          <tr key={i}><td>{l.name} <span className="num">× {formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}</span></td><td className="num" style={{ textAlign: "left" }}>{formatMoney(l.totalMinor, "")}</td></tr>
        ))}</tbody></table>
        <hr />
        <div style={{ fontSize: 14 }}><b>المبلغ المرجع: <span className="num">{formatMoney(r.totalMinor)}</span></b></div>
        <div>{METHOD[r.method]} · السبب: {r.reason}</div>
      </div>
    );
  }
  if (data.payment) {
    const p = data.payment;
    return (
      <div className="receipt">
        <Head data={data} title="إيصال تسديد" at={p.at} />
        <hr />
        <div>العميل: {p.customerName}</div>
        <div style={{ fontSize: 14 }}><b>المبلغ: <span className="num">{formatMoney(p.amountMinor)}</span></b> ({METHOD[p.method]})</div>
        <div>الرصيد المتبقي: <span className="num">{formatMoney(p.balanceMinor)}</span></div>
      </div>
    );
  }
  const sale = data.sale!;
  const t = computeTotals(sale.lines, sale.invoiceDiscountMinor);
  return (
    <div className="receipt">
      <Head data={data} title="فاتورة" number={sale.number} at={sale.createdAt} />
      {data.customerName && <div>العميل: {data.customerName}</div>}
      <hr />
      <table>
        <tbody>
          {sale.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.name}
                <div className="num">{formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)} × {formatMoney(l.priceMinor, "")}</div>
                {l.promoMinor > 0 && <div>{l.offerName ?? "عرض"} −<span className="num">{formatMoney(l.promoMinor, "")}</span></div>}
              </td>
              <td className="num" style={{ textAlign: "left", verticalAlign: "top" }}>{formatMoney(computeLine(l).total, "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr />
      {t.discount > 0 && <div>الخصم: <span className="num">{formatMoney(t.discount)}</span></div>}
      <div style={{ fontSize: 14 }}><b>الإجمالي: <span className="num">{formatMoney(t.total)}</span></b></div>
      {sale.payments.map((p, i) => (
        <div key={i}>{METHOD[p.method]}: <span className="num">{formatMoney(p.amountMinor)}</span></div>
      ))}
      {(data.changeMinor ?? 0) > 0 && <div>الباقي: <span className="num">{formatMoney(data.changeMinor ?? 0)}</span></div>}
      <hr />
      <div style={{ textAlign: "center" }}>{data.footer ?? "شكراً لزيارتكم"}</div>
    </div>
  );
}
