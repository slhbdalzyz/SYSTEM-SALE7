import { useEffect, useMemo, useState } from "react";
import { breakdownYield, formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import type { Call } from "./Admin";

type Row = CatalogProduct & { stockMilli: number | null };
interface Dept { id: string; name: string; icon: string | null }
interface Breakdown {
  id: string; created_at: string; source_name: string; source_qty_milli: number; cost_minor: number; note: string | null; by_name: string | null;
  lines: { productId: string; name: string; qtyMilli: number; costMinor: number }[]; outMilli: number; wasteMilli: number; yieldBp: number;
}

const base = (p: CatalogProduct) => p.units.find((u) => u.isBase) ?? p.units[0];
const kg = (s: string) => toMinor(Number(s.replace(",", ".")) || 0);
const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;

/** A butcher's morning: today's price per kilo, and the carcasses cut into what is sold. */
export function Butcher({ call, storeId }: { call: Call; storeId: string }) {
  const [tab, setTab] = useState<"prices" | "cut">("prices");
  const [rows, setRows] = useState<Row[]>([]);
  const [cats, setCats] = useState<Dept[]>([]);
  const load = async () => {
    setRows(await call<Row[]>(`/products?storeId=${storeId}`));
    setCats(await call<Dept[]>("/categories"));
  };
  useEffect(() => void load(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="seg" role="tablist">
        <button className={tab === "prices" ? "active" : ""} onClick={() => setTab("prices")}>⚖️ أسعار اليوم</button>
        <button className={tab === "cut" ? "active" : ""} onClick={() => setTab("cut")}>🔪 تقطيع الذبائح</button>
      </div>
      {tab === "prices" ? <Prices call={call} rows={rows} cats={cats} reload={load} /> : <Cut call={call} storeId={storeId} rows={rows} reload={load} />}
    </div>
  );
}

/** Every weighed item (or a department) with its price, changed in one go and sent to the tills. */
function Prices({ call, rows, cats, reload }: { call: Call; rows: Row[]; cats: Dept[]; reload: () => Promise<void> }) {
  const [dept, setDept] = useState("weighed");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const shown = rows.filter((p) => p.active && (dept === "weighed" ? p.isWeighted : p.categoryId === dept));
  const changed = Object.entries(draft).filter(([unitId, v]) => {
    const p = rows.find((r) => base(r).id === unitId);
    return v.trim() !== "" && p && kg(v) !== base(p).priceMinor;
  });
  async function save() {
    setMsg(null);
    try {
      const r = await call<{ changed: number }>("/prices/bulk", { body: { items: changed.map(([unitId, v]) => ({ unitId, priceMinor: kg(v) })) } });
      setDraft({});
      await reload();
      setMsg({ text: `تم تغيير ${r.changed} سعر، ويوصلوا للكاشير مع المزامنة الجاية.` });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }
  return (
    <div className="card stack">
      <div className="chips">
        <button className={dept === "weighed" ? "active" : ""} onClick={() => setDept("weighed")}>⚖️ كل الموزون</button>
        {cats.map((c) => <button key={c.id} className={dept === c.id ? "active" : ""} onClick={() => setDept(c.id)}>{c.icon} {c.name}</button>)}
      </div>
      {shown.length === 0 ? <p className="muted">ما فيش أصناف هنا.</p> : (
        <table>
          <thead><tr><th>الصنف</th><th>الوحدة</th><th>التكلفة</th><th>السعر الحالي</th><th>السعر الجديد</th><th>الربح</th></tr></thead>
          <tbody>
            {shown.map((p) => {
              const u = base(p);
              const v = draft[u.id] ?? "";
              const price = v.trim() ? kg(v) : u.priceMinor;
              const margin = price > 0 ? Math.round(((price - p.costMinor) / price) * 100) : null;
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="muted">{u.name}</td>
                  <td className="num">{formatMoney(p.costMinor)}</td>
                  <td className="num">{formatMoney(u.priceMinor)}</td>
                  <td><input className="num" style={{ width: 110 }} inputMode="decimal" value={v} placeholder={(u.priceMinor / 1000).toFixed(3)} aria-label={`سعر ${p.name}`}
                    onChange={(e) => setDraft({ ...draft, [u.id]: e.target.value })} /></td>
                  <td className="num">{margin === null ? "—" : <span className={margin < 0 ? "badge bad" : margin < 10 ? "badge warn" : ""}>{margin}%</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="row"><span className="muted">{changed.length ? `${changed.length} سعر تغيّر` : "اكتب السعر الجديد في الخانة"}</span><span className="spacer" /><button className="primary" disabled={!changed.length} onClick={() => void save()}>حفظ الأسعار</button></div>
    </div>
  );
}

interface CutLine { productId: string; qty: string }

/**
 * A carcass in, the cuts out: the weights of each cut, what was lost on the way, and each cut's
 * cost per kilo worked out from what it sells for. The last breakdowns of the same kind fill in
 * the usual cuts.
 */
function Cut({ call, storeId, rows, reload }: { call: Call; storeId: string; rows: Row[]; reload: () => Promise<void> }) {
  const weighed = useMemo(() => rows.filter((p) => p.active && p.isWeighted), [rows]);
  const [src, setSrc] = useState("");
  const [weight, setWeight] = useState("");
  const [cost, setCost] = useState("");
  const [lines, setLines] = useState<CutLine[]>([]);
  const [usual, setUsual] = useState<{ breakdowns: number; cuts: { productId: string; name: string; shareBp: number }[] } | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [history, setHistory] = useState<Breakdown[]>([]);
  const loadHistory = () => call<Breakdown[]>(`/butcher/breakdowns?storeId=${storeId}`).then(setHistory);
  useEffect(() => void loadHistory(), [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const source = rows.find((p) => p.id === src);
  useEffect(() => {
    setUsual(null);
    if (!src) return;
    void call<NonNullable<typeof usual>>(`/butcher/usual/${src}`).then((u) => {
      setUsual(u);
      if (u.cuts.length) setLines(u.cuts.map((c) => ({ productId: c.productId, qty: "" })));
    });
  }, [src, call]);

  const w = kg(weight);
  const y = breakdownYield(w, lines.map((l) => kg(l.qty)));
  const autoCost = source ? Math.round((source.costMinor * w) / 1000) : 0;
  const costMinor = cost.trim() ? kg(cost) : autoCost;
  const ok = !!source && w > 0 && lines.length > 0 && lines.every((l) => l.productId && kg(l.qty) > 0) && y.outMilli <= w && new Set(lines.map((l) => l.productId)).size === lines.length;
  const share = (productId: string) => usual?.cuts.find((c) => c.productId === productId)?.shareBp;

  async function save() {
    setMsg(null);
    try {
      const r = await call<{ wasteMilli: number; yieldBp: number }>("/butcher/breakdowns", {
        body: { storeId, sourceProductId: src, sourceQtyMilli: w, costMinor: cost.trim() ? kg(cost) : undefined, note: note || undefined, lines: lines.map((l) => ({ productId: l.productId, qtyMilli: kg(l.qty) })) },
      });
      setMsg({ text: `تم: الناتج ${pct(r.yieldBp)}، والفاقد ${formatQty(r.wasteMilli, true)} كغ. القطع دخلت المخزون بتكلفتها.` });
      setWeight(""); setCost(""); setNote("");
      setLines((ls) => ls.map((l) => ({ ...l, qty: "" })));
      await reload();
      await loadHistory();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  return (
    <>
      <div className="card stack">
        <div className="kpis">
          <label>الذبيحة / اللي بنقطعه
            <select value={src} onChange={(e) => setSrc(e.target.value)}>
              <option value="">— اختار —</option>
              {weighed.map((p) => <option key={p.id} value={p.id}>{p.name}{p.stockMilli !== null ? ` (في المخزون ${formatQty(p.stockMilli, true)})` : ""}</option>)}
            </select>
          </label>
          <label>الوزن (كغ)<input className="num" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} /></label>
          <label>التكلفة (د.ل)<input className="num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={autoCost ? (autoCost / 1000).toFixed(3) : "من تكلفة الكيلو"} /></label>
          <label>ملاحظة<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: خروف وطني" /></label>
        </div>
        {source && (
          <>
            <b>القطع اللي طلعت</b>
            {usual && usual.breakdowns > 0 && <div className="hint">عبّينا القطع المعتادة من آخر {usual.breakdowns} تقطيع. النسبة المعتادة جنب كل قطعة.</div>}
            {lines.map((l, i) => {
              const s = share(l.productId);
              const now = w > 0 && kg(l.qty) > 0 ? Math.round((kg(l.qty) * 10000) / w) : null;
              return (
                <div className="row" key={i} style={{ flexWrap: "nowrap" }}>
                  <select value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} style={{ flex: 2 }} aria-label="القطعة">
                    <option value="">— القطعة —</option>
                    {weighed.filter((p) => p.id !== src).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input className="num" style={{ width: 100 }} inputMode="decimal" placeholder={s && w ? ((w * s) / 10000 / 1000).toFixed(2) : "كغ"} value={l.qty} aria-label="الوزن"
                    onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  <span className="muted num" style={{ minWidth: 120 }}>{now !== null ? pct(now) : ""}{s ? ` · المعتاد ${pct(s)}` : ""}</span>
                  <button className="danger" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="شيل">✕</button>
                </div>
              );
            })}
            <div><button onClick={() => setLines([...lines, { productId: "", qty: "" }])}>+ قطعة</button></div>
            {w > 0 && (
              <div className="kpis">
                <div className="kpi"><span className="muted">الناتج</span><b className="num">{formatQty(y.outMilli, true)} كغ</b><small className="muted">{pct(y.yieldBp)}</small></div>
                <div className="kpi"><span className="muted">الفاقد (عظم، شحم، ماء)</span><b className={`num ${y.outMilli > w ? "bad" : ""}`}>{y.outMilli > w ? "القطع أثقل من الذبيحة" : `${formatQty(y.wasteMilli, true)} كغ`}</b></div>
                <div className="kpi"><span className="muted">تكلفة الكيلو الصافي</span><b className="num">{y.outMilli > 0 ? formatMoney(Math.round((costMinor * 1000) / y.outMilli)) : "—"}</b></div>
              </div>
            )}
          </>
        )}
        {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
        <div className="row"><span className="muted">التكلفة تتوزع على القطع حسب سعر بيعها: الفيليه ياخذ أكثر من العظم.</span><span className="spacer" /><button className="primary" disabled={!ok} onClick={() => void save()}>سجّل التقطيع</button></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>آخر التقطيعات</h3>
        {history.length === 0 ? <p className="muted">ما فيش تقطيع لسا.</p> : (
          <table>
            <thead><tr><th>التاريخ</th><th>الذبيحة</th><th>الوزن</th><th>التكلفة</th><th>الناتج</th><th>الفاقد</th><th>القطع</th></tr></thead>
            <tbody>{history.map((b) => (
              <tr key={b.id}>
                <td className="num">{new Date(b.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{b.source_name}{b.note && <div className="muted">{b.note}</div>}</td>
                <td className="num">{formatQty(b.source_qty_milli, true)}</td>
                <td className="num">{formatMoney(b.cost_minor)}</td>
                <td className="num">{pct(b.yieldBp)}</td>
                <td className="num">{formatQty(b.wasteMilli, true)}</td>
                <td className="muted">{b.lines.map((l) => `${l.name} ${formatQty(l.qtyMilli, true)}`).join("، ")}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
