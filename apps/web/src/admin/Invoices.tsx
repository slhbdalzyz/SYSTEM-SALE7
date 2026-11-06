import { useEffect, useMemo, useState } from "react";
import { METHOD_LABELS, formatMoney, formatQty, readShopSettings, type RefundMethod, type SaleInput, type ShopSettings } from "@pos/shared";
import type { Call } from "./Admin";
import { sendInvoice } from "../whatsapp";
import { downloadCsv } from "./charts";
import { Modal } from "../pos/dialogs";
import { Receipt, type ReceiptData } from "../pos/Receipt";
import { printReceipt } from "../hardware/printer";

interface Row {
  id: string; number: string; kind: "sale" | "return"; created_at: string; total_minor: number; discount_minor: number; shift_id: string | null;
  store_name: string; device_name: string; cashier: string; customer_name: string | null; employee_name: string | null;
  shift_opened_at: string | null; shift_closed_at: string | null; lines: number; payments: { method: string; amount: number }[]; returned_minor: number;
}
interface List {
  rows: Row[];
  summary: { sales: number; returns: number; salesMinor: number; returnsMinor: number; netMinor: number; discountMinor: number; byMethod: Record<string, number> };
}
interface Detail {
  id: string; number: string; kind: "sale" | "return"; created_at: string; received_at: string | null; subtotal_minor: number; discount_minor: number; tax_minor: number;
  total_minor: number; paid_minor: number; change_minor: number; shift_id: string | null; reason: string | null; original_sale_id: string | null; original_number: string | null;
  store_name: string; receipt_footer: string | null; device_name: string; cashier: string; customer_name: string | null; customer_phone?: string | null; employee_name: string | null; approved_by_name: string | null;
  shift_opened_at: string | null; shift_closed_at: string | null; shift_cashier: string | null;
  lines: { id: string; product_id: string; unit_id: string; name: string; qty_milli: number; price_minor: number; discount_minor: number; tax_minor: number; total_minor: number; promo_minor: number; offer_name: string | null; tax_bp: number }[];
  payments: { method: string; amount_minor: number }[];
  returns: { id: string; number: string; created_at: string; amount_minor: number; reason: string | null }[];
}
interface Shift {
  id: string; user_id: string; opened_at: string; closed_at: string | null; opening_cash_minor: number; closing_cash_minor: number | null; expected_cash_minor: number | null;
  cashier: string; device_name: string; store_name: string; sales: number; sales_minor: number; returns_minor: number; difference_minor: number | null;
}

const local = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(d);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PRESETS: Record<string, () => [string, string]> = {
  "اليوم": () => [local(), local()],
  "أمس": () => [addDays(local(), -1), addDays(local(), -1)],
  "آخر 7 أيام": () => [addDays(local(), -6), local()],
  "هذا الشهر": () => [`${local().slice(0, 7)}-01`, local()],
};
const PAY: Record<string, string> = { ...METHOD_LABELS, cash: "نقدي" };
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tripoli", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tripoli", hour: "2-digit", minute: "2-digit", hour12: false });
const at = (s: string) => fmt.format(new Date(s));
const time = (s: string) => fmtTime.format(new Date(s));
/** A shift as people say it: who, and from when to when. */
const shiftLabel = (cashier: string | null, opened: string | null, closed: string | null) =>
  opened ? `${cashier ?? ""} · ${at(opened)} ← ${closed ? time(closed) : "مفتوحة"}` : "بدون وردية";

