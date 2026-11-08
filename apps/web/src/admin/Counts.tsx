import { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, formatQty, toMinor, type CatalogProduct } from "@pos/shared";
import type { Call } from "./Admin";
import { CameraScanner, hasCamera } from "../hardware/CameraScanner";

interface CountRow {
  id: string; status: "open" | "applied" | "cancelled"; note: string | null; created_at: string; applied_at: string | null;
  created_by_name: string | null; items: number; blind: boolean; purpose: "normal" | "zakat"; category_name: string | null;
}
interface Line {
  product_id: string; name: string; is_weighted: boolean; counted_milli: number; damaged_milli: number; system_milli: number | null;
  diff_milli: number | null; cost_minor: number; counted_by_name: string | null; counted_at: string;
}
interface Left { product_id: string; name: string; is_weighted: boolean; system_milli: number | null; cost_minor: number }
interface Totals { shortMinor: number; overMinor: number; damagedMinor: number; countedCostMinor: number; countedPriceMinor: number; leftWithStock: number; leftCostMinor: number }
interface Detail {
  id: string; status: CountRow["status"]; note: string | null; blind: boolean; purpose: CountRow["purpose"]; categoryName: string | null;
  created_at: string; applied_at: string | null; seesBooks: boolean; lines: Line[]; left: Left[]; totals: Totals | null;
}
interface Dept { id: string; name: string }

const STATUS = { open: ["مفتوح", ""], applied: ["مطبّق", "ok"], cancelled: ["ملغي", "off"] } as const;
const day = (s: string) => new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

