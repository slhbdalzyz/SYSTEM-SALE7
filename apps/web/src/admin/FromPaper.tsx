import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, toMinor } from "@pos/shared";
import type { Call } from "./Admin";
import { SHEETS, mapSheet, readSheetFile, readNumber, templateCsv, type Mapped, type SheetKind } from "./sheet";

interface Status { products: number; stocked: number; customers: number; customers_owe: number; suppliers: number; suppliers_owed: number; cash_opening: number; sales: number }
interface Result { created: number; stocked?: number; newCategories?: number; totalMinor?: number; skipped: { row: number; reason: string }[] }

const STEP_HINT: Record<SheetKind, string> = {
  products: "كل صنف في سطر: الاسم، الباركود (لو عنده)، القسم، سعر البيع، التكلفة، والكمية اللي موجودة على الرف الآن. اللي ما عنده باركود يتعمله باركود تلقائياً، والأقسام الجديدة تتعمل وحدها.",
  customers: "انقل دفتر الديون: اسم العميل، رقمه، وقداش عليه لليوم. الدين يطلع في رصيده وكشف حسابه كـ«رصيد سابق»، ويقدر يسدد منه من الكاشير عادي.",
  suppliers: "كل مورد وقداش عليك له لليوم. يطلع في رصيده وكشف حسابه، وتسدده من صفحة الموردين.",
};
const ENDPOINT: Record<SheetKind, string> = { products: "/import/products", customers: "/import/customers", suppliers: "/import/suppliers" };

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * For a shop that worked on paper: bring in the items with what is on the shelves, the debt book,
 * what is owed to suppliers and the cash in hand, step by step, from a spreadsheet anyone can fill.
 */
export function FromPaper({ call, storeId, open }: { call: Call; storeId: string; open: (t: "products" | "counts" | "devices" | "money") => void }) {
  const [s, setS] = useState<Status | null>(null);
  const [step, setStep] = useState<SheetKind | "cash" | null>(null);
  const load = useCallback(() => call<Status>("/import/status").then(setS).catch(() => {}), [call]);
  useEffect(() => void load(), [load]);
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const steps: { key: SheetKind | "cash"; icon: string; title: string; done: boolean; info: string }[] = [
    { key: "products", icon: "📦", title: "الأصناف والكميات", done: s.products > 0, info: s.products ? `${s.products} صنف · ${s.stocked} بكميات` : "ما فيش أصناف" },
    { key: "customers", icon: "👥", title: "العملاء ودفتر الديون", done: s.customers > 0, info: s.customers ? `${s.customers} عميل · ديون قديمة ${formatMoney(s.customers_owe)}` : "ما فيش عملاء" },
    { key: "suppliers", icon: "🚚", title: "الموردين وأرصدتهم", done: s.suppliers > 0, info: s.suppliers ? `${s.suppliers} مورد · عليك لهم ${formatMoney(s.suppliers_owed)}` : "ما فيش موردين" },
    { key: "cash", icon: "💵", title: "الكاش الموجود اليوم", done: s.cash_opening > 0, info: s.cash_opening ? "مسجّل" : "قداش في الدرج والخزنة" },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <b>كنت تخدم بالدفتر؟</b>
          <span className="spacer" />
          <span className="muted">{done} من {steps.length}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          دخّل اللي عندك مرة وحدة وابدأ تبيع اليوم. عبّي القوالب في Excel (أو خلي ولدك أو المحاسب يعبيهم)، وارفعهم هنا. السطر الغلط يتعلّم عليه والباقي يدخل.
        </p>
        <div className="progress"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      </div>
      <div className="paper-steps">
        {steps.map((x, i) => (
          <button key={x.key} className={`card paper-step ${x.done ? "done" : ""} ${step === x.key ? "active" : ""}`} onClick={() => setStep(step === x.key ? null : x.key)}>
            <span className="paper-num">{x.done ? "✓" : i + 1}</span>
            <span><b>{x.icon} {x.title}</b><small className="muted">{x.info}</small></span>
          </button>
        ))}
      </div>
      {step && step !== "cash" && <ImportStep key={step} kind={step} call={call} storeId={storeId} onDone={load} />}
      {step === "cash" && <CashStep call={call} onDone={load} />}
      {done === steps.length && (
        <div className="card stack">
          <b>🎉 كل شي جاهز. الخطوات الجاية:</b>
          <div className="row wrap">
            <button onClick={() => open("counts")}>📋 جرد للتأكد من الكميات</button>
            <button onClick={() => open("devices")}>🖥️ اعتمد جهاز الكاشير</button>
            <button onClick={() => open("products")}>📦 راجع الأصناف</button>
          </div>
          <span className="muted">نصيحة: أول أسبوع خلي الدفتر جنبك، وقارن آخر النهار بين تقرير الوردية والدفتر لين تطمّن.</span>
        </div>
      )}
    </div>
  );
}

