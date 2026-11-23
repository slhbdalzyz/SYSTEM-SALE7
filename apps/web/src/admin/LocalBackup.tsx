// The local edition's backups: made by the server on this computer every day and after each shift,
// optionally encrypted and copied to a USB stick or a second disk, and restored from here.
import { useEffect, useState } from "react";
import { apiUpload } from "../api";
import { db } from "../localdb";
import { session } from "../session";
import type { Call } from "./Admin";

interface File { name: string; size: number; at: string; where: "local" | "extra" }
interface Status { lastAt: string | null; lastError: string | null; extraError: string | null; dir: string; extraDir: string | null; encrypted: boolean; running: boolean; warning: string | null; files: File[] }

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** After a restore the till's own copy (catalog, queued sales) belongs to the old data: start clean. */
export async function afterRestore() {
  await db.delete().catch(() => undefined);
  session.adminToken = null;
  session.staffToken = null;
  location.reload();
}

export function LocalBackup({ call }: { call: Call }) {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState("");
  const [pw, setPw] = useState("");
  const [asking, setAsking] = useState<File | null>(null);
  const [restorePw, setRestorePw] = useState("");
  const load = () => call<Status>("/local/backup").then((r) => { setS(r); setExtra(r.extraDir ?? ""); }).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreFrom(f: File) {
    setBusy(true);
    setError(null);
    try {
      await call(`/local/restore/${f.where}/${f.name}`, { body: { password: restorePw || undefined } });
      await afterRestore();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!s) return error ? <div className="error">{error}</div> : <div className="muted">جاري التحميل…</div>;
  return (
    <div className="stack">
      {s.warning && <div className="error">⚠️ {s.warning}</div>}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>💾 النسخ الاحتياطي على هذا الجهاز</h3>
        <div>النظام ياخذ نسخة كاملة من بيانات المحل وحده كل يوم، وبعد قفل كل وردية، ويخلّي آخر 30 نسخة.</div>
        <div className="row">
          <span>آخر نسخة: <b className="num">{s.lastAt ? when(s.lastAt) : "ما فيش نسخة بعد"}</b></span>
          <span className={s.encrypted ? "badge ok" : "badge off"}>{s.encrypted ? "🔒 مشفرة" : "غير مشفرة"}</span>
          <span className="spacer" />
          <button className="primary" disabled={busy || s.running} onClick={() => act(() => call("/local/backup", { method: "POST" }), "تمت النسخة ✓")}>{busy || s.running ? "جاري النسخ…" : "خذ نسخة الآن"}</button>
        </div>
        <div className="muted small" dir="ltr" style={{ textAlign: "right" }}>{s.dir}</div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>🔌 مكان ثاني للنسخ (فلاشة أو قرص ثاني)</h3>
        <div className="muted">لو خرب الجهاز، النسخة اللي على نفس الجهاز تضيع معاه. حط فلاشة أو قرص ثاني والنظام ينسخ عليه كل مرة.</div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input dir="ltr" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="E:\Sale7-Backups" style={{ flex: 1 }} />
          <button disabled={busy} onClick={() => act(() => call("/local/backup/settings", { method: "PUT", body: { extraDir: extra.trim() || null } }), extra.trim() ? "تم حفظ المكان ✓" : "تم إلغاء المكان الثاني")}>حفظ</button>
        </div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>🔒 تشفير النسخ</h3>
        <div className="muted">بكلمة سر، اللي يلقى الفلاشة ما يقدرش يفتح بيانات المحل. احفظ كلمة السر في مكان آمن: من غيرها ما تقدرش تسترجع النسخة على جهاز جديد.</div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="6 حروف أو أكثر" style={{ flex: 1 }} />
          <button disabled={busy || pw.length < 6} onClick={() => act(async () => { await call("/local/backup/settings", { method: "PUT", body: { password: pw } }); setPw(""); }, "النسخ الجاية مشفرة ✓")}>{s.encrypted ? "تغيير كلمة السر" : "تشفير النسخ"}</button>
          {s.encrypted && <button disabled={busy} onClick={() => act(() => call("/local/backup/settings", { method: "PUT", body: { password: null } }), "تم إلغاء التشفير")}>إلغاء التشفير</button>}
        </div>
      </div>

      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>↩️ استرجاع نسخة</h3>
        <div className="muted">الاسترجاع يرجّع كل بيانات المحل لوقت النسخة. اللي صار بعدها يضيع (البيانات الحالية تنحفظ على جنب للاحتياط).</div>
        {asking && (
          <div className="error stack">
            <b>متأكد تبي ترجّع المحل لنسخة {when(asking.at)}؟</b>
            <label>كلمة سر النسخ (لو النسخة مشفرة من جهاز ثاني)<input type="password" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} /></label>
            <div className="row">
              <button className="danger" disabled={busy} onClick={() => restoreFrom(asking)}>{busy ? "جاري الاسترجاع…" : "نعم، استرجع"}</button>
              <button onClick={() => setAsking(null)}>إلغاء</button>
            </div>
          </div>
        )}
        <table>
          <thead><tr><th>النسخة</th><th>الحجم</th><th>المكان</th><th /></tr></thead>
          <tbody>
            {s.files.map((f) => (
              <tr key={`${f.where}/${f.name}`}>
                <td className="num">{when(f.at)}</td>
                <td className="num">{mb(f.size)}</td>
                <td>{f.where === "extra" ? "🔌 المكان الثاني" : "💻 هذا الجهاز"}</td>
                <td><button disabled={busy} onClick={() => { setRestorePw(""); setAsking(f); }}>استرجاع</button></td>
              </tr>
            ))}
            {!s.files.length && <tr><td colSpan={4} className="muted">ما فيش نسخ بعد</td></tr>}
          </tbody>
        </table>
        <RestoreUpload token={session.adminToken} />
      </div>
      <ResetDatabase call={call} />
    </div>
  );
}

