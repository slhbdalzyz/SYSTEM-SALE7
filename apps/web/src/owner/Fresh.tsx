// «📦 نسخ جزء من البيانات» and «🧹 بداية جديدة»: saving the items, customers and suppliers as
// Excel files that «من الدفتر للنظام» reads back, and wiping the shop's data to start again.
import { useEffect, useState } from "react";
import { LOCAL } from "../api";
import { db } from "../localdb";
import { session } from "../session";
import type { Call } from "../admin/Admin";
import { headersOf, writeXlsx } from "../admin/sheet";
import { buildBackup, downloadBlob } from "./backup";

export type ExportPart = "products_qty" | "products" | "customers" | "suppliers";
const PART_LABEL: Record<ExportPart, string> = {
  products_qty: "الأصناف بالكميات",
  products: "الأصناف بدون كميات",
  customers: "العملاء بديونهم",
  suppliers: "الموردين بأرصدتهم",
};
const FILE: Record<ExportPart, string> = { products_qty: "items-with-stock", products: "items", customers: "customers", suppliers: "suppliers" };

/** Minor units (thousandths) as the sheet writes them: 4500 → 4.5. */
const n3 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v) / 1000);
const yes = (b: boolean) => (b ? "نعم" : "لا");
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

interface ProductRow {
  name: string; category: string | null; weighted: boolean; service: boolean; cost_minor: number; min_stock_milli: number; unit: string; price_minor: number;
  barcode: string | null; pack: string | null; pack_factor: number | null; pack_price: number | null; pack_barcode: string | null; qty: number;
}
interface PersonRow { name: string; phone: string | null; balance: number; limit_minor?: number | null }

/** Builds one part as an .xlsx in the template's columns. */
export async function exportPart(call: Call, storeId: string, part: ExportPart): Promise<{ blob: Blob; name: string; rows: number }> {
  let rows: (string | number | null)[][];
  if (part === "products" || part === "products_qty") {
    const withQty = part === "products_qty";
    const r = await call<{ rows: ProductRow[] }>(`/export/products?storeId=${storeId}&qty=${withQty ? 1 : 0}`);
    rows = [headersOf("products"), ...r.rows.map((p) => [
      p.name, p.barcode ?? "", p.category ?? "", p.unit, p.pack ?? "", p.pack ? n3(p.pack_factor) : null, p.pack ? n3(p.pack_price) : null, p.pack_barcode ?? "",
      n3(p.price_minor), n3(p.cost_minor), withQty && !p.service ? n3(p.qty) : null, p.min_stock_milli ? n3(p.min_stock_milli) : null, yes(p.weighted), yes(p.service),
    ])];
  } else {
    const r = await call<{ rows: PersonRow[] }>(`/export/${part}`);
    rows = [headersOf(part), ...r.rows.map((c) => (part === "customers" ? [c.name, c.phone ?? "", n3(c.balance), c.limit_minor ? n3(c.limit_minor) : null] : [c.name, c.phone ?? "", n3(c.balance)]))];
  }
  return { blob: writeXlsx(PART_LABEL[part], rows), name: `${FILE[part]}-${stamp()}.xlsx`, rows: rows.length - 1 };
}

