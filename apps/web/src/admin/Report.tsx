import { useEffect, useState } from "react";
import { formatMoney, formatQty } from "@pos/shared";
import type { Call } from "./Admin";

interface Daily {
  sales_count: number;
  total_minor: number;
  discount_minor: number;
  returns_count: number;
  returns_minor: number;
  customerPayments: Record<string, number>;
  gross_profit_minor: number;
  byMethod: Record<string, number>;
  byCashier: { name: string; sales_count: number; total_minor: number }[];
  topProducts: { name: string; qty_milli: number; total_minor: number }[];
  byHour: { hour: number; sales_count: number; total_minor: number }[];
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());

export function Report({ call, storeId }: { call: Call; storeId: string }) {
  const [date, setDate] = useState(today);
  const [r, setR] = useState<Daily | null>(null);
  const [low, setLow] = useState<{ id: string; name: string; stock_milli: number }[]>([]);

  useEffect(() => {
    call<Daily>(`/reports/daily?storeId=${storeId}&date=${date}`).then(setR).catch(() => setR(null));
    call<typeof low>(`/stock/low?storeId=${storeId}`).then(setLow).catch(() => setLow([]));
  }, [call, storeId, date]);

  const maxHour = Math.max(1, ...(r?.byHour.map((h) => h.total_minor) ?? [1]));

  return (
    <div className="stack">
      <div className="row">
        <label style={{ width: 200 }}>اليوم<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      {r && (
        <>
          <div className="kpis">
            <div className="kpi"><span className="muted">صافي المبيعات</span><b className="num">{formatMoney(r.total_minor)}</b></div>
            <div className="kpi"><span className="muted">عدد الفواتير</span><b className="num">{r.sales_count}</b></div>
            <div className="kpi"><span className="muted">متوسط الفاتورة</span><b className="num">{formatMoney(r.sales_count ? Math.round(r.total_minor / r.sales_count) : 0)}</b></div>
            <div className="kpi"><span className="muted">الربح التقريبي</span><b className="num">{formatMoney(r.gross_profit_minor)}</b></div>
            <div className="kpi"><span className="muted">كاش</span><b className="num">{formatMoney(r.byMethod.cash ?? 0)}</b></div>
            <div className="kpi"><span className="muted">بطاقة</span><b className="num">{formatMoney(r.byMethod.card ?? 0)}</b></div>
            <div className="kpi"><span className="muted">آجل</span><b className="num">{formatMoney(r.byMethod.credit ?? 0)}</b></div>
            <div className="kpi"><span className="muted">المرتجعات ({r.returns_count})</span><b className="num">{formatMoney(r.returns_minor)}</b></div>
            <div className="kpi"><span className="muted">تسديد ديون</span><b className="num">{formatMoney((r.customerPayments.cash ?? 0) + (r.customerPayments.card ?? 0))}</b></div>
            <div className="kpi"><span className="muted">الخصومات</span><b className="num">{formatMoney(r.discount_minor)}</b></div>
          </div>
          <div className="card stack">
            <b>المبيعات حسب الساعة</b>
            {r.byHour.length === 0 && <span className="muted">ما فيش مبيعات</span>}
            {r.byHour.map((h) => (
              <div key={h.hour} className="row" style={{ flexWrap: "nowrap" }}>
                <span className="num" style={{ width: 48 }}>{String(h.hour).padStart(2, "0")}:00</span>
                <div style={{ flex: 1, background: "var(--line)", borderRadius: 6 }}>
                  <div style={{ width: `${(h.total_minor / maxHour) * 100}%`, background: "var(--brand)", height: 14, borderRadius: 6 }} />
                </div>
                <span className="num" style={{ width: 130, textAlign: "left" }}>{formatMoney(h.total_minor)}</span>
              </div>
            ))}
          </div>
          <div className="kpis">
            <div className="card">
              <b>الأكثر مبيعاً</b>
              <table><tbody>{r.topProducts.map((p) => (
                <tr key={p.name}><td>{p.name}</td><td className="num">{formatQty(p.qty_milli, p.qty_milli % 1000 !== 0)}</td><td className="num">{formatMoney(p.total_minor)}</td></tr>
              ))}</tbody></table>
            </div>
            <div className="card">
              <b>حسب الكاشير</b>
              <table><tbody>{r.byCashier.map((c) => (
                <tr key={c.name}><td>{c.name}</td><td className="num">{c.sales_count}</td><td className="num">{formatMoney(c.total_minor)}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
        </>
      )}
      {low.length > 0 && (
        <div className="card">
          <b>أصناف قربت تخلص</b>
          <table><tbody>{low.map((p) => (
            <tr key={p.id}><td>{p.name}</td><td className="num">{formatQty(p.stock_milli, p.stock_milli % 1000 !== 0)}</td></tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  );
}
