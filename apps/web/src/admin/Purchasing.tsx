import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import { Modal } from "../pos/dialogs";
import type { Call } from "./Admin";

interface Supplier { id: string; name: string; phone: string | null; note: string | null; active: boolean; balance_minor: number; last_purchase_at: string | null }
interface Invoice { id: string; supplier_ref: string | null; invoice_date: string; total_minor: number; paid_minor: number; supplier_name: string | null; store_name: string; lines: number; created_at: string }
interface Reorder {
  id: string; name: string; is_weighted: boolean; min_stock_milli: number; stock_milli: number; suggest_milli: number; cost_minor: number;
  base_unit_id: string; base_unit_name: string; last_unit_id: string | null; last_unit_name: string | null; last_factor_milli: number | null;
  last_cost_minor: number | null; supplier_id: string | null; supplier_name: string | null;
}
interface Line { key: string; productId: string; name: string; unitId: string; units: CatalogProduct["units"]; qty: string; cost: string }

const METHOD = { cash: "كاش", bank: "تحويل مصرفي", cheque: "صك", other: "أخرى" } as const;
const date = (d: string) => new Date(d).toLocaleDateString("en-GB");
const TABS = { invoice: "فاتورة شراء جديدة", invoices: "الفواتير", suppliers: "الموردين", reorder: "النواقص" } as const;

export function Purchasing({ call, storeId }: { call: Call; storeId: string }) {
  const [tab, setTab] = useState<keyof typeof TABS>("invoice");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [draft, setDraft] = useState<{ supplierId: string; lines: Line[] } | null>(null);
  const loadSuppliers = () => call<Supplier[]>("/suppliers").then(setSuppliers);
  useEffect(() => void loadSuppliers(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="tabs">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{TABS[k]}</button>
        ))}
      </div>
      {tab === "invoice" && <NewInvoice call={call} storeId={storeId} suppliers={suppliers} reloadSuppliers={loadSuppliers} draft={draft} clearDraft={() => setDraft(null)} />}
      {tab === "invoices" && <Invoices call={call} />}
      {tab === "suppliers" && <Suppliers call={call} list={suppliers} reload={loadSuppliers} />}
      {tab === "reorder" && <ReorderList call={call} storeId={storeId} order={(d) => { setDraft(d); setTab("invoice"); }} />}
    </div>
  );
}

