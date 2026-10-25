import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Store { id: string; name: string; address: string | null; phone: string | null; receipt_footer: string | null; active: boolean; devices: number; stock_value_minor: number }
interface Transfer {
  id: string; number: number; status: "sent" | "received" | "cancelled"; note: string | null; sent_at: string; done_at: string | null;
  from_store_id: string; to_store_id: string; from_name: string; to_name: string; sent_by_name: string | null; done_by_name: string | null; lines: number; short_milli: number;
}
interface TransferLine { id: string; product_id: string; name: string; qty_milli: number; received_milli: number | null; is_weighted: boolean }
interface BranchRow { id: string; name: string; sales_count: number; total_minor: number; returns_minor: number; gross_profit_minor: number }
interface ByStore { id: string; name: string; is_weighted: boolean; min_stock_milli: number; stock: Record<string, number> }

type P = CatalogProduct & { stockMilli: number };

const TABS = { transfers: "التحويلات", stores: "الفروع", compare: "مقارنة الفروع" } as const;
const STATUS = { sent: ["في الطريق", "off"], received: ["مستلم", "ok"], cancelled: ["ملغي", ""] } as const;
const when = (d: string) => new Date(d).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
const today = () => new Date().toLocaleDateString("en-CA");

export function Branches({ call, storeId, isOwner, onStoresChanged }: { call: Call; storeId: string; isOwner: boolean; onStoresChanged: () => void }) {
  const [tab, setTab] = useState<keyof typeof TABS>("transfers");
  const [stores, setStores] = useState<Store[]>([]);
  const load = () => call<Store[]>("/stores").then(setStores);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = async () => {
    await load();
    onStoresChanged();
  };
  return (
    <div className="stack">
      <div className="tabs">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{TABS[k]}</button>
        ))}
      </div>
      {tab === "transfers" && <Transfers call={call} storeId={storeId} stores={stores.filter((s) => s.active)} />}
      {tab === "stores" && <Stores call={call} list={stores} reload={reload} isOwner={isOwner} />}
      {tab === "compare" && <Compare call={call} stores={stores.filter((s) => s.active)} />}
    </div>
  );
}