function ImportStep({ kind, call, storeId, onDone }: { kind: SheetKind; call: Call; storeId: string; onDone: () => void }) {
  const [mode, setMode] = useState<"hand" | "file">("hand");
  const [file, setFile] = useState<string | null>(null);
  const [mapped, setMapped] = useState<Mapped<Record<string, unknown>> | null>(null);
  const [result, setResult] = useState<(Result & { lines: number[] }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheet = SHEETS[kind];
  const heads = Object.values(sheet.cols).map((c) => c[0]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null); setResult(null); setMapped(null); setFile(f.name);
    try {
      setMapped(mapSheet(kind, await readSheetFile(f)));
    } catch (e) {
      console.error("sheet", e);
      setError("ما قدرناش نقراو الملف. احفظه Excel (‎.xlsx) أو CSV وجرّب مرة ثانية.");
    }
  }
  async function send(m = mapped, after?: () => void) {
    if (!m?.rows.length) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await call<Result>(ENDPOINT[kind], { body: kind === "products" ? { storeId, rows: m.rows } : { rows: m.rows } });
      setResult({ ...r, lines: m.lines });
      setMapped(null);
      after?.();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const preview = mapped?.rows.slice(0, 8) ?? [];
  const show = (r: Record<string, unknown>) =>
    kind === "products"
      ? [r.name, r.barcode ?? "تلقائي", r.category ?? "—", formatMoney(Number(r.priceMinor)), String(Number(r.qtyMilli) / 1000) + (r.weighted ? " كغ" : "")]
      : [r.name, r.phone ?? "—", formatMoney(Number(r.balanceMinor))];
  const cols = kind === "products" ? ["الصنف", "الباركود", "القسم", "السعر", "الكمية"] : ["الاسم", "الهاتف", kind === "customers" ? "الدين" : "المستحق له"];

  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{sheet.title}</h3>
      <p className="muted" style={{ margin: 0 }}>{STEP_HINT[kind]}</p>
      <div className="seg" role="group" aria-label="طريقة الإدخال" style={{ alignSelf: "start" }}>
        <button type="button" className={mode === "hand" ? "active" : ""} onClick={() => { setMode("hand"); setResult(null); }}>✍️ اكتب بيدك</button>
        <button type="button" className={mode === "file" ? "active" : ""} onClick={() => { setMode("file"); setResult(null); }}>📄 من ملف Excel</button>
      </div>
      {mode === "hand" && <HandEntry kind={kind} call={call} busy={busy} onSend={(m, clear) => void send(m, clear)} />}
      {mode === "file" && <>
      <div className="row wrap">
        <button onClick={() => download(`sale7-${kind}-template.csv`, templateCsv(kind))}>⬇️ نزّل القالب</button>
        <label className="file-pick">
          <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void pick(e.target.files?.[0])} />
          <span className="primary-like">⬆️ ارفع الملف المعبّى</span>
        </label>
        {file && <span className="muted">{file}</span>}
      </div>
      <small className="muted">أعمدة القالب: {heads.join("، ")}. الترتيب مش مهم، المهم عناوين الأعمدة.</small>
      {mapped?.missing.length ? <div className="error">ما لقيناش عمود «{mapped.missing.join("، ")}». استعمل القالب أو سمّي العمود هكي.</div> : null}
      {mapped && !mapped.missing.length && (
        <div className="stack">
          <div className="row">
            <span className="badge ok">{mapped.rows.length} سطر جاهز</span>
            {mapped.errors.length > 0 && <span className="badge bad">{mapped.errors.length} سطر فيه غلط ومش حيدخل</span>}
          </div>
          {preview.length > 0 && (
            <div style={{ overflow: "auto" }}>
              <table>
                <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{preview.map((r, i) => <tr key={i}>{show(r).map((v, j) => <td key={j} className={j ? "num" : ""}>{String(v)}</td>)}</tr>)}</tbody>
              </table>
              {mapped.rows.length > preview.length && <small className="muted">… و{mapped.rows.length - preview.length} سطر زيادة</small>}
            </div>
          )}
          {mapped.errors.length > 0 && <ul className="muted" style={{ margin: 0 }}>{mapped.errors.slice(0, 10).map((e, i) => <li key={i}>سطر {e.row}: {e.message}</li>)}</ul>}
          <div><button className="primary" disabled={busy || !mapped.rows.length} onClick={() => void send()}>{busy ? "جاري الإدخال…" : `أدخل ${mapped.rows.length} سطر`}</button></div>
        </div>
      )}
      </>}
      {result && (
        <div className="stack">
          <div className="badge ok">
            ✓ دخل {result.created}{kind === "products" ? ` صنف، منهم ${result.stocked} بكميات${result.newCategories ? `، و${result.newCategories} قسم جديد` : ""}` : kind === "customers" ? ` عميل، ديونهم ${formatMoney(result.totalMinor ?? 0)}` : ` مورد، أرصدتهم ${formatMoney(result.totalMinor ?? 0)}`}
          </div>
          {result.skipped.length > 0 && (
            <div className="notice">
              ما دخلوش {result.skipped.length} (موجودين من قبل):
              <ul style={{ margin: "4px 0 0" }}>{result.skipped.slice(0, 10).map((x) => <li key={x.row}>سطر {(result.lines[x.row - 1] ?? x.row) - (mode === "hand" ? 1 : 0)}: {x.reason}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** The columns typed by hand, per step: which template column each one fills, and how. */
const HAND: Record<SheetKind, { key: string; label: string; kind?: "num" | "money" | "check" | "list"; w?: number }[]> = {
  products: [
    { key: "name", label: "اسم الصنف *", w: 200 }, { key: "barcode", label: "الباركود", kind: "num", w: 140 }, { key: "category", label: "القسم", kind: "list", w: 140 },
    { key: "unit", label: "الوحدة", kind: "list", w: 80 }, { key: "price", label: "سعر البيع", kind: "money", w: 90 }, { key: "cost", label: "التكلفة", kind: "money", w: 90 },
    { key: "qty", label: "الكمية", kind: "num", w: 80 }, { key: "weighted", label: "بالوزن", kind: "check", w: 56 },
  ],
  customers: [{ key: "name", label: "اسم العميل *", w: 200 }, { key: "phone", label: "الهاتف", kind: "num", w: 130 }, { key: "balance", label: "الدين القديم", kind: "money", w: 110 }, { key: "limit", label: "حد الدين", kind: "money", w: 100 }],
  suppliers: [{ key: "name", label: "اسم المورد *", w: 220 }, { key: "phone", label: "الهاتف", kind: "num", w: 130 }, { key: "balance", label: "المستحق له", kind: "money", w: 120 }],
};
const UNITS = ["حبة", "علبة", "قنينة", "كيس", "كيلو", "لتر", "رغيف", "باكو"];
const blank = (n: number) => Array.from({ length: n }, () => "");
const draftKey = (k: SheetKind) => `pos.paperDraft.${k}`;

/**
 * Typing items, customers or suppliers straight in, one line each, no file needed.
 * Enter (or a barcode scanner) moves to the next box; a new line opens by itself.
 */
function HandEntry({ kind, call, busy, onSend }: { kind: SheetKind; call: Call; busy: boolean; onSend: (m: Mapped<Record<string, unknown>>, clear: () => void) => void }) {
  const cols = HAND[kind];
  const [grid, setGrid] = useState<string[][]>(() => {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey(kind)) ?? "null") as string[][] | null;
      if (Array.isArray(d) && d.length) return d;
    } catch { /* no saved draft */ }
    return Array.from({ length: 5 }, () => blank(cols.length));
  });
  const [cats, setCats] = useState<string[]>([]);
  const box = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (kind === "products") void call<{ name: string }[]>("/categories").then((c) => setCats(c.map((x) => x.name))).catch(() => {});
  }, [call, kind]);
  useEffect(() => {
    try { localStorage.setItem(draftKey(kind), JSON.stringify(grid)); } catch { /* private mode */ }
  }, [grid, kind]);

  const set = (r: number, c: number, v: string) =>
    setGrid((g) => {
      const next = g.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row));
      // Always keep an empty line at the end to type into.
      if (next[next.length - 1].some((x) => x.trim())) next.push(blank(cols.length));
      return next;
    });
  // Focus moves at once (a scanner types the next code right away); a line not drawn yet gets it after the render.
  const focus = (r: number, c: number) => {
    const find = () => box.current?.querySelector(`[data-cell="${r}-${c}"]`) as HTMLInputElement | null;
    const el = find();
    if (el) el.focus();
    else setTimeout(() => find()?.focus(), 0);
  };
  const onKey = (e: React.KeyboardEvent, r: number, c: number) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    let nc = c + 1;
    while (nc < cols.length && cols[nc].kind === "check") nc++;
    if (nc < cols.length) focus(r, nc);
    else { if (r + 1 >= grid.length) setGrid((g) => [...g, blank(cols.length)]); focus(r + 1, 0); }
  };
  const mapped = useMemo(() => {
    const head = cols.map((c) => (SHEETS[kind].cols as Record<string, readonly string[]>)[c.key][0]);
    return mapSheet(kind, [head, ...grid.map((row) => row.map((v, j) => (cols[j].kind === "check" ? (v ? "نعم" : "") : v)))]);
  }, [grid, cols, kind]);
  const clear = () => {
    setGrid(Array.from({ length: 5 }, () => blank(cols.length)));
    try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ }
  };
  const filled = grid.filter((r) => r.some((x) => x.trim())).length;

  return (
    <div className="stack">
      <div className="hand-grid">
        <table>
          <thead><tr><th style={{ width: 28 }}>#</th>{cols.map((c) => <th key={c.key} style={{ minWidth: c.w }}>{c.label}</th>)}<th /></tr></thead>
          <tbody ref={box}>
            {grid.map((row, r) => (
              <tr key={r}>
                <td className="muted num">{r + 1}</td>
                {cols.map((c, j) => (
                  <td key={c.key}>
                    {c.kind === "check" ? (
                      <input type="checkbox" checked={!!row[j]} onChange={(e) => set(r, j, e.target.checked ? "1" : "")} aria-label={`${c.label} سطر ${r + 1}`} />
                    ) : (
                      <input data-cell={`${r}-${j}`} value={row[j]} className={c.kind === "num" || c.kind === "money" ? "num" : ""}
                        inputMode={c.key === "barcode" || c.key === "phone" ? "numeric" : c.kind === "num" || c.kind === "money" ? "decimal" : undefined}
                        list={c.kind === "list" ? `hand-${c.key}` : undefined} placeholder={r === 0 && c.key === "barcode" ? "امسح أو فاضي" : undefined}
                        onChange={(e) => set(r, j, e.target.value)} onKeyDown={(e) => onKey(e, r, j)} aria-label={`${c.label} سطر ${r + 1}`} />
                    )}
                  </td>
                ))}
                <td>{row.some((x) => x.trim()) && <button className="ghost" aria-label={`امسح سطر ${r + 1}`} onClick={() => setGrid((g) => (g.length > 1 ? g.filter((_, i) => i !== r) : [blank(cols.length)]))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="hand-category">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        <datalist id="hand-unit">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
      </div>
      <small className="muted">Enter ينقلك للخانة اللي بعدها، والسطر الجديد يتفتح وحده. اللي تكتبه يتحفظ في الجهاز لين تدخله، حتى لو قفلت الصفحة.</small>
      <div className="row wrap">
        {mapped.rows.length > 0 && <span className="badge ok">{mapped.rows.length} سطر جاهز</span>}
        {mapped.errors.length > 0 && <span className="badge bad">{mapped.errors.length} فيه غلط</span>}
        <span className="spacer" />
        {filled > 0 && <button className="ghost" onClick={() => confirm("نمسح كل اللي كتبته؟") && clear()}>مسح الكل</button>}
        <button className="primary" disabled={busy || !mapped.rows.length || mapped.errors.length > 0} onClick={() => onSend(mapped, clear)}>{busy ? "جاري الإدخال…" : `أدخل ${mapped.rows.length || ""} سطر`}</button>
      </div>
      {mapped.errors.length > 0 && <ul className="error" style={{ margin: 0, paddingInlineStart: 24 }}>{mapped.errors.slice(0, 8).map((e, i) => <li key={i}>سطر {e.row - 1}: {e.message}</li>)}</ul>}
    </div>
  );
}

function CashStep({ call, onDone }: { call: Call; onDone: () => void }) {
  const [cash, setCash] = useState("");
  const [bank, setBank] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  async function save() {
    setMsg(null);
    try {
      for (const [account, v] of [["cash", cash], ["transfer", bank]] as const) {
        const n = readNumber(v);
        if (Number.isFinite(n) && n > 0) await call("/money/movements", { body: { account, kind: "opening", amountMinor: toMinor(n), note: "رصيد أول المدة" } });
      }
      setMsg({ text: "✓ تسجّل. تقدر تشوفه في «الخزينة والأرصدة»." });
      onDone();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>💵 الكاش الموجود اليوم</h3>
      <p className="muted" style={{ margin: 0 }}>عدّ الكاش اللي في الدرج والخزنة، واكتب رصيد الحساب المصرفي لو تبي. من هنا تبدأ الخزينة تحسب وحدها.</p>
      <div className="row wrap" style={{ alignItems: "end" }}>
        <label>الكاش (د.ل)<input className="num" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} style={{ maxWidth: 160 }} /></label>
        <label>الحساب المصرفي (د.ل)<input className="num" inputMode="decimal" value={bank} onChange={(e) => setBank(e.target.value)} style={{ maxWidth: 160 }} /></label>
        <button className="primary" disabled={!(readNumber(cash) > 0 || readNumber(bank) > 0)} onClick={() => void save()}>حفظ</button>
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
    </div>
  );
}