function NewInvoice({ call, storeId, suppliers, reloadSuppliers, draft, clearDraft }: {
  call: Call; storeId: string; suppliers: Supplier[]; reloadSuppliers: () => Promise<unknown>;
  draft: { supplierId: string; lines: Line[] } | null; clearDraft: () => void;
}) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [ref, setRef] = useState("");
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([]);
  const [find, setFind] = useState("");
  const [paid, setPaid] = useState<string | null>(null);
  const [method, setMethod] = useState<keyof typeof METHOD>("cash");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then(setProducts), [call, storeId]);
  useEffect(() => {
    if (!draft) return;
    setSupplierId(draft.supplierId);
    setLines(draft.lines);
    clearDraft();
  }, [draft, clearDraft]);

  const matches = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (q.length < 2) return [];
    return products.filter((p) => p.active && (p.name.toLowerCase().includes(q) || p.units.some((u) => u.barcodes.includes(q)))).slice(0, 8);
  }, [find, products]);

  const lineTotal = (l: Line) => Math.round(toMinor(Number(l.qty) || 0) * toMinor(Number(l.cost) || 0) / 1000);
  const total = lines.reduce((a, l) => a + lineTotal(l), 0);
  const paidMinor = paid === null ? total : toMinor(Number(paid) || 0);

  function add(p: CatalogProduct) {
    // Bought in the biggest unit usually; cost starts from the current cost.
    const unit = [...p.units].sort((a, b) => b.factorMilli - a.factorMilli)[0];
    setLines((ls) => [...ls, { key: crypto.randomUUID(), productId: p.id, name: p.name, unitId: unit.id, units: p.units, qty: "1", cost: String((p.costMinor * unit.factorMilli) / 1e6) }]);
    setFind("");
  }
  const edit = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function newSupplier() {
    const name = prompt("اسم المورد");
    if (!name) return;
    const phone = prompt("الهاتف (اختياري)") || null;
    const r = await call<{ id: string }>("/suppliers", { body: { name, phone } });
    await reloadSuppliers();
    setSupplierId(r.id);
  }

  async function save() {
    setMsg(null);
    try {
      const r = await call<{ totalMinor: number; paidMinor: number }>("/purchases", {
        body: {
          storeId, supplierId: supplierId || null, supplierRef: ref || undefined, invoiceDate: day, paymentMethod: method,
          paidMinor: supplierId ? paidMinor : undefined,
          lines: lines.map((l) => ({ unitId: l.unitId, qtyMilli: toMinor(Number(l.qty) || 0), unitCostMinor: toMinor(Number(l.cost) || 0) })),
        },
      });
      setMsg({ text: `تم الاستلام: ${formatMoney(r.totalMinor)}${r.totalMinor > r.paidMinor ? ` · باقي للمورد ${formatMoney(r.totalMinor - r.paidMinor)}` : ""}` });
      setLines([]);
      setRef("");
      setPaid(null);
      await reloadSuppliers();
      setProducts(await call<CatalogProduct[]>(`/products?storeId=${storeId}`));
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: "end" }}>
        <label style={{ minWidth: 220 }}>المورد
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">بدون مورد (مدفوعة)</option>
              {suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button type="button" onClick={newSupplier}>+</button>
          </div>
        </label>
        <label>رقم فاتورة المورد<input value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 140 }} /></label>
        <label>التاريخ<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
      </div>
      <div style={{ position: "relative" }}>
        <input placeholder="امسح باركود أو اكتب اسم الصنف لإضافته" value={find} onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) add(matches[0]); }} />
        {matches.length > 0 && (
          <div className="results">
            {matches.map((p) => <button key={p.id} onClick={() => add(p)}><span>{p.name}</span><span className="muted num">{formatMoney(p.costMinor)}</span></button>)}
          </div>
        )}
      </div>
      {lines.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>تكلفة الوحدة</th><th>الإجمالي</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.name}</td>
                  <td>
                    <select value={l.unitId} onChange={(e) => edit(l.key, { unitId: e.target.value })} style={{ width: "auto" }}>
                      {l.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </td>
                  <td><input className="num" value={l.qty} onChange={(e) => edit(l.key, { qty: e.target.value })} style={{ width: 80 }} /></td>
                  <td><input className="num" value={l.cost} onChange={(e) => edit(l.key, { cost: e.target.value })} style={{ width: 100 }} /></td>
                  <td className="num">{formatMoney(lineTotal(l))}</td>
                  <td><button className="danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ alignItems: "end" }}>
        <div className="kpi"><span className="muted">الإجمالي</span><b className="num">{formatMoney(total)}</b></div>
        {supplierId && (
          <>
            <label>المدفوع الآن<input className="num" value={paid ?? String(total / 1000)} onChange={(e) => setPaid(e.target.value)} style={{ width: 120 }} /></label>
            <label>الطريقة
              <select value={method} onChange={(e) => setMethod(e.target.value as keyof typeof METHOD)} style={{ width: "auto" }}>
                {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {total - paidMinor > 0 && <span className="badge off">يتسجل دين للمورد {formatMoney(total - paidMinor)}</span>}
          </>
        )}
        <span className="spacer" />
        <button className="primary big" disabled={!lines.length || lines.some((l) => !(Number(l.qty) > 0))} onClick={save}>استلام البضاعة</button>
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
    </div>
  );
}