/** Builds the paper an invoice was printed on from what the server kept, to print it again. */
export function receiptFromDetail(d: Detail, shop: { name: string; settings: ShopSettings }): ReceiptData {
  const base = { storeName: d.store_name, footer: d.receipt_footer, deviceName: d.device_name, cashierName: d.cashier, shop, copy: true };
  if (d.kind === "return") {
    // A return of a sale paid partly with points gave that part back as points.
    const pointsMinor = -d.payments.filter((p) => p.method === "points").reduce((a, p) => a + p.amount_minor, 0);
    return {
      ...base,
      ret: {
        number: d.number, originalNumber: d.original_number ?? "", customerName: d.customer_name, totalMinor: -d.total_minor, reason: d.reason ?? "",
        refundMinor: -d.total_minor - pointsMinor, pointsMinor, pointsBack: 0, pointsTaken: 0,
        method: (d.payments.find((p) => p.method !== "points")?.method ?? "cash") as RefundMethod,
        lines: d.lines.map((l) => ({ name: l.name, qtyMilli: Math.abs(l.qty_milli), totalMinor: Math.abs(l.total_minor) })),
      },
    };
  }
  const linesTotal = d.lines.reduce((a, l) => a + l.total_minor, 0);
  const sale: SaleInput = {
    id: d.id, number: d.number, createdAt: d.created_at, totalMinor: d.total_minor, invoiceDiscountMinor: Math.max(0, linesTotal - d.total_minor),
    shiftId: d.shift_id,
    lines: d.lines.map((l) => ({
      productId: l.product_id, unitId: l.unit_id, name: l.name, qtyMilli: l.qty_milli, priceMinor: l.price_minor,
      discountMinor: Math.max(0, l.discount_minor - l.promo_minor), promoMinor: l.promo_minor, offerName: l.offer_name, taxBp: l.tax_bp,
    })),
    payments: d.payments.map((p) => ({ method: p.method as SaleInput["payments"][number]["method"], amountMinor: p.amount_minor })),
  };
  return { ...base, sale, changeMinor: d.change_minor, customerName: d.customer_name, employeeName: d.employee_name };
}

/**
 * Sales and invoices: every invoice the tills issued, when and in which shift, with the shift
 * list beside it. Any invoice can be opened and printed again (marked as a copy).
 */