/** Prints one part of the page on A4 instead of the till's receipt roll. */
export function printSheet() {
  document.body.classList.add("print-a4");
  const done = () => { document.body.classList.remove("print-a4"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1000);
}

/**
 * Stock count, made for phones in the aisles: scan (or type) an item, enter how many are on the
 * shelf, next. Several people can count at once, one department at a time, blind if wanted. At the
 * end every difference becomes one stock correction, as of the moment each item was counted.
 */
export function Counts({ call, storeId, canApply }: { call: Call; storeId: string; canApply: boolean }) {
  const [list, setList] = useState<CountRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ note: string; categoryId: string; blind: boolean } | null>(null);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<CountRow[]>(`/counts?storeId=${storeId}`).then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    void call<Dept[]>("/categories").then(setDepts).catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (!form) return;
    try {
      const r = await call<{ id: string }>("/counts", { body: { storeId, note: form.note.trim() || undefined, categoryId: form.categoryId || null, blind: form.blind } });
      setForm(null);
      setOpen(r.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (open) return <CountSheet call={call} id={open} storeId={storeId} canApply={canApply} onBack={() => { setOpen(null); void load(); }} />;
  return (
    <div className="stack">
      <div className="row">
        <span className="muted">امشي بين الرفوف بالتلفون، امسح كل صنف واكتب كم حبة فيه. أكثر من واحد يقدروا يجردوا في نفس الوقت، كل واحد من تلفونه.</span>
        <span className="spacer" />
        {!form && <button className="primary" onClick={() => setForm({ note: "", categoryId: "", blind: false })}>+ بدء جرد جديد</button>}
      </div>
      {form && (
        <div className="card stack">
          <b>جرد جديد</b>
          <div className="count-form">
            <label>اسم الجرد (اختياري)
              <input value={form.note} placeholder="مثلاً: جرد آخر الشهر" onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <label>شنو نجردوا؟
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">المحل كله</option>
                {depts.map((d) => <option key={d.id} value={d.id}>قسم {d.name}</option>)}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.blind} onChange={(e) => setForm({ ...form, blind: e.target.checked })} />
            <span>جرد أعمى: العمال ما يشوفوش الكمية اللي في النظام (أنت والمدير تشوفوها)</span>
          </label>
          <div className="row">
            <span className="spacer" />
            <button className="ghost" onClick={() => setForm(null)}>إلغاء</button>
            <button className="primary" onClick={() => void start()}>ابدأ الجرد</button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الجرد</th><th>بدأه</th><th>الأصناف</th><th>الحالة</th><th /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>ما فيش جرد لحد الآن</td></tr>}
            {list.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.purpose === "zakat" && "🕌 "}{c.note || "جرد"}
                  <div className="muted num">{day(c.created_at)}{c.category_name ? ` · قسم ${c.category_name}` : ""}{c.blind ? " · أعمى" : ""}</div>
                </td>
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
  const [bad, setBad] = useState("");
  const [add, setAdd] = useState(false);
  const [cam, setCam] = useState(false);
  const [view, setView] = useState<"counted" | "left" | "diff">("counted");
  const [zeroMissing, setZeroMissing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const qRef = useRef<HTMLInputElement>(null);
  const load = () => call<Detail>(`/counts/${id}`).then(setD).catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  useEffect(() => {
    void load();
    void call<CatalogProduct[]>(`/products?storeId=${storeId}`).then((ps) => setProducts(ps.filter((p) => p.active)));
    // Others may be counting on their phones too: keep the list fresh.
    const t = setInterval(() => void call<Detail>(`/counts/${id}`).then(setD).catch(() => undefined), 20_000);
    return () => clearInterval(t);
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
    setBad("");
    setTimeout(() => qtyRef.current?.focus(), 0);
  };
  const byCode = (code: string) => {
    for (const p of products) for (const u of p.units) if (u.barcodes.includes(code)) return choose(p, u);
    setMsg({ text: `الباركود ${code} مش مسجّل`, bad: true });
  };
  const num = (s: string) => (s.trim() === "" ? 0 : Number(s.replace(",", ".")));

  async function save() {
    if (!pick) return;
    const n = num(qty), b = num(bad);
    if (!(n >= 0) || !(b >= 0) || qty.trim() === "") return;
    const f = pick.unit.factorMilli / 1000;
    try {
      const r = await call<{ countedMilli: number; damagedMilli: number }>(`/counts/${id}/lines`, {
        method: "PUT", body: { productId: pick.p.id, countedMilli: toMinor(n * f), damagedMilli: toMinor(b * f), add },
      });
      setMsg({ text: `✓ ${pick.p.name}: ${formatQty(r.countedMilli, pick.p.isWeighted)}${r.damagedMilli ? ` + ${formatQty(r.damagedMilli, pick.p.isWeighted)} تالف` : ""}` });
      setPick(null);
      setQty("");
      setBad("");
      await load();
      setTimeout(() => qRef.current?.focus(), 0);
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  async function act(path: "apply" | "cancel", ask: string) {
    if (!confirm(ask)) return;
    try {
      const r = await call<{ changed?: number; damaged?: number }>(`/counts/${id}/${path}`, { method: "POST", body: path === "apply" ? { zeroMissing } : undefined });
      if (path === "apply") alert(`تم تطبيق الجرد. اتصلح مخزون ${r.changed ?? 0} صنف${r.damaged ? `، وطلع ${r.damaged} صنف تالف من المخزون` : ""}.`);
      onBack();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  if (!d) return <div className="muted">جاري التحميل…</div>;
  const editable = d.status === "open";
  const off = d.lines.filter((l) => (l.diff_milli ?? 0) !== 0);
  const shown = view === "diff" ? off : d.lines;
  const money = (l: Line) => Math.round(((l.diff_milli ?? 0) * l.cost_minor) / 1000);
  const t = d.totals;
  return (
    <div className="stack printable">
      <div className="row">
        <button className="ghost no-print" onClick={onBack}>→ رجوع</button>
        <b>{d.purpose === "zakat" && "🕌 "}{d.note || "جرد"}</b>
        <span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
        {d.categoryName && <span className="badge">قسم {d.categoryName}</span>}
        {d.blind && <span className="badge">جرد أعمى</span>}
        <span className="spacer" />
        <span className="muted">{d.lines.length} معدود · {d.left.length} باقي{d.seesBooks ? ` · ${off.length} فيهم فرق` : ""}</span>
        {d.seesBooks && <button className="ghost no-print" onClick={printSheet}>🖨️ طباعة</button>}
      </div>
      <div className="print-only muted">{day(d.created_at)}{d.applied_at ? ` — طُبّق ${day(d.applied_at)}` : ""}</div>

      {editable && (
        <div className="card stack no-print">
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
              <div className="count-scan count-scan-3">
                <label>كم {pick.unit.name} سليم؟
                  <input ref={qtyRef} className="num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
                </label>
                <label>تالف أو منتهي
                  <input className="num" inputMode="decimal" value={bad} placeholder="0" onChange={(e) => setBad(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
                </label>
                <button className="primary" disabled={qty.trim() === ""} onClick={() => void save()}>حفظ</button>
              </div>
              {d.lines.some((l) => l.product_id === pick.p.id) && (
                <div className="seg">
                  <button type="button" className={add ? "active" : ""} onClick={() => setAdd(true)}>➕ زيد على اللي فات (رف ثاني)</button>
                  <button type="button" className={!add ? "active" : ""} onClick={() => setAdd(false)}>بدّله</button>
                </div>
              )}
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

      {t && (
        <div className="count-totals">
          <div className="card"><span className="muted">الناقص</span><b className="num diff-down">{formatMoney(t.shortMinor)}</b></div>
          <div className="card"><span className="muted">الزايد</span><b className="num diff-up">{formatMoney(t.overMinor)}</b></div>
          <div className="card"><span className="muted">التالف والمنتهي</span><b className="num">{formatMoney(t.damagedMinor)}</b></div>
          <div className="card"><span className="muted">قيمة المعدود (تكلفة)</span><b className="num">{formatMoney(t.countedCostMinor)}</b><span className="muted num">بسعر البيع {formatMoney(t.countedPriceMinor)}</span></div>
        </div>
      )}

      <div className="seg no-print">
        <button className={view === "counted" ? "active" : ""} onClick={() => setView("counted")}>المعدود ({d.lines.length})</button>
        <button className={view === "left" ? "active" : ""} onClick={() => setView("left")}>باقي ما تعدّش ({d.left.length})</button>
        {d.seesBooks && <button className={view === "diff" ? "active" : ""} onClick={() => setView("diff")}>الفروقات ({off.length})</button>}
      </div>

      {view !== "left" ? (
        <div className="card" style={{ padding: 0 }}>
          <div className={`count-line count-head muted ${d.seesBooks ? "" : "blind"}`} style={{ fontSize: ".85rem" }}>
            <span>الصنف</span>{d.seesBooks && <span>بالنظام</span>}<span>معدود</span>{d.seesBooks && <span>الفرق</span>}
          </div>
          {shown.length === 0 && <div className="muted" style={{ padding: 20, textAlign: "center" }}>{view === "diff" ? "ما فيش فروقات 👌" : "امسح أول صنف"}</div>}
          {shown.map((l) => (
            <div className={`count-line ${d.seesBooks ? "" : "blind"}`} key={l.product_id}>
              <span>
                {l.name}
                {editable && <button className="ghost no-print" style={{ padding: "0 6px" }} aria-label="شيل" onClick={async () => { await call(`/counts/${id}/lines/${l.product_id}/delete`, { method: "POST" }); void load(); }}>✕</button>}
                <div className="muted" style={{ fontSize: ".75rem" }}>{l.counted_by_name ?? ""}{l.damaged_milli ? ` · تالف ${formatQty(l.damaged_milli, l.is_weighted)}` : ""}</div>
              </span>
              {d.seesBooks && <span className="num muted" data-l="بالنظام">{formatQty(l.system_milli ?? 0, l.is_weighted)}</span>}
              <b className="num" data-l="معدود">{formatQty(l.counted_milli, l.is_weighted)}</b>
              {d.seesBooks && (
                <b data-l="الفرق" className={`num ${(l.diff_milli ?? 0) > 0 ? "diff-up" : (l.diff_milli ?? 0) < 0 ? "diff-down" : "muted"}`}>
                  {(l.diff_milli ?? 0) > 0 ? "+" : ""}{formatQty(l.diff_milli ?? 0, l.is_weighted)}
                  {money(l) !== 0 && <div style={{ fontSize: ".75rem", fontWeight: 400 }}>{formatMoney(money(l))}</div>}
                </b>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {d.left.length === 0 && <div className="muted" style={{ padding: 20, textAlign: "center" }}>كل الأصناف تعدّت 👌</div>}
          {d.left.map((p) => {
            const prod = products.find((x) => x.id === p.product_id);
            return (
              <div className="count-line blind" key={p.product_id}>
                <span>{p.name}</span>
                {p.system_milli !== null ? <span className="num muted" data-l="بالنظام">{formatQty(p.system_milli, p.is_weighted)}</span> : <span />}
                {editable && prod ? <button className="no-print" onClick={() => { setView("counted"); choose(prod); }}>عدّه</button> : <span />}
              </div>
            );
          })}
        </div>
      )}

      {editable && d.lines.length > 0 && (
        <div className="stack no-print">
          {canApply && t && d.left.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={zeroMissing} onChange={(e) => setZeroMissing(e.target.checked)} />
              <span>الأصناف اللي ما تعدّتش ({t.leftWithStock} عندها رصيد بقيمة {formatMoney(t.leftCostMinor)}) اعتبرها خالصة وخلّي رصيدها صفر</span>
            </label>
          )}
          <div className="row">
            <span className="spacer" />
            <button className="danger" onClick={() => void act("cancel", "نلغي الجرد هذا؟ المخزون ما يتغيرش.")}>إلغاء الجرد</button>
            {canApply
              ? <button className="primary" onClick={() => void act("apply", `نطبّق الجرد؟ مخزون ${off.length} صنف يتصلح على اللي عدّيته${zeroMissing ? "، واللي ما تعدّش يصير صفر" : ""}.`)}>✓ تطبيق الجرد</button>
              : <span className="muted">التطبيق لصاحب المحل أو المدير</span>}
          </div>
        </div>
      )}
      {cam && <CameraScanner title="امسح الصنف" onClose={() => setCam(false)} onCode={(c) => { setCam(false); byCode(c); }} />}
    </div>
  );
}
