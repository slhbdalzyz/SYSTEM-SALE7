import { useEffect, useMemo, useState } from "react";
import {
  REPAIR_NEXT, REPAIR_STATUS_LABELS, formatMoney, looksLikeBadImei, parseSerials, repairDue, repairReadyMessage, toMinor, waLink, warrantyLabel, warrantyState,
  type CatalogProduct, type RepairStatus,
} from "@pos/shared";
import type { Call } from "./Admin";

export interface Repair {
  id: string; number: number; storeId: string | null; storeName: string | null; customerName: string; phone: string | null; device: string; serial: string | null;
  problem: string; accessories: string | null; estimateMinor: number; depositMinor: number; finalMinor: number | null; status: RepairStatus;
  notes: string | null; technician: string | null; createdAt: string; readyAt: string | null; deliveredAt: string | null;
  kind?: "repair" | "order"; dueAt?: string | null;
}
interface Stats { inShop: number; ready: number; monthMinor: number; monthCount: number; depositsMinor: number; dueSoon?: number }

/** The same screen serves repairs and orders taken ahead (a cake, a suit, a part to bring in); only the words change. */
const WORDS = {
  repair: {
    add: "📥 استلام جهاز للصيانة", customer: "اسم الزبون", item: "الجهاز", itemPh: "مثلاً: آيفون 11 أسود", detail: "العطل كما قاله الزبون", detailPh: "الشاشة مكسورة، ما يشحنش…",
    ticket: "إيصال صيانة", inShop: "في الورشة", ready: "جاهز ينتظر صاحبه", month: "صيانة هذا الشهر", none: "أجهزة", who: "الفني", search: "اسم، تلفون، رقم إيصال أو IMEI",
    head: "الجهاز والعطل", save: "حفظ وطباعة الإيصال", notesPh: "ملاحظات الفني (القطعة اللي تبدلت…)", working: REPAIR_STATUS_LABELS.working, waiting: REPAIR_STATUS_LABELS.waiting_parts,
    keep: "احتفظ بالإيصال هذا لاستلام جهازك. المحل مش مسؤول عن الأجهزة اللي ما تتسلمش خلال 90 يوم.",
    hint: "لما تحط الجهاز «جاهز»، يفتحلك الواتساب برسالة للزبون. فلوس الصيانة متسجلة هنا في الإيصال، وما تدخلش في الكاشير ولا في تقرير المبيعات.",
  },
  order: {
    add: "📝 طلبية جديدة", customer: "اسم الزبون", item: "الطلب", itemPh: "مثلاً: تورتة عيد ميلاد 2 كيلو، بدلة، قطعة غيار", detail: "التفاصيل", detailPh: "الشكل، اللون، الكتابة، المقاس، رقم القطعة…",
    ticket: "إيصال طلبية", inShop: "تحت التجهيز", ready: "جاهزة تنتظر صاحبها", month: "طلبيات هذا الشهر", none: "طلبيات", who: "المسؤول", search: "اسم، تلفون أو رقم الطلبية",
    head: "الطلب", save: "حفظ وطباعة الإيصال", notesPh: "ملاحظات (اتصلنا بالزبون، تأخر المورد…)", working: "🛠️ قيد التجهيز", waiting: "⏳ تنتظر مواد",
    keep: "احتفظ بالإيصال هذا لاستلام طلبيتك. العربون ما يرجعش بعد ما نبدو في التجهيز.",
    hint: "لما تحط الطلبية «جاهزة»، يفتحلك الواتساب برسالة للزبون. الطلبيات اللي موعدها قريب تطلع فوق.",
  },
};
type Kind = keyof typeof WORDS;
const statusLabel = (s: RepairStatus, kind: Kind) => (s === "working" ? WORDS[kind].working : s === "waiting_parts" ? WORDS[kind].waiting : REPAIR_STATUS_LABELS[s]);
/** A date and time from the form, as the server takes it. */
const isoOf = (local: string) => (local ? new Date(local).toISOString() : null);
const localOf = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
interface Piece {
  id: string; serial: string; status: "in_stock" | "sold"; note: string | null; product: string; warrantyMonths: number; receivedAt: string; soldAt: string | null;
  warrantyUntil: string | null; storeName: string | null; returnedAt: string | null;
  sale: { number: string; priceMinor: number | null; customerName: string | null; customerPhone: string | null; cashier: string | null } | null;
}
interface Summary { id: string; name: string; warrantyMonths: number; inStock: number; sold: number; stockMilli: number }

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB") : "");
const dmy = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli" }).format(new Date());
const money = (s: string) => toMinor(Number(s.replace(",", ".")) || 0);