export function Invoices({ call, storeId, stores }: { call: Call; storeId: string; stores: { id: string; name: string }[] }) {
  const [view, setView] = useState<"invoices" | "shifts">("invoices");
  const [preset, setPreset] = useState("اليوم");
  const [[from, to], setRange] = useState(PRESETS["اليوم"]);
  const [scope, setScope] = useState<"store" | "all">("store");
  const [f, setF] = useState({ shiftId: "", userId: "", kind: "", method: "", q: "" });
  const [list, setList] = useState<List | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const sid = scope === "store" ? storeId : "";

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to, limit: String(limit) });
    if (sid) p.set("storeId", sid);
    for (const [k, v] of Object.entries(f)) if (v.trim()) p.set(k, v.trim());
    return p.toString();
  }, [from, to, sid, f, limit]);

  useEffect(() => {
    setError(null);
    const t = setTimeout(() => void call<List>(`/invoices?${qs}`).then(setList).catch((e) => setError((e as Error).message)), f.q ? 300 : 0);
    return () => clearTimeout(t);
  }, [call, qs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void call<Shift[]>(`/shifts?from=${from}&to=${to}${sid ? `&storeId=${sid}` : ""}`).then(setShifts).catch(() => setShifts([]));
  }, [call, from, to, sid]);

  const cashiers = useMemo(() => [...new Map(shifts.map((s) => [s.user_id, s.cashier])).entries()], [shifts]);
  const pickShift = (id: string) => {
    setF({ ...f, shiftId: id });
    setView("invoices");
  };

  function csv() {
    if (!list) return;
    downloadCsv(`invoices-${from}-${to}`, ["الرقم", "النوع", "التاريخ", "الفرع", "الجهاز", "الكاشير", "الوردية", "العميل", "الأصناف", "الدفع", "الإجمالي"],
      list.rows.map((r) => [r.number, r.kind === "sale" ? "بيع" : "مرتجع", at(r.created_at), r.store_name, r.device_name, r.cashier, shiftLabel(null, r.shift_opened_at, r.shift_closed_at),
        r.customer_name ?? "", r.lines, r.payments.map((p) => PAY[p.method] ?? p.method).join(" + "), (r.total_minor / 1000).toFixed(3)]));
  }

  const sm = list?.summary;
  const chosenShift = shifts.find((s) => s.id === f.shiftId);
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <div className="tabs">
            <button className={view === "invoices" ? "active" : ""} onClick={() => setView("invoices")}>🧾 الفواتير</button>
            <button className={view === "shifts" ? "active" : ""} onClick={() => setView("shifts")}>🕒 الورديات</button>
          </div>
          <span className="spacer" />
          {stores.length > 1 && (
            <div className="seg">
              <button className={scope === "store" ? "active" : ""} onClick={() => setScope("store")}>{stores.find((s) => s.id === storeId)?.name ?? "الفرع"}</button>
              <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>كل الفروع</button>
            </div>
          )}
        </div>
        <div className="row">
          <div className="chips">
            {Object.keys(PRESETS).map((p) => <button key={p} className={preset === p ? "active" : ""} onClick={() => { setPreset(p); setRange(PRESETS[p]()); setF({ ...f, shiftId: "" }); }}>{p}</button>)}
          </div>
          <label className="row" style={{ gap: 4 }}>من<input type="date" value={from} max={to} onChange={(e) => { setPreset(""); setRange([e.target.value, to]); }} style={{ width: 150 }} /></label>
          <label className="row" style={{ gap: 4 }}>إلى<input type="date" value={to} min={from} max={local()} onChange={(e) => { setPreset(""); setRange([from, e.target.value]); }} style={{ width: 150 }} /></label>
        </div>
        {view === "invoices" && (
          <div className="filters">
            <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="🔎 رقم الفاتورة أو اسم العميل" aria-label="بحث" />
            <select value={f.shiftId} onChange={(e) => setF({ ...f, shiftId: e.target.value })} aria-label="الوردية">
              <option value="">كل الورديات</option>
              {shifts.map((s) => <option key={s.id} value={s.id}>{shiftLabel(s.cashier, s.opened_at, s.closed_at)}</option>)}
            </select>
            <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} aria-label="الكاشير">
              <option value="">كل الكاشيرات</option>
              {cashiers.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} aria-label="طريقة الدفع">
              <option value="">كل طرق الدفع</option>
              {Object.entries(PAY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="النوع">
              <option value="">بيع ومرتجع</option>
              <option value="sale">بيع فقط</option>
              <option value="return">مرتجع فقط</option>
            </select>
          </div>
        )}
        {chosenShift && view === "invoices" && (
          <div className="notice row">
            <span>وردية {shiftLabel(chosenShift.cashier, chosenShift.opened_at, chosenShift.closed_at)} · {chosenShift.device_name}</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => setF({ ...f, shiftId: "" })}>✕ كل الورديات</button>
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {view === "invoices" && sm && (
        <div className="kpis">
          <div className="kpi"><small>المبيعات ({sm.sales} فاتورة)</small><b className="num">{formatMoney(sm.salesMinor)}</b></div>
          <div className="kpi"><small>المرتجعات ({sm.returns})</small><b className={`num ${sm.returnsMinor ? "bad" : ""}`}>{formatMoney(sm.returnsMinor)}</b></div>
          <div className="kpi"><small>الصافي</small><b className="num ok">{formatMoney(sm.netMinor)}</b></div>
          <div className="kpi"><small>متوسط الفاتورة</small><b className="num">{formatMoney(sm.sales ? Math.round(sm.salesMinor / sm.sales) : 0)}</b></div>
          <div className="kpi"><small>طرق الدفع</small><span className="num">{Object.entries(sm.byMethod).filter(([, v]) => v).map(([k, v]) => `${PAY[k] ?? k} ${formatMoney(v, "")}`).join(" · ") || "—"}</span></div>
        </div>
      )}

      {view === "invoices" && list && (
        <div className="card stack">
          <div className="row">
            <b>{list.rows.length} فاتورة</b>
            <span className="spacer" />
            <button onClick={csv} disabled={!list.rows.length}>⬇️ Excel (CSV)</button>
          </div>
          {list.rows.length === 0 ? (
            <div className="muted">ما فيش فواتير في هذي الفترة{f.q || f.shiftId || f.userId || f.method || f.kind ? " بهذي الفلاتر" : ""}.</div>
          ) : (
            <div className="table-wrap">
              <table className="invoices">
                <thead>
                  <tr><th>الرقم</th><th>الوقت</th><th>الكاشير / الجهاز</th><th>الوردية</th><th>العميل</th><th>الدفع</th><th>الإجمالي</th></tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpen(r.id)} className={`clickable ${r.kind === "return" ? "is-return" : ""}`} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(r.id)}>
                      <td className="num"><b>{r.number}</b>{r.kind === "return" && <span className="badge bad">مرتجع</span>}{r.returned_minor > 0 && <span className="badge warn" title="عليها مرتجع">↩︎ {formatMoney(r.returned_minor, "")}</span>}</td>
                      <td className="num">{at(r.created_at)}</td>
                      <td>{r.cashier}<small className="muted"> · {r.device_name}{scope === "all" ? ` · ${r.store_name}` : ""}</small></td>
                      <td><small>{r.shift_opened_at ? `${time(r.shift_opened_at)} ← ${r.shift_closed_at ? time(r.shift_closed_at) : "مفتوحة"}` : "—"}</small></td>
                      <td>{r.customer_name ?? r.employee_name ?? <span className="muted">—</span>}</td>
                      <td><small>{r.payments.map((p) => PAY[p.method] ?? p.method).join(" + ")}</small></td>
                      <td className="num"><b>{formatMoney(r.total_minor)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.rows.length >= limit && <button onClick={() => setLimit(limit + 200)}>عرض المزيد</button>}
        </div>
      )}
      {view === "invoices" && !list && !error && <div className="muted">جاري التحميل…</div>}

      {view === "shifts" && (
        <div className="card stack">
          <b>{shifts.length} وردية</b>
          {shifts.length === 0 ? <div className="muted">ما فيش ورديات في هذي الفترة.</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>الكاشير</th><th>الجهاز</th><th>فتحت</th><th>قفلت</th><th>الفواتير</th><th>المبيعات</th><th>المرتجعات</th><th>كاش البداية</th><th>فرق الدرج</th><th /></tr></thead>
                <tbody>
                  {shifts.map((s) => (
                    <tr key={s.id}>
                      <td>{s.cashier}</td>
                      <td>{s.device_name}{scope === "all" && <small className="muted"> · {s.store_name}</small>}</td>
                      <td className="num">{at(s.opened_at)}</td>
                      <td className="num">{s.closed_at ? at(s.closed_at) : <span className="badge ok">مفتوحة</span>}</td>
                      <td className="num">{s.sales}</td>
                      <td className="num">{formatMoney(s.sales_minor)}</td>
                      <td className="num">{s.returns_minor ? formatMoney(s.returns_minor) : "—"}</td>
                      <td className="num">{formatMoney(s.opening_cash_minor)}</td>
                      <td className="num">{s.difference_minor === null ? "—" : <span className={s.difference_minor === 0 ? "badge ok" : s.difference_minor < 0 ? "badge bad" : "badge warn"}>{s.difference_minor > 0 ? "+" : ""}{formatMoney(s.difference_minor)}</span>}</td>
                      <td><button onClick={() => pickShift(s.id)}>فواتيرها</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {open && <InvoiceDetail call={call} id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </div>
  );
}

function InvoiceDetail({ call, id, onClose, onOpen }: { call: Call; id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [shop, setShop] = useState<{ name: string; settings: ShopSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paper, setPaper] = useState<ReceiptData | null>(null);
  useEffect(() => {
    setD(null);
    void call<Detail>(`/invoices/${id}`).then(setD).catch((e) => setError((e as Error).message));
    void call<{ name: string; settings: unknown }>("/settings").then((s) => setShop({ name: s.name, settings: readShopSettings(s.settings) })).catch(() => undefined);
  }, [call, id]);

  async function reprint() {
    if (!d) return;
    const r = receiptFromDetail(d, shop ?? { name: d.store_name, settings: readShopSettings({}) });
    setPaper(r);
    // Let the page render the paper first: the browser's print dialog prints that.
    await new Promise((ok) => setTimeout(ok, 60));
    try {
      await printReceipt(r);
    } catch (e) {
      setError(`الطابعة ما ردتش: ${(e as Error).message ?? e}`);
    }
  }

  const ret = d?.kind === "return";
  return (
    <Modal title={d ? `${ret ? "مرتجع" : "فاتورة"} ${d.number}` : "الفاتورة"} onClose={onClose}>
      {error && <div className="error">{error}</div>}
      {!d && !error && <div className="muted">جاري التحميل…</div>}
      {d && (
        <div className="stack invoice-detail">
          <div className="meta-grid">
            <div><small>التاريخ والوقت</small><b className="num">{at(d.created_at)}</b></div>
            <div><small>الوردية</small><b>{shiftLabel(d.shift_cashier, d.shift_opened_at, d.shift_closed_at)}</b></div>
            <div><small>الكاشير</small><b>{d.cashier}</b></div>
            <div><small>الجهاز / الفرع</small><b>{d.device_name} · {d.store_name}</b></div>
            {d.customer_name && <div><small>العميل</small><b>{d.customer_name}</b></div>}
            {d.employee_name && <div><small>على راتب</small><b>{d.employee_name}</b></div>}
            {ret && <div><small>عن الفاتورة</small><b>{d.original_sale_id ? <a href="#" onClick={(e) => { e.preventDefault(); onOpen(d.original_sale_id!); }}>{d.original_number}</a> : d.original_number}</b></div>}
            {ret && d.reason && <div><small>السبب</small><b>{d.reason}</b></div>}
            {ret && d.approved_by_name && <div><small>وافق عليه</small><b>{d.approved_by_name}</b></div>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th></tr></thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}{l.offer_name && <small className="muted"> · 🎁 {l.offer_name}</small>}</td>
                    <td className="num">{formatQty(Math.abs(l.qty_milli), l.qty_milli % 1000 !== 0)}</td>
                    <td className="num">{formatMoney(l.price_minor, "")}</td>
                    <td className="num">{l.discount_minor ? formatMoney(l.discount_minor, "") : "—"}</td>
                    <td className="num">{formatMoney(Math.abs(l.total_minor), "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="totals-box">
            {!ret && d.discount_minor > 0 && <div className="line"><span>الخصم</span><span className="num">{formatMoney(d.discount_minor)}</span></div>}
            {d.tax_minor !== 0 && <div className="line"><span>منها ضريبة</span><span className="num">{formatMoney(Math.abs(d.tax_minor))}</span></div>}
            <div className="line big"><span>{ret ? "المبلغ المرجع" : "الإجمالي"}</span><span className="num">{formatMoney(Math.abs(d.total_minor))}</span></div>
            {d.payments.map((p, i) => <div key={i} className="line"><span>{PAY[p.method] ?? p.method}</span><span className="num">{formatMoney(Math.abs(p.amount_minor))}</span></div>)}
            {d.change_minor > 0 && <div className="line"><span>الباقي</span><span className="num">{formatMoney(d.change_minor)}</span></div>}
          </div>
          {d.returns.length > 0 && (
            <div className="notice stack">
              <b>عليها مرتجع</b>
              {d.returns.map((r) => (
                <div key={r.id} className="row">
                  <a href="#" onClick={(e) => { e.preventDefault(); onOpen(r.id); }}>{r.number}</a>
                  <span className="num muted">{at(r.created_at)}</span>
                  <span className="spacer" />
                  <span className="num">{formatMoney(r.amount_minor)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <span className="muted">{d.received_at ? `وصلت للسيرفر ${at(d.received_at)}` : ""}</span>
            <span className="spacer" />
            <button onClick={onClose}>إغلاق</button>
            <button onClick={() => {
              const phone = d.customer_phone ?? prompt("رقم واتساب الزبون (اتركه فاضي وتختار المحادثة من الواتساب)", "") ?? null;
              if (phone === null && !d.customer_phone) return;
              sendInvoice({ shopName: shop?.name ?? d.store_name, settings: shop?.settings, saleId: d.id, number: d.number, totalMinor: Math.abs(d.total_minor), phone });
            }}>📲 واتساب</button>
            <button className="primary" onClick={() => void reprint()}>🖨️ طباعة الفاتورة</button>
          </div>
        </div>
      )}
      <Receipt data={paper} />
    </Modal>
  );
}