function Invoices({ call }: { call: Call }) {
  const [list, setList] = useState<Invoice[]>([]);
  const [open, setOpen] = useState<(Invoice & { lines: { name: string; unit_name: string; qty_milli: number; unit_cost_minor: number; total_minor: number }[] }) | null>(null);
  useEffect(() => void call<Invoice[]>("/purchases").then(setList), [call]);
  return (
    <div className="card" style={{ padding: 0, overflow: "auto" }}>
      <table>
        <thead><tr><th>التاريخ</th><th>المورد</th><th>رقم فاتورته</th><th>أصناف</th><th>الإجمالي</th><th>المدفوع</th></tr></thead>
        <tbody>
          {list.map((i) => (
            <tr key={i.id} onClick={async () => setOpen(await call(`/purchases/${i.id}`))} style={{ cursor: "pointer" }}>
              <td className="num">{date(i.invoice_date)}</td>
              <td>{i.supplier_name ?? "—"}</td>
              <td className="num">{i.supplier_ref ?? "—"}</td>
              <td className="num">{i.lines}</td>
              <td className="num">{formatMoney(i.total_minor)}</td>
              <td>{i.paid_minor >= i.total_minor ? <span className="badge ok">مدفوعة</span> : <span className="badge off num">{formatMoney(i.paid_minor)}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="muted" style={{ padding: 16 }}>ما فيش فواتير شراء لتوا.</p>}
      {open && (
        <Modal title={`فاتورة ${open.supplier_name ?? ""} ${open.supplier_ref ?? ""}`} onClose={() => setOpen(null)}>
          <table>
            <thead><tr><th>الصنف</th><th>الكمية</th><th>التكلفة</th><th>الإجمالي</th></tr></thead>
            <tbody>
              {open.lines.map((l, k) => (
                <tr key={k}><td>{l.name}</td><td className="num">{formatQty(l.qty_milli, false)} {l.unit_name}</td><td className="num">{formatMoney(l.unit_cost_minor)}</td><td className="num">{formatMoney(l.total_minor)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row"><b>الإجمالي</b><span className="spacer" /><b className="num">{formatMoney(open.total_minor)}</b></div>
        </Modal>
      )}
    </div>
  );
}

interface Entry { at: string; type: "invoice" | "payment"; ref: string; amount_minor: number; balance_minor: number }

function Suppliers({ call, list, reload }: { call: Call; list: Supplier[]; reload: () => Promise<unknown> }) {
  const [edit, setEdit] = useState<{ id?: string; name: string; phone: string; note: string } | null>(null);
  const [pay, setPay] = useState<{ s: Supplier; amount: string; method: keyof typeof METHOD } | null>(null);
  const [statement, setStatement] = useState<{ supplier: Supplier; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owed = list.reduce((a, s) => a + Math.max(s.balance_minor, 0), 0);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">علينا للموردين: <b className="num">{formatMoney(owed)}</b></span>
        <span className="spacer" />
        <button className="primary" onClick={() => setEdit({ name: "", phone: "", note: "" })}>+ مورد</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>المورد</th><th>الهاتف</th><th>آخر شراء</th><th>علينا</th><th /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                <td>{s.name}{s.note && <div className="muted">{s.note}</div>}</td>
                <td className="num">{s.phone ?? "—"}</td>
                <td className="num">{s.last_purchase_at ? date(s.last_purchase_at) : "—"}</td>
                <td><span className={s.balance_minor > 0 ? "badge off" : ""}><span className="num">{formatMoney(s.balance_minor)}</span></span></td>
                <td className="row">
                  <button onClick={() => setPay({ s, amount: String(Math.max(s.balance_minor, 0) / 1000), method: "cash" })} disabled={s.balance_minor <= 0}>تسديد</button>
                  <button onClick={async () => setStatement(await call(`/suppliers/${s.id}/statement`))}>كشف حساب</button>
                  <button onClick={() => setEdit({ id: s.id, name: s.name, phone: s.phone ?? "", note: s.note ?? "" })}>تعديل</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <p className="muted" style={{ padding: 16 }}>ضيف الموردين اللي تشري منهم.</p>}
      </div>

      {edit && (
        <Modal title={edit.id ? "تعديل مورد" : "مورد جديد"} onClose={() => setEdit(null)}>
          <label>الاسم<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
          <label>الهاتف<input className="num" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
          <label>ملاحظة<input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setEdit(null)}>إلغاء</button>
            <button className="primary" disabled={edit.name.length < 2} onClick={() => run(() => call(edit.id ? `/suppliers/${edit.id}` : "/suppliers", { method: edit.id ? "PATCH" : "POST", body: { name: edit.name, phone: edit.phone || null, note: edit.note || null } })).then(() => setEdit(null))}>حفظ</button>
          </div>
        </Modal>
      )}

      {pay && (
        <Modal title={`تسديد لـ ${pay.s.name}`} onClose={() => setPay(null)}>
          <div className="muted">علينا له <b className="num">{formatMoney(pay.s.balance_minor)}</b></div>
          <label>المبلغ (د.ل)<input className="num" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} autoFocus /></label>
          <label>الطريقة
            <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value as keyof typeof METHOD })}>
              {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {error && <div className="error">{error}</div>}
          <div className="row"><span className="spacer" /><button onClick={() => setPay(null)}>إلغاء</button>
            <button className="primary" disabled={!(Number(pay.amount) > 0)} onClick={() => run(() => call(`/suppliers/${pay.s.id}/payments`, { body: { amountMinor: toMinor(Number(pay.amount)), method: pay.method } })).then(() => setPay(null))}>تسديد</button>
          </div>
        </Modal>
      )}

      {statement && (
        <Modal title={`كشف حساب: ${statement.supplier.name}`} onClose={() => setStatement(null)}>
          <table>
            <thead><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
            <tbody>
              {statement.entries.map((e, i) => (
                <tr key={i}>
                  <td className="num">{date(e.at)}</td>
                  <td>{e.type === "invoice" ? "فاتورة شراء" : "تسديد"} <span className="muted num">{e.type === "payment" ? METHOD[e.ref as keyof typeof METHOD] ?? e.ref : e.ref}</span></td>
                  <td className="num">{formatMoney(e.amount_minor)}</td>
                  <td className="num">{formatMoney(e.balance_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row"><b>علينا حالياً</b><span className="spacer" /><b className="num">{formatMoney(statement.supplier.balance_minor)}</b></div>
        </Modal>
      )}
    </div>
  );
}

function ReorderList({ call, storeId, order }: { call: Call; storeId: string; order: (d: { supplierId: string; lines: Line[] }) => void }) {
  const [rows, setRows] = useState<Reorder[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  useEffect(() => {
    void call<Reorder[]>(`/stock/reorder?storeId=${storeId}`).then(setRows);
    void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then(setProducts);
  }, [call, storeId]);
  const bySupplier = useMemo(() => {
    const m = new Map<string, { name: string; rows: Reorder[] }>();
    for (const r of rows) {
      const k = r.supplier_id ?? "";
      if (!m.has(k)) m.set(k, { name: r.supplier_name ?? "بدون مورد سابق", rows: [] });
      m.get(k)!.rows.push(r);
    }
    return [...m.entries()];
  }, [rows]);

  function toDraft(supplierId: string, list: Reorder[]) {
    order({
      supplierId,
      lines: list.map((r) => {
        // Order in the unit bought last time, rounded up to whole units.
        const factor = r.last_factor_milli ?? 1000;
        const qty = Math.max(1, Math.ceil(r.suggest_milli / factor));
        return {
          key: crypto.randomUUID(), productId: r.id, name: r.name, unitId: r.last_unit_id ?? r.base_unit_id,
          units: products.find((p) => p.id === r.id)?.units ?? [],
          qty: String(qty), cost: String((r.last_cost_minor ?? (r.cost_minor * factor) / 1000) / 1000),
        };
      }),
    });
  }

  if (rows.length === 0) return <div className="card muted">ما فيش نواقص. (حط «حد التنبيه بالنقص» لكل صنف من صفحة الأصناف.)</div>;
  return (
    <div className="stack">
      {bySupplier.map(([sid, g]) => (
        <div className="card stack" key={sid}>
          <div className="row"><h3 style={{ margin: 0 }}>{g.name}</h3><span className="spacer" /><button className="primary" onClick={() => toDraft(sid, g.rows)}>اعمل فاتورة شراء بيهم</button></div>
          <table>
            <thead><tr><th>الصنف</th><th>الموجود</th><th>حد التنبيه</th><th>المقترح</th><th>آخر تكلفة</th></tr></thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td><span className="badge bad num">{formatQty(r.stock_milli, r.is_weighted)}</span></td>
                  <td className="num">{formatQty(r.min_stock_milli, r.is_weighted)}</td>
                  <td className="num">{formatQty(r.suggest_milli, r.is_weighted)} {r.base_unit_name}</td>
                  <td className="num">{r.last_cost_minor !== null ? `${formatMoney(r.last_cost_minor)} / ${r.last_unit_name}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
