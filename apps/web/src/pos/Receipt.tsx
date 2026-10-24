import { formatMoney, formatQty, computeLine, computeTotals, type SaleInput } from "@pos/shared";

export interface ReceiptData {
  storeName: string;
  footer?: string | null;
  deviceName: string;
  cashierName: string;
  sale: SaleInput;
  changeMinor: number;
}

const METHOD = { cash: "كاش", card: "بطاقة", credit: "آجل" } as const;

export function Receipt({ data }: { data: ReceiptData | null }) {
  if (!data) return <div className="receipt" />;
  const { sale } = data;
  const t = computeTotals(sale.lines, sale.invoiceDiscountMinor);
  return (
    <div className="receipt">
      <div style={{ textAlign: "center" }}>
        <b style={{ fontSize: 14 }}>{data.storeName}</b>
        <div>فاتورة رقم <span className="num">{sale.number}</span></div>
        <div className="num">{new Date(sale.createdAt).toLocaleString("en-GB")}</div>
        <div>{data.deviceName} · {data.cashierName}</div>
      </div>
      <hr />
      <table>
        <tbody>
          {sale.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.name}
                <div className="num">{formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)} × {formatMoney(l.priceMinor, "")}</div>
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
      {data.changeMinor > 0 && <div>الباقي: <span className="num">{formatMoney(data.changeMinor)}</span></div>}
      <hr />
      <div style={{ textAlign: "center" }}>{data.footer ?? "شكراً لزيارتكم"}</div>
    </div>
  );
}
