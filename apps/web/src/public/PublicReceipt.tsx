import { useEffect, useState } from "react";
import { formatMoney, readShopSettings, waLink, type ShopSettings } from "@pos/shared";
import { api } from "../api";
import { Receipt, type ReceiptData } from "../pos/Receipt";
import { receiptFromDetail } from "../admin/Invoices";

type Detail = Parameters<typeof receiptFromDetail>[0] & { shop: { name: string; settings: Partial<ShopSettings> } };

/** The invoice a customer opens from the WhatsApp message: the receipt itself, to keep or print. */
export function PublicReceipt({ id }: { id: string }) {
  const [data, setData] = useState<{ r: ReceiptData; d: Detail; settings: ShopSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/public/receipts/${id}`)
      .then((d) => {
        const settings = readShopSettings(d.shop.settings);
        const r = { ...receiptFromDetail(d, { name: d.shop.name, settings }), copy: false };
        setData({ r, d, settings });
        document.title = `فاتورة ${d.number} · ${d.shop.name}`;
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) {
    return (
      <div className="center">
        <div className="card stack" style={{ maxWidth: 420, textAlign: "center" }}>
          <b>ما لقيناش الفاتورة</b>
          <span className="muted">لو الفاتورة توها تعملت، ممكن الكاشير لسه ما تزامنش. جرب بعد شوية.</span>
          <button onClick={() => location.reload()}>إعادة المحاولة</button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="center muted">جاري التحميل…</div>;
  const { r, d, settings } = data;
  const phone = settings.phone || settings.phone2;
  return (
    <div className="public-receipt">
      <div className="public-head">
        <b>{d.shop.name}</b>
        <span className="muted">{d.kind === "return" ? "مرتجع" : "فاتورة"} {d.number} · <span className="num">{formatMoney(Math.abs(d.total_minor))}</span></span>
      </div>
      <Receipt data={r} preview />
      <div className="row public-actions">
        <button className="primary" onClick={() => window.print()}>🖨️ طباعة / حفظ PDF</button>
        {phone && <a className="button" href={`tel:${phone}`}>📞 اتصل بالمحل</a>}
        {phone && <a className="button" href={waLink(phone, `بخصوص الفاتورة ${d.number}`)} target="_blank" rel="noopener">💬 واتساب المحل</a>}
      </div>
      <Receipt data={r} />
    </div>
  );
}
