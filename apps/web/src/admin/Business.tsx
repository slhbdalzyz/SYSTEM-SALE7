import { Fragment, useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogCustomer, type CatalogProduct, type InstallmentRow } from "@pos/shared";
import { printQuote, quoteText } from "../printDoc";
import { sendText } from "../whatsapp";
import type { Quote, Kit } from "../pos/business";
import type { Call } from "./Admin";

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB") : "");
const dmy = (d: string | null | undefined) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "");
const money = (s: string) => toMinor(Number(s.replace(",", ".")) || 0);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
const errOf = (e: unknown) => (e as Error).message ?? String(e);

// ---- Quotes ----

const QUOTE_STATUS = { open: "مفتوح", sold: "✓ انباع", cancelled: "ملغي" } as Record<string, string>;

/** Every price quote given: printed again, sent on WhatsApp, or cancelled. The till sells one by its number. */
export function Quotes({ call, shopName }: { call: Call; shopName: string }) {
  const [rows, setRows] = useState<Quote[]>([]);
  const [status, setStatus] = useState<"open" | "sold" | "cancelled" | "all">("open");
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => call<Quote[]>(`/quotes?status=${status}`).then(setRows).catch((e) => setMsg(errOf(e)));
  useEffect(() => void load(), [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = today();
  const openTotal = rows.filter((q) => q.status === "open").reduce((a, q) => a + q.totalMinor, 0);

  return (
    <div className="stack">
      <div className="row">
        <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">المفتوحة</option><option value="sold">اللي انباعت</option><option value="cancelled">الملغية</option><option value="all">الكل</option>
        </select>
        {status === "open" && <span className="muted">قيمة العروض المفتوحة: <b className="num">{formatMoney(openTotal)}</b></span>}
      </div>
      {msg && <div className="error">{msg}</div>}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>ما فيش عروض هنا. العرض يتعمل من الكاشير: حط الأصناف واضغط «📄 عرض سعر».</div> : (
          <table>
            <thead><tr><th>#</th><th>التاريخ</th><th>الزبون</th><th>المشروع</th><th>الإجمالي</th><th>الحالة</th><th /></tr></thead>
            <tbody>
              {rows.map((q) => {
                const expired = q.status === "open" && !!q.validUntil && q.validUntil.slice(0, 10) < t;
                return (
                  <Fragment key={q.id}>
                    <tr onClick={() => setOpen(open === q.id ? null : q.id)} style={{ cursor: "pointer" }}>
                      <td className="num">{q.number}</td>
                      <td className="num">{day(q.createdAt)}</td>
                      <td>{q.customerName ?? "—"}{q.phone && <div className="muted small num">{q.phone}</div>}</td>
                      <td>{q.project ?? ""}</td>
                      <td className="num">{formatMoney(q.totalMinor)}</td>
                      <td>{expired ? <span className="badge bad">انتهت صلاحيته</span> : QUOTE_STATUS[q.status]}{q.saleNumber && <div className="muted small num">{q.saleNumber}</div>}</td>
                      <td>{open === q.id ? "▲" : "▼"}</td>
                    </tr>
                    {open === q.id && (
                      <tr key={`${q.id}-d`}>
                        <td colSpan={7}>
                          <div className="stack">
                            <div className="muted small">{q.lines.map((l) => `${l.name} × ${formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}`).join("، ")}</div>
                            {q.validUntil && <div className="muted small">صالح حتى {dmy(q.validUntil)}{q.note ? ` · ${q.note}` : ""}</div>}
                            <div className="row">
                              <button onClick={() => printQuote(q, { name: shopName })}>🖨️ اطبع</button>
                              <button onClick={() => sendText(q.phone, quoteText(q, shopName))}>📲 واتساب</button>
                              <span className="spacer" />
                              {q.status === "open" && <button className="danger" onClick={async () => { if (!confirm(`نلغي عرض السعر ${q.number}؟`)) return; await call(`/quotes/${q.id}`, { method: "PATCH", body: { status: "cancelled" } }); await load(); }}>إلغاء العرض</button>}
                              {q.status === "cancelled" && <button onClick={async () => { await call(`/quotes/${q.id}`, { method: "PATCH", body: { status: "open" } }); await load(); }}>رجّعه مفتوح</button>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="hint">لما يرجع الزبون يشتري، الكاشير يفتح العرض برقمه ويبيعه بنفس الأسعار، والعرض يتعلم «انباع» برقم الفاتورة.</div>
    </div>
  );
}

// ---- Instalments ----

interface Plan {
  id: string; customerId: string; customerName: string; customerPhone: string | null; balanceMinor: number; title: string; saleNumber: string | null;
  totalMinor: number; downMinor: number; count: number; note: string | null; status: "active" | "done" | "cancelled"; createdAt: string; paidMinor: number;
  rows: InstallmentRow[]; eachMinor: number; lateMinor: number; remainingMinor: number; next: InstallmentRow | null;
}
const STATE = { paid: "✓ مدفوع", part: "جزء", late: "⚠️ متأخر", due: "قادم" } as const;

/**
 * Goods sold on monthly payments. Whatever the customer pays on their account (at the till or here
 * under customers) covers the payments in order, so there is one place to take money.
 */
export function Installments({ call, shopName }: { call: Call; shopName: string }) {
  const [rows, setRows] = useState<Plan[]>([]);
  const [status, setStatus] = useState<"active" | "done" | "all">("active");
  const [customers, setCustomers] = useState<CatalogCustomer[]>([]);
  const [form, setForm] = useState<{ customerId: string; title: string; saleNumber: string; total: string; down: string; count: string; firstDue: string; note: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => call<Plan[]>(`/installments?status=${status}`).then(setRows);
  useEffect(() => void load(), [status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void call<CatalogCustomer[]>("/customers").then(setCustomers), [call]);
  const late = rows.filter((p) => p.lateMinor > 0);

  async function create() {
    if (!form) return;
    setMsg(null);
    try {
      await call("/installments", { body: { customerId: form.customerId, title: form.title.trim(), saleNumber: form.saleNumber.trim() || null, totalMinor: money(form.total), downMinor: money(form.down), count: Number(form.count) || 1, firstDue: form.firstDue, note: form.note.trim() || null } });
      setForm(null);
      setMsg({ text: "تم إضافة خطة الأقساط" });
      await load();
    } catch (e) { setMsg({ text: errOf(e), bad: true }); }
  }

  const remind = (p: Plan) => sendText(p.customerPhone, `السلام عليكم ${p.customerName}، تذكير من ${shopName}: قسط «${p.title}»${p.lateMinor > 0 ? ` المتأخر ${formatMoney(p.lateMinor)}` : p.next ? ` القادم ${formatMoney(p.next.amountMinor - p.next.paidMinor)} بتاريخ ${dmy(p.next.due)}` : ""}. الباقي الكلي ${formatMoney(p.remainingMinor)}. شكراً.`);
  const f = form;
  const preview = f && money(f.total) > money(f.down) && Number(f.count) > 0 ? (money(f.total) - money(f.down)) / Number(f.count) : 0;

  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><span>خطط شغالة</span><b className="num">{rows.filter((p) => p.status === "active").length}</b></div>
        <div className="kpi"><span>الباقي على الزبائن</span><b className="num">{formatMoney(rows.reduce((a, p) => a + p.remainingMinor, 0))}</b></div>
        <div className="kpi"><span>متأخر ({late.length})</span><b className={`num ${late.length ? "bad" : ""}`}>{formatMoney(late.reduce((a, p) => a + p.lateMinor, 0))}</b></div>
      </div>
      {msg && <div className={msg.bad ? "error" : "hint"}>{msg.text}</div>}
      {!f ? (
        <div className="row">
          <button className="primary" onClick={() => setForm({ customerId: "", title: "", saleNumber: "", total: "", down: "", count: "6", firstDue: today(), note: "" })}>+ بيع بالتقسيط</button>
          <select style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">الشغالة</option><option value="done">المنتهية</option><option value="all">الكل</option>
          </select>
        </div>
      ) : (
        <div className="card stack">
          <h3>بيع بالتقسيط</h3>
          <div className="hint">بيع البضاعة من الكاشير «آجل» على حساب الزبون كالعادة، وبعدين سجّل هنا كيف بيسدد.</div>
          <div className="row">
            <label style={{ flex: 1, minWidth: 180 }}>الزبون
              <select value={f.customerId} onChange={(e) => setForm({ ...f, customerId: e.target.value })}>
                <option value="">— اختار —</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ""}</option>)}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 180 }}>البضاعة<input value={f.title} onChange={(e) => setForm({ ...f, title: e.target.value })} placeholder="مثلاً: غرفة نوم + ثلاجة" /></label>
            <label style={{ width: 140 }}>رقم الفاتورة<input className="num" value={f.saleNumber} onChange={(e) => setForm({ ...f, saleNumber: e.target.value })} /></label>
          </div>
          <div className="row">
            <label style={{ width: 140 }}>المبلغ الكامل<input className="num" value={f.total} onChange={(e) => setForm({ ...f, total: e.target.value })} /></label>
            <label style={{ width: 140 }}>المقدم<input className="num" value={f.down} onChange={(e) => setForm({ ...f, down: e.target.value })} placeholder="0" /></label>
            <label style={{ width: 120 }}>عدد الأقساط<input className="num" value={f.count} onChange={(e) => setForm({ ...f, count: e.target.value.replace(/\D/g, "") })} /></label>
            <label style={{ width: 170 }}>أول قسط<input type="date" value={f.firstDue} onChange={(e) => setForm({ ...f, firstDue: e.target.value })} /></label>
            {preview > 0 && <span className="muted">القسط تقريباً <b className="num">{formatMoney(Math.round(preview))}</b> كل شهر</span>}
          </div>
          <label>ملاحظة (الضامن، الصكوك…)<input value={f.note} onChange={(e) => setForm({ ...f, note: e.target.value })} /></label>
          <div className="row">
            <button className="primary" disabled={!f.customerId || f.title.trim().length < 2 || money(f.total) <= 0 || !f.firstDue} onClick={() => void create()}>حفظ</button>
            <button className="ghost" onClick={() => setForm(null)}>إلغاء</button>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>ما فيش خطط أقساط هنا.</div> : (
          <table>
            <thead><tr><th>الزبون</th><th>البضاعة</th><th>القسط</th><th>المدفوع</th><th>الباقي</th><th>القادم</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <Fragment key={p.id}>
                  <tr onClick={() => setOpen(open === p.id ? null : p.id)} style={{ cursor: "pointer" }}>
                    <td>{p.customerName}{p.customerPhone && <div className="muted small num">{p.customerPhone}</div>}</td>
                    <td>{p.title}{p.saleNumber && <div className="muted small num">{p.saleNumber}</div>}</td>
                    <td className="num">{formatMoney(p.eachMinor)} × {p.count}</td>
                    <td className="num">{formatMoney(p.paidMinor + p.downMinor)}</td>
                    <td className="num">{formatMoney(p.remainingMinor)}</td>
                    <td>{p.lateMinor > 0 ? <span className="badge bad">متأخر {formatMoney(p.lateMinor)}</span> : p.next ? <span className="num">{dmy(p.next.due)}</span> : "✓ خلص"}</td>
                    <td>{open === p.id ? "▲" : "▼"}</td>
                  </tr>
                  {open === p.id && (
                    <tr key={`${p.id}-d`}>
                      <td colSpan={7}>
                        <div className="stack">
                          <table>
                            <thead><tr><th>#</th><th>التاريخ</th><th>المبلغ</th><th>المدفوع</th><th>الحالة</th></tr></thead>
                            <tbody>{p.rows.map((r) => <tr key={r.n}><td className="num">{r.n}</td><td className="num">{dmy(r.due)}</td><td className="num">{formatMoney(r.amountMinor)}</td><td className="num">{formatMoney(r.paidMinor)}</td><td>{STATE[r.state]}</td></tr>)}</tbody>
                          </table>
                          {p.note && <div className="muted small">{p.note}</div>}
                          <div className="row">
                            <button onClick={() => remind(p)}>📲 ذكّره بالواتساب</button>
                            <span className="muted small">الزبون يسدد من الكاشير (F3 ← تسديد) أو من «العملاء والديون».</span>
                            <span className="spacer" />
                            {p.status === "active" && <button onClick={async () => { await call(`/installments/${p.id}`, { method: "PATCH", body: { status: "done" } }); await load(); }}>✓ خلصت</button>}
                            {p.status === "active" && <button className="danger" onClick={async () => { if (!confirm("نلغي خطة الأقساط هذي؟ الدين يبقى على حساب الزبون.")) return; await call(`/installments/${p.id}`, { method: "PATCH", body: { status: "cancelled" } }); await load(); }}>إلغاء</button>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Deliveries ----

interface Delivery {
  id: string; number: string; totalMinor: number; creditMinor: number; createdAt: string; project: string | null; customerName: string | null; customerPhone: string | null; storeName: string | null; items: number;
  delivery: { address: string; phone?: string; note?: string; status: "pending" | "out" | "delivered"; driver?: string };
}
const D_STATUS = { pending: "⏳ ينتظر", out: "🚚 في الطريق", delivered: "✓ وصل" } as const;

/** Bills to be taken to the customer: waiting, on the way, delivered, and who took them. */
export function Deliveries({ call }: { call: Call }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [status, setStatus] = useState<"pending" | "out" | "delivered" | "all">("pending");
  const [drivers, setDrivers] = useState<Record<string, string>>({});
  const load = () => call<Delivery[]>(`/deliveries?status=${status}`).then(setRows);
  useEffect(() => void load(), [status]); // eslint-disable-line react-hooks/exhaustive-deps
  async function move(d: Delivery, s: Delivery["delivery"]["status"]) {
    await call(`/deliveries/${d.id}`, { method: "PATCH", body: { status: s, ...(drivers[d.id] !== undefined ? { driver: drivers[d.id] } : {}) } });
    await load();
  }
  return (
    <div className="stack">
      <div className="seg" role="tablist">
        {(["pending", "out", "delivered", "all"] as const).map((s) => <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>{s === "all" ? "الكل" : D_STATUS[s]}</button>)}
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        {rows.length === 0 ? <div className="muted" style={{ padding: 12 }}>ما فيش توصيلات هنا. في الكاشير: «🏗️ مشروع / 🚚 توصيل» قبل الدفع.</div> : (
          <table>
            <thead><tr><th>الفاتورة</th><th>الزبون والعنوان</th><th>المبلغ</th><th>السائق</th><th>الحالة</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="num">{d.number}<div className="muted small">{day(d.createdAt)} · {d.items} أصناف</div></td>
                  <td>{d.customerName ?? "زبون"} {d.project && <span className="muted">· 🏗️ {d.project}</span>}<div>📍 {d.delivery.address}</div>
                    {(d.delivery.phone || d.customerPhone) && <div className="muted small num">📞 {d.delivery.phone || d.customerPhone}</div>}
                    {d.delivery.note && <div className="muted small">{d.delivery.note}</div>}</td>
                  <td className="num">{formatMoney(d.totalMinor)}{d.creditMinor > 0 && <div className="muted small">آجل {formatMoney(d.creditMinor)}</div>}</td>
                  <td><input style={{ width: 120 }} value={drivers[d.id] ?? d.delivery.driver ?? ""} onChange={(e) => setDrivers({ ...drivers, [d.id]: e.target.value })} placeholder="اسم السائق" /></td>
                  <td>
                    <div>{D_STATUS[d.delivery.status]}</div>
                    <div className="row">
                      {d.delivery.status === "pending" && <button className="primary" onClick={() => void move(d, "out")}>🚚 طلع</button>}
                      {d.delivery.status !== "delivered" && <button onClick={() => void move(d, "delivered")}>✓ وصل</button>}
                      {d.delivery.status !== "pending" && <button className="ghost" onClick={() => void move(d, "pending")}>رجّعه</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Ready-made lists ----

/** A school list, a bathroom set, a gift box: put on the bill in one go from the till. */
export function Kits({ call, storeId, type }: { call: Call; storeId: string; type: string }) {
  const [kits, setKits] = useState<Kit[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [edit, setEdit] = useState<{ id?: string; name: string; lines: { productId: string; unitId: string; qty: string }[] } | null>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => call<Kit[]>("/kits").then(setKits);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then(setProducts), [call, storeId]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const found = q.trim().length >= 2 ? products.filter((p) => p.active && p.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const example = type === "stationery" ? "قائمة الصف الأول" : type === "perfume" ? "بوكس هدية رجالي" : type === "building" ? "طقم حمام كامل" : type === "bakery" ? "صينية مناسبات" : "طقم";
  const total = edit ? edit.lines.reduce((a, l) => { const u = byId.get(l.productId)?.units.find((x) => x.id === l.unitId); return a + (u ? Math.round(u.priceMinor * (Number(l.qty) || 0)) : 0); }, 0) : 0;

  async function save() {
    if (!edit) return;
    setMsg(null);
    try {
      const body = { name: edit.name.trim(), lines: edit.lines.map((l) => ({ productId: l.productId, unitId: l.unitId, qtyMilli: toMinor(Number(l.qty) || 1) })) };
      await call(edit.id ? `/kits/${edit.id}` : "/kits", { method: edit.id ? "PUT" : "POST", body });
      setEdit(null);
      setMsg({ text: "تم الحفظ. تطلع في الكاشير تحت «🎒 قائمة جاهزة»" });
      await load();
    } catch (e) { setMsg({ text: errOf(e), bad: true }); }
  }

  if (edit) {
    return (
      <div className="card stack">
        <label>اسم القائمة<input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={`مثلاً: ${example}`} /></label>
        <label>زيد صنف<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="اكتب اسم الصنف" /></label>
        {found.length > 0 && (
          <div className="chips">
            {found.map((p) => {
              const u = p.units.find((x) => x.isBase) ?? p.units[0];
              return <button key={p.id} onClick={() => { setEdit({ ...edit, lines: [...edit.lines, { productId: p.id, unitId: u.id, qty: "1" }] }); setQ(""); }}>+ {p.name}</button>;
            })}
          </div>
        )}
        <table>
          <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th /></tr></thead>
          <tbody>
            {edit.lines.map((l, i) => {
              const p = byId.get(l.productId);
              const u = p?.units.find((x) => x.id === l.unitId);
              const set = (patch: Partial<typeof l>) => setEdit({ ...edit, lines: edit.lines.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <tr key={i}>
                  <td>{p?.name ?? "؟"}</td>
                  <td>{p && p.units.length > 1 ? <select value={l.unitId} onChange={(e) => set({ unitId: e.target.value })}>{p.units.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : u?.name}</td>
                  <td><input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                  <td className="num">{u ? formatMoney(Math.round(u.priceMinor * (Number(l.qty) || 0))) : ""}</td>
                  <td><button className="danger" onClick={() => setEdit({ ...edit, lines: edit.lines.filter((_, j) => j !== i) })}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row"><b>الإجمالي بالأسعار الحالية</b><span className="spacer" /><b className="num">{formatMoney(total)}</b></div>
        {msg?.bad && <div className="error">{msg.text}</div>}
        <div className="row">
          {edit.id && <button className="danger" onClick={async () => { if (!confirm("نحذف القائمة؟")) return; await call(`/kits/${edit.id}`, { method: "DELETE" }); setEdit(null); await load(); }}>حذف</button>}
          <span className="spacer" />
          <button onClick={() => setEdit(null)}>إلغاء</button>
          <button className="primary" disabled={edit.name.trim().length < 2 || !edit.lines.length} onClick={() => void save()}>حفظ</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {msg && <div className={msg.bad ? "error" : "hint"}>{msg.text}</div>}
      <div className="row"><button className="primary" onClick={() => setEdit({ name: "", lines: [] })}>+ قائمة جديدة</button></div>
      {kits.length === 0 ? <div className="card muted">ما فيش قوائم. مثلاً «{example}»: تحط أصنافها مرة وحدة، والكاشير يزيدها كلها بضغطة.</div> : (
        <div className="kit-grid">
          {kits.map((k) => (
            <button key={k.id} className="kit-card card" onClick={() => setEdit({ id: k.id, name: k.name, lines: k.items.map((i) => ({ productId: i.productId, unitId: i.unitId, qty: String(i.qtyMilli / 1000) })) })}>
              <b>{k.name}</b>
              <span className="muted">{k.items.length} أصناف · <span className="num">{formatMoney(k.items.reduce((a, i) => a + Math.round((i.qtyMilli * i.priceMinor) / 1000), 0))}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