export function ExportCard({ call, storeId, storeName }: { call: Call; storeId: string; storeName: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(parts: ExportPart[]) {
    setError(null);
    setDone(null);
    try {
      const out: string[] = [];
      for (const p of parts) {
        setBusy(`نجهّزوا ${PART_LABEL[p]}…`);
        const f = await exportPart(call, storeId, p);
        downloadBlob(f.blob, f.name);
        out.push(`${PART_LABEL[p]}: ${f.rows}`);
      }
      setDone(`تم التنزيل ✓ ${out.join("، ")}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card stack">
      <b>📦 نسخ جزء من البيانات</b>
      <span className="muted small">
        كل جزء ينزل ملف Excel بنفس شكل «من الدفتر للنظام»، فترجّعه من هناك وحده متى ما تبي، حتى بعد «بداية جديدة».
        الكميات من فرع «{storeName}».
      </span>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {(Object.keys(PART_LABEL) as ExportPart[]).map((p) => <button key={p} onClick={() => run([p])} disabled={!!busy}>{PART_LABEL[p]}</button>)}
        <button className="primary" onClick={() => run(["products_qty", "customers", "suppliers"])} disabled={!!busy}>{busy ?? "الكل مرة وحدة"}</button>
      </div>
      <span className="muted small">الفواتير ما ترجعش من Excel: ترجع من ملف النسخة الاحتياطية، من «استرجاع جزء من النسخة».</span>
      {done && <div className="notice">{done}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

type Mode = "moves" | "stock" | "all";
const MODES: { id: Mode; title: string; text: string }[] = [
  { id: "moves", title: "مسح الحركات بس", text: "تنمسح المبيعات والفواتير والمشتريات والمصروفات والدفعات. الأصناف والعملاء والموردين يبقوا، والكميات وديون العملاء وأرصدة الموردين والخزينة تبقى زي ما هي كرصيد أول." },
  { id: "stock", title: "مسح الحركات وتصفير المخزون", text: "زي اللي قبله، لكن كميات كل الأصناف تبدا من صفر. الأسعار والديون والخزينة تبقى." },
  { id: "all", title: "مسح كل البيانات", text: "تنمسح الأصناف والأقسام والعملاء والموردين وكل الحركات، والمحل يرجع زي أول يوم." },
];

interface Preview { products: number; customers: number; suppliers: number; sales: number; purchases: number; openShifts: number }

/** Clears this device's own copy (catalog, queued sales) and signs in again. */
async function startClean() {
  await db.delete().catch(() => undefined);
  session.adminToken = null;
  session.staffToken = null;
  location.reload();
}

export function ResetCard({ call, storeId }: { call: Call; storeId: string }) {
  const [p, setP] = useState<Preview | null>(null);
  const [mode, setMode] = useState<Mode>("moves");
  const [keep, setKeep] = useState<Record<ExportPart, boolean>>({ products_qty: true, products: false, customers: true, suppliers: true });
  const [password, setPassword] = useState("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => void call<Preview>("/reset/preview").then(setP).catch((e) => setError((e as Error).message)), [call]);

  async function run() {
    setError(null);
    try {
      // A full copy first, always: whatever happens next, nothing is lost.
      setBusy("ناخذوا نسخة احتياطية كاملة…");
      const b = await buildBackup(session.adminToken);
      downloadBlob(b.blob, b.name.replace("backup-", "before-reset-"));
      if (LOCAL) await call("/local/backup", { body: {} });
      for (const part of (Object.keys(keep) as ExportPart[]).filter((k) => keep[k])) {
        setBusy(`نحفظوا ${PART_LABEL[part]}…`);
        const f = await exportPart(call, storeId, part);
        downloadBlob(f.blob, f.name);
      }
      setBusy("نصفّروا…");
      await call("/reset", { body: { mode, password, confirm: word } });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return (
      <div className="card stack">
        <b>🧹 بداية جديدة</b>
        <div className="notice">تم التصفير ✓ الملفات اللي نزلت فيها نسختك القديمة. أجهزة الكاشير تحدّث بياناتها بروحها أول ما تتصل.</div>
        <button className="primary" onClick={startClean}>تحديث الصفحة</button>
      </div>
    );
  }
  return (
    <div className="card stack">
      <b>🧹 بداية جديدة</b>
      <span className="muted small">
        تمسح بيانات المحل وتبدا من جديد. الحساب والموظفين والفروع والأجهزة والإعدادات والاشتراك ما يتمسحوش.
        {p && ` توا عندك ${p.products} صنف، ${p.customers} عميل، ${p.suppliers} مورد، ${p.sales} فاتورة بيع، ${p.purchases} فاتورة شراء.`}
      </span>
      {MODES.map((m) => (
        <label key={m.id} className="check" style={{ alignItems: "flex-start" }}>
          <input type="radio" name="reset-mode" checked={mode === m.id} disabled={!!busy} onChange={() => setMode(m.id)} />
          <span><b>{m.title}</b><br /><span className="muted small">{m.text}</span></span>
        </label>
      ))}
      <div className="stack" style={{ gap: 4 }}>
        <span className="small">قبل المسح ينزل ملف النسخة الاحتياطية الكاملة دايماً، ومعاه:</span>
        {(Object.keys(PART_LABEL) as ExportPart[]).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={keep[k]} disabled={!!busy} onChange={(e) => setKeep({ ...keep, [k]: e.target.checked })} /> {PART_LABEL[k]} (Excel)</label>
        ))}
      </div>
      {p && p.openShifts > 0 && <div className="error">فيه {p.openShifts} وردية مفتوحة. سكّرها وخلّي أجهزة الكاشير تبعت مبيعاتها قبل التصفير.</div>}
      <div className="notice">ما فيش رجعة بعد التصفير إلا من الملفات اللي تنزل. تأكد إن كل أجهزة الكاشير بعتت مبيعاتها.</div>
      <label>
        كلمة السر متاعك
        <input type="password" autoComplete="current-password" value={password} disabled={!!busy} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        اكتب كلمة «تصفير» للتأكيد
        <input value={word} disabled={!!busy} onChange={(e) => setWord(e.target.value)} autoComplete="off" />
      </label>
      <button className="danger" onClick={run} disabled={!!busy || !password || word.trim() !== "تصفير" || !!p?.openShifts}>{busy ?? "صفّر البيانات"}</button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Windows app only: this computer goes back to the first-run screen. */
export function LocalWipeCard({ call }: { call: Call }) {
  const [password, setPassword] = useState("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setError(null);
    setBusy(true);
    try {
      await call("/local/wipe", { body: { password, confirm: word } });
      await startClean();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <b>↺ إعادة ضبط البرنامج على الجهاز هذا</b>
      <span className="muted small">
        يرجّع البرنامج زي ما تنزّل أول مرة: تنمسح قاعدة البيانات كاملة (المحل والموظفين والبيانات) وتطلعلك شاشة التشغيل الأولى.
        قبلها ياخذ نسخة احتياطية في مجلد النسخ، وقاعدة البيانات القديمة تنحفظ على جنب. الترخيص يبقى على الجهاز.
      </span>
      <label>
        كلمة السر متاعك
        <input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        اكتب كلمة «تصفير» للتأكيد
        <input value={word} disabled={busy} onChange={(e) => setWord(e.target.value)} autoComplete="off" />
      </label>
      <button className="danger" onClick={run} disabled={busy || !password || word.trim() !== "تصفير"}>{busy ? "نرجّعوا البرنامج…" : "إعادة ضبط"}</button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