/** An electronics or phone shop's own screen: devices in for repair, a phone's history by its IMEI, and the numbers in stock. */
export function Electronics({ call, storeId, shopName }: { call: Call; storeId: string; shopName: string }) {
  const [tab, setTab] = useState<"repairs" | "lookup" | "serials">("repairs");
  return (
    <div className="stack">
      <div className="seg" role="tablist">
        <button className={tab === "repairs" ? "active" : ""} onClick={() => setTab("repairs")}>🔧 الصيانة</button>
        <button className={tab === "lookup" ? "active" : ""} onClick={() => setTab("lookup")}>🔎 بحث برقم الجهاز</button>
        <button className={tab === "serials" ? "active" : ""} onClick={() => setTab("serials")}>📥 أرقام الأجهزة في المخزن</button>
      </div>
      {tab === "repairs" && <Repairs call={call} storeId={storeId} shopName={shopName} />}
      {tab === "lookup" && <Lookup call={call} />}
      {tab === "serials" && <Serials call={call} storeId={storeId} />}
    </div>
  );
}

// ---- Repairs ----

const EMPTY = { customerName: "", phone: "", device: "", serial: "", problem: "", accessories: "", estimate: "", deposit: "", technician: "", dueAt: "" };

export function Repairs({ call, storeId, shopName, kind = "repair" }: { call: Call; storeId: string; shopName: string; kind?: Kind }) {
  const W = WORDS[kind];
  const [rows, setRows] = useState<Repair[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<"open" | "all" | "delivered">("open");
  const [q, setQ] = useState("");
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = () => call<{ rows: Repair[]; stats: Stats }>(`/repairs?kind=${kind}&status=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => { setRows(r.rows); setStats(r.stats); });
  useEffect(() => void load(), [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (!form) return;
    setMsg(null);
    try {
      const r = await call<Repair>("/repairs", {
        body: {
          kind, dueAt: isoOf(form.dueAt), storeId, customerName: form.customerName, phone: form.phone || null, device: form.device, serial: form.serial || null, problem: form.problem,
          accessories: form.accessories || null, estimateMinor: money(form.estimate), depositMinor: money(form.deposit), technician: form.technician || null,
        },
      });
      setForm(null);
      setMsg({ text: `انفتح ${W.ticket} رقم ${r.number}` });
      printTicket(r, shopName);
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function update(r: Repair, body: Record<string, unknown>) {
    setMsg(null);
    try {
      const next = await call<Repair>(`/repairs/${r.id}`, { method: "PATCH", body });
      if (body.status === "ready" && next.phone) window.open(waLink(next.phone, readyText(next, shopName)), "_blank");
      await load();
      return next;
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  const f = form;
  return (
    <>
      {stats && (
        <div className="kpis">
          <div className="kpi"><span>{W.inShop}</span><b className="num">{stats.inShop}</b></div>
          <div className="kpi"><span>{W.ready}</span><b className="num">{stats.ready}</b></div>
          {kind === "order" && <div className="kpi"><span>موعدها اليوم أو بكرة</span><b className="num">{stats.dueSoon ?? 0}</b></div>}
          <div className="kpi"><span>عرابين عندك</span><b className="num">{formatMoney(stats.depositsMinor)}</b></div>
          <div className="kpi"><span>{W.month} ({stats.monthCount})</span><b className="num">{formatMoney(stats.monthMinor)}</b></div>
        </div>
      )}
      {msg && <div className={msg.bad ? "error" : "hint"}>{msg.text}</div>}
      {!f ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button className="primary" onClick={() => setForm({ ...EMPTY })}>{W.add}</button>
          <form style={{ display: "flex", gap: 6, flex: 1, minWidth: 260 }} onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <input style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={W.search} />
            <button type="submit">بحث</button>
          </form>
          <select style={{ width: "auto" }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">اللي في المحل</option>
            <option value="delivered">اللي تسلموا</option>
            <option value="all">الكل</option>
          </select>
        </div>
      ) : (
        <div className="card stack">
          <h3>{W.add}</h3>
          <div className="row">
            <label style={{ flex: 1, minWidth: 160 }}>اسم الزبون<input value={f.customerName} onChange={(e) => setForm({ ...f, customerName: e.target.value })} autoFocus /></label>
            <label style={{ flex: 1, minWidth: 140 }}>تلفونه (للواتساب)<input className="num" value={f.phone} onChange={(e) => setForm({ ...f, phone: e.target.value })} placeholder="09xxxxxxxx" /></label>
          </div>
          <div className="row">
            <label style={{ flex: 1, minWidth: 160 }}>{W.item}<input value={f.device} onChange={(e) => setForm({ ...f, device: e.target.value })} placeholder={W.itemPh} /></label>
            {kind === "repair"
              ? <label style={{ flex: 1, minWidth: 160 }}>IMEI أو الرقم التسلسلي<input className="num" value={f.serial} onChange={(e) => setForm({ ...f, serial: e.target.value })} /></label>
              : <label style={{ flex: 1, minWidth: 160 }}>موعد التسليم<input type="datetime-local" value={f.dueAt} onChange={(e) => setForm({ ...f, dueAt: e.target.value })} /></label>}
          </div>
          {f.serial && looksLikeBadImei(f.serial) && <div className="hint">⚠️ الرقم هذا مش IMEI صحيح، تأكد منه (اطلب *#06# من الجهاز).</div>}
          <label>{W.detail}<textarea rows={2} value={f.problem} onChange={(e) => setForm({ ...f, problem: e.target.value })} placeholder={W.detailPh} /></label>
          <div className="row">
            {kind === "repair" && <label style={{ flex: 2, minWidth: 180 }}>استلمنا معاه<input value={f.accessories} onChange={(e) => setForm({ ...f, accessories: e.target.value })} placeholder="شاحن، جراب، شريحة…" /></label>}
            <label style={{ flex: 1, minWidth: 120 }}>{W.who}<input value={f.technician} onChange={(e) => setForm({ ...f, technician: e.target.value })} /></label>
          </div>
          <div className="row">
            <label style={{ width: 150 }}>السعر المتفق عليه<input className="num" value={f.estimate} onChange={(e) => setForm({ ...f, estimate: e.target.value })} placeholder="0" /></label>
            <label style={{ width: 150 }}>العربون المدفوع<input className="num" value={f.deposit} onChange={(e) => setForm({ ...f, deposit: e.target.value })} placeholder="0" /></label>
            {money(f.estimate) > 0 && <span className="muted">يبقى عليه {formatMoney(Math.max(0, money(f.estimate) - money(f.deposit)))}</span>}
          </div>
          <div className="row">
            <button className="primary" disabled={f.customerName.trim().length < 2 || f.device.trim().length < 2 || f.problem.trim().length < 2} onClick={() => void create()}>{W.save}</button>
            <button className="ghost" onClick={() => setForm(null)}>إلغاء</button>
          </div>
        </div>
      )}

      <div className="card">
        {rows.length === 0 ? <div className="muted">ما فيش {W.none} {filter === "open" ? "مفتوحة الحين" : "هنا"}.</div> : (
          <table className="table">
            <thead><tr><th>#</th><th>الزبون</th><th>{W.head}</th><th>الحالة</th><th>المتبقي</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <RepairRow key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} update={(b) => update(r, b)} shopName={shopName} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="hint">{W.hint}</div>
    </>
  );
}

function RepairRow({ r, open, toggle, update, shopName }: { r: Repair; open: boolean; toggle: () => void; update: (b: Record<string, unknown>) => Promise<Repair | undefined>; shopName: string }) {
  const [final, setFinal] = useState(r.finalMinor !== null ? String(r.finalMinor / 1000) : String(r.estimateMinor / 1000));
  const [notes, setNotes] = useState(r.notes ?? "");
  const due = repairDue(r);
  const days = Math.floor((Date.now() - Date.parse(r.createdAt)) / 864e5);
  const kind: Kind = r.kind ?? "repair";
  const W = WORDS[kind];
  const [dueAt, setDueAt] = useState(localOf(r.dueAt));
  const late = !!r.dueAt && !["ready", "delivered", "cancelled"].includes(r.status) && Date.parse(r.dueAt) < Date.now();
  return (
    <>
      <tr onClick={toggle} style={{ cursor: "pointer" }}>
        <td className="num">{r.number}</td>
        <td>{r.customerName}{r.phone && <div className="muted small num">{r.phone}</div>}</td>
        <td>{r.device}<div className="muted small">{r.problem}</div></td>
        <td>{statusLabel(r.status, kind)}<div className={late ? "small" : "muted small"} style={late ? { color: "var(--danger)" } : undefined}>{r.status === "delivered" ? day(r.deliveredAt) : r.dueAt ? `${late ? "⚠️ تأخرت · " : "⏰ "}${when(r.dueAt)}` : days > 0 ? `من ${days} يوم` : "اليوم"}</div></td>
        <td className="num">{r.status === "cancelled" ? "—" : formatMoney(due)}</td>
        <td>{open ? "▲" : "▼"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <div className="stack">
              <div className="muted small">
                {r.serial && <>IMEI: <span className="num">{r.serial}</span> · </>}
                {r.accessories && <>معاه: {r.accessories} · </>}
                {r.technician && <>{W.who}: {r.technician} · </>}
                السعر {formatMoney(r.finalMinor ?? r.estimateMinor)} · العربون {formatMoney(r.depositMinor)} · استلام {day(r.createdAt)}
              </div>
              {!["delivered", "cancelled"].includes(r.status) && (
                <div className="row">
                  <label style={{ width: 150 }}>السعر النهائي<input className="num" value={final} onChange={(e) => setFinal(e.target.value)} /></label>
                  <button onClick={() => void update({ finalMinor: money(final) })}>حفظ السعر</button>
                  {kind === "order" && <>
                    <label style={{ width: 210 }}>موعد التسليم<input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label>
                    <button onClick={() => void update({ dueAt: isoOf(dueAt) })} disabled={dueAt === localOf(r.dueAt)}>حفظ الموعد</button>
                  </>}
                </div>
              )}
              <div className="row">
                <input style={{ flex: 1 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={W.notesPh} />
                <button onClick={() => void update({ notes })} disabled={notes === (r.notes ?? "")}>حفظ</button>
              </div>
              <div className="row">
                {REPAIR_NEXT[r.status].map((s) => (
                  <button key={s} className={s === "ready" || s === "delivered" ? "primary" : s === "cancelled" ? "danger" : ""}
                    onClick={() => {
                      if (s === "delivered" && due > 0 && !confirm(`استلمت من ${r.customerName} ${formatMoney(due)}؟`)) return;
                      if (s === "cancelled" && !confirm("نلغي الإيصال؟ رجّع العربون للزبون لو دفع.")) return;
                      void update({ status: s, ...(s === "ready" || s === "delivered" ? { finalMinor: money(final) } : {}) });
                    }}>
                    {statusLabel(s, kind)}
                  </button>
                ))}
                <span className="spacer" />
                {r.phone && r.status === "ready" && <a className="btn ghost" href={waLink(r.phone, readyText(r, shopName))} target="_blank" rel="noreferrer">💬 ذكّره بالواتساب</a>}
                <button className="ghost" onClick={() => printTicket(r, shopName)}>🖨️ الإيصال</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function readyText(r: Repair, shop: string) {
  const due = repairDue(r);
  if (r.kind === "order") return `السلام عليكم، طلبيتك (${r.device}) جاهزة في ${shop}. رقم الطلبية ${r.number}.${due > 0 ? ` المتبقي: ${formatMoney(due)}.` : ""} نستنوك، شكراً.`;
  return repairReadyMessage({ shop, number: r.number, device: r.device, dueText: due > 0 ? formatMoney(due) : "" });
}

/** The paper the customer keeps to collect the device, and a copy to stick on it. */
function printTicket(r: Repair, shop: string) {
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) return;
  const esc = (s: string | null | undefined) => (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const row = (k: string, v: string | null | undefined) => (v ? `<tr><td>${k}</td><td><b>${esc(v)}</b></td></tr>` : "");
  const W = WORDS[r.kind ?? "repair"];
  const body = `
    <h2>${esc(shop)}</h2><h3>${W.ticket} رقم ${r.number}</h3><div>${new Date(r.createdAt).toLocaleString("en-GB")}</div><hr/>
    <table>${row("الزبون", r.customerName)}${row("التلفون", r.phone)}${row(W.item, r.device)}${row("IMEI", r.serial)}${row(W.detail, r.problem)}${row("موعد التسليم", r.dueAt ? when(r.dueAt) : "")}${row("استلمنا معاه", r.accessories)}
    ${row("السعر المتفق عليه", r.estimateMinor ? formatMoney(r.estimateMinor) : "يتحدد بعد الفحص")}${row("العربون", r.depositMinor ? formatMoney(r.depositMinor) : "")}${row("المتبقي", r.estimateMinor ? formatMoney(repairDue(r)) : "")}</table>
    <hr/><small>${W.keep}</small>
    <hr class="cut"/><h3>رقم ${r.number}</h3><div>${esc(r.customerName)} · ${esc(r.phone)}</div><div>${esc(r.device)}</div><div>${esc(r.problem)}</div>`;
  w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>إيصال ${r.number}</title><style>
    body{font-family:system-ui,Tahoma,sans-serif;width:72mm;margin:0 auto;padding:4mm;text-align:center;color:#000}
    table{width:100%;text-align:right;border-collapse:collapse}td{padding:2px 0;vertical-align:top}td:first-child{color:#444;width:40%}
    hr{border:0;border-top:1px dashed #000}.cut{margin:8mm 0;border-top:2px dashed #000}h2,h3{margin:4px 0}
  </style></head><body>${body}<script>onload=()=>{print();}</script></body></html>`);
  w.document.close();
}

// ---- Lookup by number ----

function Lookup({ call }: { call: Call }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ pieces: Piece[]; repairs: Repair[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function find() {
    setErr(null);
    try {
      setRes(await call(`/serials/lookup?q=${encodeURIComponent(q.trim())}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="card stack">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void find(); }}>
        <input className="num" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="امسح أو اكتب الـIMEI، أو آخر 6 أرقام منه" autoFocus />
        <button className="primary" type="submit" disabled={q.trim().length < 3}>بحث</button>
      </form>
      <div className="muted small">الزبون جاي يقول الجهاز من عندكم؟ هنا تعرف متى تباع، بكم، لمن، وهل الضمان مازال.</div>
      {err && <div className="error">{err}</div>}
      {res && res.pieces.length === 0 && res.repairs.length === 0 && <div className="hint">الرقم هذا مش مسجل عندك.</div>}
      {res?.pieces.map((p) => {
        const w = warrantyState(p.warrantyUntil, today());
        return (
          <div key={p.id} className="card" style={{ background: "var(--bg)" }}>
            <div className="row"><b>{p.product}</b><span className="num muted">{p.serial}</span><span className="spacer" />
              <span className={p.status === "sold" ? "badge" : "badge ok"}>{p.status === "sold" ? "مباع" : "في المخزن"}</span></div>
            {p.sale ? (
              <div className="stack">
                <div>انباع {day(p.soldAt)} بفاتورة <b className="num">{p.sale.number}</b>{p.sale.priceMinor !== null && <> بسعر <b>{formatMoney(p.sale.priceMinor)}</b></>}{p.sale.cashier && <> · الكاشير {p.sale.cashier}</>}</div>
                {p.sale.customerName && <div>الزبون: {p.sale.customerName} {p.sale.customerPhone && <span className="num muted">{p.sale.customerPhone}</span>}</div>}
                <div>
                  {w.state === "active" && <span className="badge ok">✅ في الضمان حتى {dmy(p.warrantyUntil)} (باقي {w.daysLeft} يوم)</span>}
                  {w.state === "expired" && <span className="badge bad">⛔ الضمان خلص {dmy(p.warrantyUntil)} (من {w.daysAgo} يوم)</span>}
                  {w.state === "none" && <span className="muted">بدون ضمان</span>}
                </div>
              </div>
            ) : (
              <div className="muted">دخل المخزن {day(p.receivedAt)}{p.storeName && ` · ${p.storeName}`}{p.returnedAt && ` · رجع من زبون ${day(p.returnedAt)}`}{p.warrantyMonths ? ` · ${warrantyLabel(p.warrantyMonths)} من يوم البيع` : ""}</div>
            )}
            {p.note && <div className="muted small">{p.note}</div>}
          </div>
        );
      })}
      {res && res.repairs.length > 0 && (
        <div className="stack">
          <b>🔧 صيانات هذا الجهاز</b>
          {res.repairs.map((r) => <div key={r.id} className="muted">#{r.number} · {day(r.createdAt)} · {r.problem} · {REPAIR_STATUS_LABELS[r.status]}</div>)}
        </div>
      )}
    </div>
  );
}

// ---- Numbers in stock ----

function Serials({ call, storeId }: { call: Call; storeId: string }) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [pid, setPid] = useState("");
  const [text, setText] = useState("");
  const [addStock, setAddStock] = useState(true);
  const [list, setList] = useState<{ id: string; serial: string; status: string; soldAt: string | null; saleNumber: string | null; note: string | null }[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const loadSummary = () => call<Summary[]>("/serials/summary").then(setSummary);
  useEffect(() => {
    void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then((ps) => setProducts(ps.filter((p) => p.active && !p.isWeighted && !p.groupId)));
    void loadSummary();
  }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pid) void call<typeof list>(`/serials?productId=${pid}`).then(setList); else setList([]); }, [pid, call]);
  const serials = useMemo(() => parseSerials(text), [text]);
  const bad = serials.filter(looksLikeBadImei);

  async function save() {
    setMsg(null);
    try {
      const r = await call<{ added: string[]; existing: { serial: string; product: string }[] }>("/serials", { body: { productId: pid, serials, storeId, addStock } });
      setText("");
      setMsg({ text: `انضاف ${r.added.length} رقم${addStock && r.added.length ? ` وزادت الكمية ${r.added.length}` : ""}${r.existing.length ? `. موجودين من قبل: ${r.existing.map((x) => `${x.serial} (${x.product})`).join("، ")}` : ""}` });
      setList(await call(`/serials?productId=${pid}`));
      await loadSummary();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function remove(id: string) {
    if (!confirm("نشيل الرقم هذا من القائمة؟ الكمية في المخزن ما تتغيرش.")) return;
    await call(`/serials/${id}`, { method: "DELETE" });
    setList(await call(`/serials?productId=${pid}`));
    await loadSummary();
  }

  return (
    <>
      {summary.length > 0 && (
        <div className="card">
          <table className="table">
            <thead><tr><th>الصنف</th><th>أرقام في المخزن</th><th>الكمية في المخزن</th><th>انباع</th><th>الضمان</th></tr></thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.id} onClick={() => setPid(s.id)} style={{ cursor: "pointer" }} className={pid === s.id ? "sel" : ""}>
                  <td>{s.name}</td>
                  <td className="num">{s.inStock}</td>
                  <td className="num">{s.stockMilli / 1000}{Math.round(s.stockMilli / 1000) !== s.inStock && <span className="muted small"> ⚠️ مش نفس العدد</span>}</td>
                  <td className="num">{s.sold}</td>
                  <td>{warrantyLabel(s.warrantyMonths) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card stack">
        <h3>📥 إدخال أرقام أجهزة</h3>
        <label>الصنف
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="">اختار…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.serialized ? " 📱" : ""}</option>)}
          </select>
        </label>
        <label>الأرقام (امسحها ورا بعض بالقارئ، كل رقم في سطر)
          <textarea className="num" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"356938035643809\n490154203237518"} />
        </label>
        {serials.length > 0 && <div className="muted">{serials.length} رقم{bad.length ? ` · ⚠️ مش IMEI صحيح: ${bad.join("، ")}` : ""}</div>}
        <label className="row" style={{ color: "var(--ink)" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={addStock} onChange={(e) => setAddStock(e.target.checked)} /> زيد الكمية في المخزن بعدد الأرقام
        </label>
        <div className="muted small">لو الأجهزة دخلت بفاتورة توريد، شيل العلامة باش ما تنحسبش الكمية مرتين.</div>
        {msg && <div className={msg.bad ? "error" : "hint"}>{msg.text}</div>}
        <div><button className="primary" disabled={!pid || !serials.length} onClick={() => void save()}>حفظ الأرقام</button></div>
      </div>
      {pid && list.length > 0 && (
        <div className="card">
          <table className="table">
            <thead><tr><th>الرقم</th><th>الحالة</th><th /></tr></thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id}>
                  <td className="num">{x.serial}{x.note && <div className="muted small">{x.note}</div>}</td>
                  <td>{x.status === "sold" ? `مباع ${day(x.soldAt)} · ${x.saleNumber ?? ""}` : "في المخزن"}</td>
                  <td>{x.status === "in_stock" && <button className="ghost" onClick={() => void remove(x.id)}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
