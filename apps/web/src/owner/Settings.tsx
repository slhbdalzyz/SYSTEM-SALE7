import { useEffect, useState } from "react";
import { formatMoney, fromMinor, toMinor } from "@pos/shared";
import type { Call } from "../admin/Admin";
import { session } from "../session";
import { buildBackup, downloadBlob } from "./backup";
import { disablePush, enablePush, pushEnabled, pushSupported } from "./push";

interface S { lowStock: boolean; returnOverMinor: number; discountOverMinor: number; cashDiffOverMinor: number; overCreditLimit: boolean; pushKey: string | null }

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