/** Clearing the database: the records only (the shop stays set up), or everything (back to the first-run setup). */
function ResetDatabase({ call }: { call: Call }) {
  const [mode, setMode] = useState<"activity" | "all" | null>(null);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const WORD = "تصفير";

  async function run() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      await call("/local/reset", { body: { mode, password } });
      if (mode === "all") {
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith("pos.")) localStorage.removeItem(k);
        } catch {
          /* storage blocked */
        }
      }
      await afterRestore();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>🧹 تصفير قاعدة البيانات</h3>
      <div className="muted">قبل التصفير ينعمل نسخة احتياطية وحدها، وتقدر ترجعلها من «استرجاع نسخة» فوق لو غيّرت رأيك.</div>
      <div className="stack" style={{ gap: 8 }}>
        <label className="row" style={{ alignItems: "flex-start", gap: 8 }}>
          <input type="radio" name="reset-mode" checked={mode === "activity"} onChange={() => setMode("activity")} style={{ width: "auto", marginTop: 4 }} />
          <span><b>مسح الحركات بس</b><br /><small className="muted">تنمسح المبيعات والمشتريات والمخزون والديون والخزينة والورديات والمصروفات. تبقى الأصناف والأسعار والعملاء والموردين والموظفين والأجهزة والإعدادات. مناسب بعد التجربة وقبل ما تبدأ الشغل الحقيقي.</small></span>
        </label>
        <label className="row" style={{ alignItems: "flex-start", gap: 8 }}>
          <input type="radio" name="reset-mode" checked={mode === "all"} onChange={() => setMode("all")} style={{ width: "auto", marginTop: 4 }} />
          <span><b>مسح كل شي</b><br /><small className="muted">ينمسح المحل بالكامل ويرجع البرنامج لشاشة «إعداد المحل» كأنه جديد. الترخيص يبقى على الجهاز.</small></span>
        </label>
      </div>
      {mode && (
        <div className="error stack">
          <b>{mode === "all" ? "كل بيانات المحل حتنمسح." : "كل الحركات حتنمسح، والأصناف تبقى بكمية صفر."}</b>
          <label>كلمة سر حسابك<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          <label>اكتب كلمة «{WORD}» للتأكيد<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <div className="row">
            <button className="danger" disabled={busy || !password || typed.trim() !== WORD} onClick={() => void run()}>{busy ? "جاري التصفير…" : "صفّر قاعدة البيانات"}</button>
            <button onClick={() => { setMode(null); setPassword(""); setTyped(""); setError(null); }}>إلغاء</button>
          </div>
          {error && <div>{error}</div>}
        </div>
      )}
    </div>
  );
}

/** A backup file from somewhere else: a USB stick, or the old computer. Also used on the first run. */
export function RestoreUpload({ token }: { token: string | null }) {
  const [file, setFile] = useState<Blob | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await apiUpload("/local/restore", file, pw ? { "x-backup-password": encodeURIComponent(pw) } : {}, token);
      await afterRestore();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <b>استرجاع من ملف (فلاشة أو جهاز قديم)</b>
      <input type="file" accept=".s7bak" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <label>كلمة سر النسخ (لو مشفرة)<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      <button type="button" className="primary" disabled={!file || busy} onClick={go}>{busy ? "جاري الاسترجاع… (ممكن ياخذ دقيقة)" : "استرجاع من الملف"}</button>
    </div>
  );
}