function Transfers({ call, storeId, stores }: { call: Call; storeId: string; stores: Store[] }) {
  const [list, setList] = useState<Transfer[]>([]);
  const [making, setMaking] = useState(false);
  const [open, setOpen] = useState<(Transfer & { lines: TransferLine[] }) | null>(null);
  const load = () => call<Transfer[]>(`/transfers?storeId=${storeId}`).then(setList);
  useEffect(() => void load(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const incoming = list.filter((t) => t.status === "sent" && t.to_store_id === storeId);
  const here = stores.find((s) => s.id === storeId);

  if (stores.length < 2) {
    return <div className="card muted">التحويلات تحتاج فرعين على الأقل. ضيف فرع من «الفروع».</div>;
  }
  return (
    <div className="stack">
      {incoming.length > 0 && (
        <div className="notice">في {incoming.length} تحويل جاي لـ{here?.name} يستنى الاستلام. افتحه وأكد الكميات اللي وصلت.</div>
      )}
      <div className="row"><span className="spacer" /><button className="primary" onClick={() => setMaking(true)}>+ تحويل من {here?.name}</button></div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>رقم</th><th>من</th><th>إلى</th><th>أصناف</th><th>أرسله</th><th>التاريخ</th><th>الحالة</th></tr></thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} style={{ cursor: "pointer" }} onClick={async () => setOpen(await call(`/transfers/${t.id}`))}>
                <td className="num">{t.number}</td>
                <td>{t.from_name}</td>
                <td>{t.to_name}</td>
                <td className="num">{t.lines}</td>
                <td>{t.sent_by_name ?? "—"}</td>
                <td className="num">{when(t.sent_at)}</td>
                <td>
                  <span className={`badge ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span>
                  {t.short_milli > 0 && <span className="badge bad" style={{ marginInlineStart: 4 }}>ناقص</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <p className="muted" style={{ padding: 16 }}>ما فيش تحويلات لهالفرع.</p>}
      </div>
      {making && <NewTransfer call={call} from={here!} stores={stores} onClose={() => setMaking(false)} onDone={() => { setMaking(false); void load(); }} />}
      {open && <TransferDetail call={call} t={open} storeId={storeId} onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); }} />}
    </div>
  );
}

function NewTransfer({ call, from, stores, onClose, onDone }: { call: Call; from: Store; stores: Store[]; onClose: () => void; onDone: () => void }) {
  const others = stores.filter((s) => s.id !== from.id);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [products, setProducts] = useState<P[]>([]);
  const [find, setFind] = useState("");
  const [lines, setLines] = useState<{ p: P; unitId: string; qty: string }[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void call<P[]>(`/products?storeId=${from.id}`).then(setProducts), [call, from.id]);
  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return products.filter((p) => p.active && (p.name.toLowerCase().includes(q) || p.units.some((u) => u.barcodes.includes(q)))).slice(0, 8);
  }, [find, products]);
  const base = (l: (typeof lines)[number]) => Math.round((toMinor(Number(l.qty) || 0) * (l.p.units.find((u) => u.id === l.unitId)?.factorMilli ?? 1000)) / 1000);

  async function send() {
    setError(null);
    try {
      await call("/transfers", { body: { fromStoreId: from.id, toStoreId: to, note: note || undefined, lines: lines.map((l) => ({ productId: l.p.id, qtyMilli: base(l) })) } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title={`تحويل بضاعة من ${from.name}`} onClose={onClose}>
      <label>إلى فرع
        <select value={to} onChange={(e) => setTo(e.target.value)}>{others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <div style={{ position: "relative" }}>
        <input placeholder="امسح باركود أو اكتب اسم الصنف" value={find} onChange={(e) => setFind(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) { setLines((ls) => [...ls, { p: matches[0], unitId: matches[0].units[0].id, qty: "1" }]); setFind(""); } }} />
        {matches.length > 0 && (
          <div className="results">
            {matches.map((p) => (
              <button key={p.id} onClick={() => { setLines((ls) => [...ls, { p, unitId: p.units[0].id, qty: "1" }]); setFind(""); }}>
                <span>{p.name}</span><span className="muted num">الموجود {formatQty(p.stockMilli, p.isWeighted)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {lines.length > 0 && (
        <table>
          <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>الموجود</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.p.name}</td>
                <td>
                  <select value={l.unitId} style={{ width: "auto" }} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitId: e.target.value } : x)))}>
                    {l.p.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </td>
                <td><input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
                <td><span className={base(l) > l.p.stockMilli ? "badge bad num" : "num"}>{formatQty(l.p.stockMilli, l.p.isWeighted)}</span></td>
                <td><button className="danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <label>ملاحظة<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: مع السايق محمد" /></label>
      {error && <div className="error">{error}</div>}
      <div className="row"><span className="spacer" /><button onClick={onClose}>إلغاء</button>
        <button className="primary" disabled={!to || !lines.length || lines.some((l) => !(base(l) > 0))} onClick={send}>إرسال</button>
      </div>
    </Modal>
  );
}

function TransferDetail({ call, t, storeId, onClose, onDone }: { call: Call; t: Transfer & { lines: TransferLine[] }; storeId: string; onClose: () => void; onDone: () => void }) {
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(t.lines.map((l) => [l.id, String(l.qty_milli / 1000)])));
  const [error, setError] = useState<string | null>(null);
  const canReceive = t.status === "sent" && t.to_store_id === storeId;
  async function act(path: string, body?: unknown) {
    setError(null);
    try {
      await call(path, { body: body ?? {} });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title={`تحويل رقم ${t.number}: ${t.from_name} ← ${t.to_name}`} onClose={onClose}>
      <div className="muted">
        <span className={`badge ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span> · أرسله {t.sent_by_name ?? "—"} {when(t.sent_at)}
        {t.done_at && <> · {t.status === "received" ? "استلمه" : "ألغاه"} {t.done_by_name ?? "—"} {when(t.done_at)}</>}
        {t.note && <div>{t.note}</div>}
      </div>
      <table>
        <thead><tr><th>الصنف</th><th>المرسل</th><th>{canReceive ? "اللي وصل فعلاً" : "المستلم"}</th></tr></thead>
        <tbody>
          {t.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="num">{formatQty(l.qty_milli, l.is_weighted)}</td>
              <td>
                {canReceive ? (
                  <input className="num" style={{ width: 90 }} value={got[l.id]} onChange={(e) => setGot({ ...got, [l.id]: e.target.value })} />
                ) : l.received_milli === null ? "—" : (
                  <span className={l.received_milli < l.qty_milli ? "badge bad num" : "num"}>{formatQty(l.received_milli, l.is_weighted)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="error">{error}</div>}
      <div className="row">
        {t.status === "sent" && <button className="danger" onClick={() => confirm("إلغاء التحويل يرجّع البضاعة للفرع المرسل. متأكد؟") && act(`/transfers/${t.id}/cancel`)}>إلغاء التحويل</button>}
        <span className="spacer" />
        {t.status === "sent" && !canReceive && <span className="muted">الاستلام يكون من إدارة {t.to_name}</span>}
        {canReceive && (
          <button className="primary" onClick={() => act(`/transfers/${t.id}/receive`, { lines: t.lines.map((l) => ({ id: l.id, receivedMilli: toMinor(Number(got[l.id]) || 0) })) })}>تأكيد الاستلام</button>
        )}
      </div>
    </Modal>
  );
}

function Stores({ call, list, reload, isOwner }: { call: Call; list: Store[]; reload: () => Promise<void>; isOwner: boolean }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; address: string; phone: string; footer: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  return (
    <div className="stack">
      {isOwner && <div className="row"><span className="spacer" /><button className="primary" onClick={() => setEdit({ name: "", address: "", phone: "", footer: "" })}>+ فرع جديد</button></div>}
      {error && !edit && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الفرع</th><th>الهاتف</th><th>أجهزة</th><th>قيمة المخزون (بالتكلفة)</th><th>الحالة</th>{isOwner && <th />}</tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                <td>{s.name}{s.address && <div className="muted">{s.address}</div>}</td>
                <td className="num">{s.phone ?? "—"}</td>
                <td className="num">{s.devices}</td>
                <td className="num">{formatMoney(s.stock_value_minor)}</td>
                <td>{s.active ? <span className="badge ok">شغال</span> : <span className="badge">موقوف</span>}</td>
                {isOwner && (
                  <td className="row">
                    <button onClick={() => setEdit({ id: s.id, name: s.name, address: s.address ?? "", phone: s.phone ?? "", footer: s.receipt_footer ?? "" })}>تعديل</button>
                    <button onClick={() => run(() => call(`/stores/${s.id}`, { method: "PATCH", body: { active: !s.active } }))}>{s.active ? "إيقاف" : "تشغيل"}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">كل فرع ليه مخزونه وأجهزته وتقريره. بدّل الفرع من فوق باش تشوف تقريره وأصنافه، وعرّف أجهزة الكاشير من «الأجهزة» وانت على الفرع المطلوب.</p>
      {edit && (
        <Modal title={edit.id ? "تعديل فرع" : "فرع جديد"} onClose={() => setEdit(null)}>
          <label>الاسم<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <label>العنوان<input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></label>
          <label>الهاتف<input className="num" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
          <label>تذييل الإيصال<input value={edit.footer} onChange={(e) => setEdit({ ...edit, footer: e.target.value })} /></label>
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setEdit(null)}>إلغاء</button>
            <button className="primary" disabled={edit.name.length < 2} onClick={async () => {
              const body = { name: edit.name, address: edit.address || null, phone: edit.phone || null, receiptFooter: edit.footer || null };
              if (await run(() => call(edit.id ? `/stores/${edit.id}` : "/stores", { method: edit.id ? "PATCH" : "POST", body }))) setEdit(null);
            }}>حفظ</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Compare({ call, stores }: { call: Call; stores: Store[] }) {
  const [from, setFrom] = useState(() => today().slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<BranchRow[]>([]);
  const [stock, setStock] = useState<ByStore[]>([]);
  const [find, setFind] = useState("");
  useEffect(() => void call<BranchRow[]>(`/reports/branches?from=${from}&to=${to}`).then(setRows), [call, from, to]);
  useEffect(() => void call<ByStore[]>("/stock/by-store").then(setStock), [call]);
  const total = rows.reduce((a, r) => a + Number(r.total_minor), 0) || 1;
  const shown = stock.filter((p) => !find || p.name.includes(find)).slice(0, 100);
  return (
    <div className="stack">
      <div className="row">
        <label>من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الفرع</th><th>الفواتير</th><th>صافي المبيعات</th><th>المرتجعات</th><th>الربح التقريبي</th><th>النسبة</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num">{r.sales_count}</td>
                <td className="num">{formatMoney(r.total_minor)}</td>
                <td className="num">{formatMoney(r.returns_minor)}</td>
                <td className="num">{formatMoney(r.gross_profit_minor)}</td>
                <td style={{ minWidth: 120 }}>
                  <div style={{ background: "var(--brand)", height: 8, borderRadius: 4, width: `${Math.round((Number(r.total_minor) / total) * 100)}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ margin: 0 }}>المخزون في كل فرع</h3>
      <input placeholder="ابحث عن صنف" value={find} onChange={(e) => setFind(e.target.value)} />
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الصنف</th>{stores.map((s) => <th key={s.id}>{s.name}</th>)}</tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                {stores.map((s) => {
                  const q = p.stock[s.id] ?? 0;
                  return <td key={s.id}><span className={q <= p.min_stock_milli && p.min_stock_milli > 0 ? "badge bad num" : "num"}>{formatQty(q, p.is_weighted)}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
