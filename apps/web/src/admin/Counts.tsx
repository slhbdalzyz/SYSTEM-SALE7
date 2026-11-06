import { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import type { Call } from "./Admin";
import { CameraScanner, hasCamera } from "../hardware/CameraScanner";

interface CountRow { id: string; status: "open" | "applied" | "cancelled"; note: string | null; created_at: string; applied_at: string | null; created_by_name: string | null; items: number }
interface Line { product_id: string; name: string; is_weighted: boolean; counted_milli: number; system_milli: number; diff_milli: number; cost_minor: number }
interface Detail { id: string; status: CountRow["status"]; note: string | null; lines: Line[] }

const STATUS = { open: ["مفتوح", ""], applied: ["مطبّق", "ok"], cancelled: ["ملغي", "off"] } as const;
const day = (s: string) => new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

/**
 * Stock count, made for a phone in the aisle: scan (or type) an item, enter how many are on the
 * shelf, next. At the end every difference becomes one stock correction.
 */
export function Counts({ call, storeId, canApply }: { call: Call; storeId: string; canApply: boolean }) {
  const [list, setList] = useState<CountRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<CountRow[]>(`/counts?storeId=${storeId}`).then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    const note = prompt("اسم الجرد (اختياري)، مثلاً: جرد آخر الشهر أو رف المشروبات") ?? undefined;
    if (note === undefined) return;
    try {
      const r = await call<{ id: string }>("/counts", { body: { storeId, note: note || undefined } });
      setOpen(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (open) return <CountSheet call={call} id={open} storeId={storeId} canApply={canApply} onBack={() => { setOpen(null); void load(); }} />;
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">امشي بين الرفوف بالتلفون، امسح كل صنف واكتب كم حبة فيه. في الآخر تطبّق الجرد ويتصلح المخزون.</span>
        <span className="spacer" />
        <button className="primary" onClick={start}>+ بدء جرد جديد</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الجرد</th><th>بدأه</th><th>الأصناف</th><th>الحالة</th><th /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>ما فيش جرد لحد الآن</td></tr>}
            {list.map((c) => (
              <tr key={c.id}>
                <td>{c.note || "جرد"}<div className="muted num">{day(c.created_at)}</div></td>
                <td>{c.created_by_name ?? "—"}</td>
                <td className="num">{c.items}</td>
                <td><span className={`badge ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
                <td><button onClick={() => setOpen(c.id)}>{c.status === "open" ? "كمّل" : "عرض"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountSheet({ call, id, storeId, canApply, onBack }: { call: Call; id: string; storeId: string; canApply: boolean; onBack: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<{ p: CatalogProduct; unit: { name: string; factorMilli: number } } | null>(null);
  const [qty, setQty] = useState("");
  const [add, setAdd] = useState(false);
  const [cam, setCam] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const load = () => call<Detail>(`/counts/${id}`).then(setD).catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  useEffect(() => {
    void load();
    void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then((ps) => setProducts(ps.filter((p) => p.active)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2 || /^\d{6,}$/.test(s)) return [];
    return products.filter((p) => p.name.toLowerCase().includes(s)).slice(0, 8);
  }, [q, products]);

  const choose = (p: CatalogProduct, unit = p.units.find((u) => u.isBase) ?? p.units[0]) => {
    setPick({ p, unit });
    setQ("");
    const had = d?.lines.find((l) => l.product_id === p.id);
    setAdd(!!had);
    setQty("");
    setTimeout(() => qtyRef.current?.focus(), 0);
  };
  const byCode = (code: string) => {
    for (const p of products) for (const u of p.units) if (u.barcodes.includes(code)) return choose(p, u);
    setMsg({ text: `الباركود ${code} مش مسجّل`, bad: true });
  };

  async function save() {
    if (!pick) return;
    const n = Number(qty.replace(",", "."));
    if (!(n >= 0) || qty.trim() === "") return;
    try {
      const r = await call<{ countedMilli: number }>(`/counts/${id}/lines`, { method: "PUT", body: { productId: pick.p.id, countedMilli: toMinor(n * (pick.unit.factorMilli / 1000)), add } });
      setMsg({ text: `✓ ${pick.p.name}: ${formatQty(r.countedMilli, pick.p.isWeighted)}` });
      setPick(null);
      setQty("");
      await load();
      setTimeout(() => qRef.current?.focus(), 0);
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function act(path: string, ask: string) {
    if (!confirm(ask)) return;
    try {
      const r = await call<{ changed?: number }>(`/counts/${id}/${path}`, { method: "POST" });
      if (path === "apply") alert(`تم تطبيق الجرد. اتصلح مخزون ${r.changed ?? 0} صنف.`);
      onBack();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  if (!d) return <div className="muted">جاري التحميل…</div>;
  const editable = d.status === "open";
  const off = d.lines.filter((l) => l.diff_milli !== 0);
  const value = off.reduce((a, l) => a + Math.round((l.diff_milli * l.cost_minor) / 1000), 0);
  return (
    <div className="stack">
      <div className="row">
        <button className="ghost" onClick={onBack}>→ رجوع</button>
        <b>{d.note || "جرد"}</b>
        <span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
        <span className="spacer" />
        <span className="muted">{d.lines.length} صنف معدود · {off.length} فيهم فرق</span>
      </div>

      {editable && (
        <div className="card stack">
          {!pick ? (
            <div className="count-scan" style={{ gridTemplateColumns: hasCamera() ? "1fr auto" : "1fr" }}>
              <label>امسح الباركود أو اكتب اسم الصنف
                <input ref={qRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} inputMode="search"
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (/^\d{6,}$/.test(q.trim())) { byCode(q.trim()); setQ(""); } else if (matches[0]) choose(matches[0]); } }} />
              </label>
              {hasCamera() && <button className="primary" onClick={() => setCam(true)}>📷 كاميرا</button>}
            </div>
          ) : (
            <div className="stack">
              <div className="row"><b>{pick.p.name}</b><span className="muted">· بالـ{pick.unit.name}</span><span className="spacer" /><button className="ghost" onClick={() => setPick(null)}>✕</button></div>
              <div className="count-scan">
                <label>كم {pick.unit.name} موجود؟
                  <input ref={qtyRef} className="num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
                </label>
                {d.lines.some((l) => l.product_id === pick.p.id) && (
                  <div className="seg">
                    <button type="button" className={add ? "active" : ""} onClick={() => setAdd(true)}>➕ زيد على اللي فات</button>
                    <button type="button" className={!add ? "active" : ""} onClick={() => setAdd(false)}>بدّله</button>
                  </div>
                )}
                <button className="primary" disabled={qty.trim() === ""} onClick={() => void save()}>حفظ</button>
              </div>
            </div>
          )}
          {matches.length > 0 && !pick && (
            <div className="stack" style={{ gap: 4 }}>
              {matches.map((p) => <button key={p.id} style={{ textAlign: "start" }} onClick={() => choose(p)}>{p.name}</button>)}
            </div>
          )}
          {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="count-line count-head muted" style={{ fontSize: ".85rem" }}><span>الصنف</span><span>بالنظام</span><span>معدود</span><span>الفرق</span></div>
        {d.lines.length === 0 && <div className="muted" style={{ padding: 20, textAlign: "center" }}>امسح أول صنف</div>}
        {d.lines.map((l) => (
          <div className="count-line" key={l.product_id}>
            <span>{l.name}{editable && <button className="ghost" style={{ padding: "0 6px" }} aria-label="شيل" onClick={async () => { await call(`/counts/${id}/lines/${l.product_id}/delete`, { method: "POST" }); void load(); }}>✕</button>}</span>
            <span className="num muted" data-l="بالنظام">{formatQty(l.system_milli, l.is_weighted)}</span>
            <b className="num" data-l="معدود">{formatQty(l.counted_milli, l.is_weighted)}</b>
            <b data-l="الفرق" className={`num ${l.diff_milli > 0 ? "diff-up" : l.diff_milli < 0 ? "diff-down" : "muted"}`}>{l.diff_milli > 0 ? "+" : ""}{formatQty(l.diff_milli, l.is_weighted)}</b>
          </div>
        ))}
      </div>

      {editable && d.lines.length > 0 && (
        <div className="row">
          <span className="muted">قيمة الفرق بالتكلفة: <b className={`num ${value < 0 ? "diff-down" : ""}`}>{formatMoney(value)}</b></span>
          <span className="spacer" />
          <button className="danger" onClick={() => void act("cancel", "نلغي الجرد هذا؟ المخزون ما يتغيرش.")}>إلغاء الجرد</button>
          {canApply
            ? <button className="primary" onClick={() => void act("apply", `نطبّق الجرد؟ مخزون ${off.length} صنف يتصلح على اللي عدّيته.`)}>✓ تطبيق الجرد</button>
            : <span className="muted">التطبيق لصاحب المحل أو المدير</span>}
        </div>
      )}
      {cam && <CameraScanner title="امسح الصنف" onClose={() => setCam(false)} onCode={(c) => { setCam(false); byCode(c); }} />}
    </div>
  );
}
