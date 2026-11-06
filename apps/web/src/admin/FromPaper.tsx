import { useCallback, useEffect, useState } from "react";
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
  async function send() {
    if (!mapped?.rows.length) return;
    setBusy(true); setError(null);
    try {
      const r = await call<Result>(ENDPOINT[kind], { body: kind === "products" ? { storeId, rows: mapped.rows } : { rows: mapped.rows } });
      setResult({ ...r, lines: mapped.lines });
      setMapped(null);
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
      {result && (
        <div className="stack">
          <div className="badge ok">
            ✓ دخل {result.created}{kind === "products" ? ` صنف، منهم ${result.stocked} بكميات${result.newCategories ? `، و${result.newCategories} قسم جديد` : ""}` : kind === "customers" ? ` عميل، ديونهم ${formatMoney(result.totalMinor ?? 0)}` : ` مورد، أرصدتهم ${formatMoney(result.totalMinor ?? 0)}`}
          </div>
          {result.skipped.length > 0 && (
            <div className="notice">
              ما دخلوش {result.skipped.length} (موجودين من قبل):
              <ul style={{ margin: "4px 0 0" }}>{result.skipped.slice(0, 10).map((x) => <li key={x.row}>سطر {result.lines[x.row - 1] ?? x.row}: {x.reason}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
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
