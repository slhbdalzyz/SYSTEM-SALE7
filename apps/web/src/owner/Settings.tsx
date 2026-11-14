import { useEffect, useState } from "react";
import { formatMoney, fromMinor, toMinor } from "@pos/shared";
import type { Call } from "../admin/Admin";
import { session } from "../session";
import { buildBackup, commitRestore, downloadBlob, readManifest, uploadBackup, type BackupManifest } from "./backup";
import { disablePush, enablePush, pushEnabled, pushSupported } from "./push";

interface S { lowStock: boolean; returnOverMinor: number; discountOverMinor: number; cashDiffOverMinor: number; overCreditLimit: boolean; expiryDays: number; pushKey: string | null }

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Phone notifications on this phone. */
export function PushToggle({ call, pushKey }: { call: Call; pushKey: string | null }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void pushEnabled().then(setOn), []);

  if (!pushKey) return <div className="muted small">إشعارات التلفون تشتغل لما ينشر النظام على السيرفر. لين توا التنبيهات تظهر في صفحة التنبيهات.</div>;
  if (!pushSupported()) {
    return <div className="muted small">{isIos() && !standalone() ? "على الآيفون: افتح الموقع في Safari، واضغط زر المشاركة ثم «إضافة إلى الشاشة الرئيسية»، وافتحه من هناك باش تشتغل الإشعارات." : "المتصفح هذا ما يدعمش الإشعارات."}</div>;
  }
  async function toggle() {
    setError(null);
    try {
      if (on) await disablePush(call);
      else await enablePush(call, pushKey!);
      setOn(await pushEnabled());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="stack">
      <div className="row">
        <span>إشعارات على التلفون هذا</span>
        <span className="spacer" />
        <button className={on ? "" : "primary"} onClick={toggle} disabled={on === null}>{on ? "إيقاف" : "تفعيل"}</button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function AlertSettings({ call, isOwner }: { call: Call; isOwner: boolean }) {
  const [s, setS] = useState<S | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void call<S>("/alerts/settings").then(setS).catch((e) => setError((e as Error).message)), [call]);
  if (!s) return error ? <div className="error">{error}</div> : null;

  const money = (k: "returnOverMinor" | "discountOverMinor" | "cashDiffOverMinor", label: string) => (
    <label>
      {label}
      <input inputMode="decimal" disabled={!isOwner} defaultValue={s[k] ? String(fromMinor(s[k])) : ""} placeholder="مقفول"
        onChange={(e) => setS({ ...s, [k]: toMinor(Number(e.target.value.replace(/[^\d.]/g, "")) || 0) })} />
    </label>
  );
  async function save() {
    setError(null);
    try {
      const { pushKey, ...body } = s!;
      void pushKey;
      await call("/alerts/settings", { method: "PUT", body });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="card stack">
      <b>التنبيهات</b>
      <PushToggle call={call} pushKey={s.pushKey} />
      <label className="check"><input type="checkbox" disabled={!isOwner} checked={s.lowStock} onChange={(e) => setS({ ...s, lowStock: e.target.checked })} /> صنف قرب يخلص أو خلص</label>
      <label className="check"><input type="checkbox" disabled={!isOwner} checked={s.overCreditLimit} onChange={(e) => setS({ ...s, overCreditLimit: e.target.checked })} /> زبون فات حد الدين</label>
      <div className="form-grid">
        {money("returnOverMinor", "مرتجع أكبر من (د.ل)")}
        {money("discountOverMinor", "خصم أكبر من (د.ل)")}
        {money("cashDiffOverMinor", "فرق الدرج أكبر من (د.ل)")}
        <label>
          صلاحية تخلص خلال (يوم)
          <input inputMode="numeric" disabled={!isOwner} defaultValue={s.expiryDays ? String(s.expiryDays) : ""} placeholder="مقفول"
            onChange={(e) => setS({ ...s, expiryDays: Math.min(365, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
        </label>
      </div>
      <span className="muted small">خلّي الخانة فاضية باش توقف التنبيه هذا. مثلاً: خصم أكبر من {formatMoney(20000)}.</span>
      {isOwner && <button className="primary" onClick={save}>{saved ? "تم الحفظ ✓" : "حفظ"}</button>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** The owner downloads the whole shop as one file; the tills can also keep daily copies. */
export function BackupCard() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run() {
    setError(null);
    setDone(null);
    setBusy("جاري التجهيز…");
    try {
      const b = await buildBackup(session.adminToken, (n, t) => setBusy(`جاري التنزيل… ${n} من ${t}`));
      downloadBlob(b.blob, b.name);
      setDone(`تم التنزيل: ${b.rows} سطر، ${Math.max(1, Math.round(b.blob.size / 1024))} كيلوبايت. اسم الملف ${b.name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card stack">
      <b>النسخة الاحتياطية</b>
      <span className="muted small">
        ملف فيه كل بيانات المحل: الأصناف والمبيعات والمخزن والزبائن والموردين والمصروفات. احفظه في مكان آمن.
        وتقدر تخلّي جهاز الكاشير (تطبيق ويندوز) يحفظ نسخة كل يوم بروحه في «المستندات\POS-Backups»، من صفحة الأجهزة.
      </span>
      <button className="primary" onClick={run} disabled={!!busy}>{busy ?? "تنزيل نسخة احتياطية توا"}</button>
      {done && <div className="notice">{done}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const TABLE_NAMES: [string, string][] = [["products", "صنف"], ["sales", "فاتورة"], ["customers", "زبون"], ["suppliers", "مورد"], ["purchase_invoices", "فاتورة شراء"], ["expenses", "مصروف"]];

/**
 * Puts the shop back as a backup file had it. The file is checked and uploaded first; the swap
 * happens only after the owner's password, all at once, and a copy of today's data comes first.
 */
export function RestoreCard() {
  const [file, setFile] = useState<File | null>(null);
  const [m, setM] = useState<BackupManifest | null>(null);
  const [saveFirst, setSaveFirst] = useState(true);
  const [password, setPassword] = useState("");
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function pick(f: File | undefined) {
    setError(null);
    setM(null);
    setJob(null);
    setFile(f ?? null);
    if (!f) return;
    try {
      setM(await readManifest(f));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run() {
    if (!file || !m) return;
    setError(null);
    try {
      let id = job;
      if (!id) {
        if (saveFirst) {
          setBusy("نحفظوا نسخة من البيانات الحالية…");
          const now = await buildBackup(session.adminToken);
          downloadBlob(now.blob, now.name.replace("backup-", "before-restore-"));
        }
        setBusy("نرفعوا الملف…");
        id = await uploadBackup(session.adminToken, file, (n, t) => setBusy(`نرفعوا الملف… ${n} من ${t}`));
        setJob(id);
      }
      setBusy("نرجّعوا البيانات…");
      await commitRestore(session.adminToken, id, password);
      setDone(true);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      // A wrong password keeps the upload; anything else starts again from the file.
      if (!/كلمة السر/.test(msg)) setJob(null);
    } finally {
      setBusy(null);
    }
  }

  const count = (name: string) => m?.tables.find((t) => t.name === name)?.rows ?? 0;
  if (done) {
    return (
      <div className="card stack">
        <b>استرجاع نسخة احتياطية</b>
        <div className="notice">تم الاسترجاع ✓ البيانات رجعت زي ما كانت يوم {m && new Date(m.createdAt).toLocaleString("en-GB")}. أجهزة الكاشير تحدّث الأصناف بروحها أول ما تتصل.</div>
        <button className="primary" onClick={() => location.reload()}>تحديث الصفحة</button>
      </div>
    );
  }
  return (
    <div className="card stack">
      <b>استرجاع نسخة احتياطية</b>
      <span className="muted small">لو صار مشكل، رجّع بيانات المحل من ملف نسخة احتياطية نزّلته قبل.</span>
      <input type="file" accept=".gz,.ndjson,application/gzip,application/x-ndjson" disabled={!!busy} onChange={(e) => pick(e.target.files?.[0])} />
      {m && (
        <>
          <div className="small">
            النسخة من يوم <b>{new Date(m.createdAt).toLocaleString("en-GB")}</b>، فيها{" "}
            {TABLE_NAMES.filter(([n]) => count(n)).map(([n, label]) => `${count(n)} ${label}`).join("، ") || "بيانات قليلة"}.
          </div>
          <div className="notice">
            الاسترجاع يرجّع المحل زي ما كان في التاريخ هذا: أي مبيعات أو أصناف أو مشتريات صارت بعده تنمسح.
            قبل ما تبدا، تأكد إن كل أجهزة الكاشير متصلة وبعتت مبيعاتها. كلمات السر والاشتراك ما يتغيروش.
          </div>
          <label className="check"><input type="checkbox" checked={saveFirst} disabled={!!busy || !!job} onChange={(e) => setSaveFirst(e.target.checked)} /> نزّل نسخة من البيانات الحالية قبل</label>
          <label>
            كلمة السر متاعك للتأكيد
            <input type="password" autoComplete="current-password" value={password} disabled={!!busy} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="danger" onClick={run} disabled={!!busy || !password}>{busy ?? "استرجاع النسخة"}</button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
