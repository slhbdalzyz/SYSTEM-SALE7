// The local edition's first screen. On the first run there is no shop on this computer yet:
// a short setup makes it, with the owner's account and PIN, and makes this computer its till.
// After that it is the owner's sign-in (the till itself opens on the PIN screen).
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { db } from "./localdb";
import { session } from "./session";
import type { Screen } from "./App";
import { TYPES } from "./Setup";
import { RestoreUpload } from "./admin/LocalBackup";
import { invoke, isDesktopApp } from "./hardware/printer";

export function LocalSetup({ go, login }: { go: (s: Screen) => void; login: JSX.Element }) {
  const [status, setStatus] = useState<{ shop: { name: string } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ shop: { name: string } | null }>("/local/status").then(setStatus).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <StartError error={error} />;
  if (!status) return <div className="center"><div className="card">جاري تشغيل النظام على الجهاز…</div></div>;
  return status.shop ? login : <FirstRun go={go} />;
}

/** The server did not start: say where its log is, so the shop can send it to support. */
function StartError({ error }: { error: string }) {
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktopApp()) return;
    invoke<{ log_file: string } | null>("local_info", {}).then((i) => setLog(i?.log_file ?? null)).catch(() => undefined);
  }, []);
  return (
    <div className="center">
      <div className="card stack" style={{ width: "min(460px, 100%)" }}>
        <div className="error">ما قدرناش نشغّلوا قاعدة البيانات على الجهاز: {error}</div>
        {log && (
          <div className="muted" style={{ fontSize: ".9rem" }}>
            ابعت للدعم آخر الأسطر من هذا الملف: <code dir="ltr" style={{ userSelect: "all" }}>{log}</code>
          </div>
        )}
        <button onClick={() => location.reload()}>إعادة المحاولة</button>
      </div>
    </div>
  );
}

function FirstRun({ go }: { go: (s: Screen) => void }) {
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ businessType: "grocery", businessName: "", storeName: "الفرع الرئيسي", city: "", phone: "", ownerName: "", email: "", password: "", pin: "", deviceName: "كاشير 1" });
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const STEPS = ["المحل", "حسابك"];
  const ok = [
    f.businessName.trim().length >= 2 && f.storeName.trim().length >= 2,
    f.ownerName.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(f.email) && f.password.length >= 8 && /^\d{4,8}$/.test(f.pin) && f.deviceName.trim().length >= 1,
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step < 1) {
      if (ok[step]) setStep(step + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; storeId: string }>("/auth/register", {
        body: { businessType: f.businessType, businessName: f.businessName, storeName: f.storeName, city: f.city || undefined, phone: f.phone || undefined, ownerName: f.ownerName, email: f.email, password: f.password },
      });
      session.adminToken = r.token;
      const me = await api<{ user: { id: string } }>("/me", { token: r.token });
      await api(`/users/${me.user.id}`, { method: "PATCH", body: { pin: f.pin }, token: r.token });
      // This computer is the shop's till from the start.
      const d = await api<{ id: string; prefix: string; deviceToken: string }>("/devices", { body: { storeId: r.storeId, name: f.deviceName, kind: "pos" }, token: r.token });
      await db.delete();
      await db.open();
      session.deviceToken = d.deviceToken;
      session.device = { id: d.id, name: f.deviceName, prefix: d.prefix, storeName: f.storeName };
      session.staffToken = null;
      session.deviceKind = "pos";
      go("admin");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card stack wizard" onSubmit={submit}>
        {step > 0 && <button type="button" className="ghost back" onClick={() => setStep(step - 1)}>→ رجوع</button>}
        <h1 style={{ margin: 0 }}>إعداد المحل على هذا الجهاز</h1>
        <div className="muted">النظام يشتغل على هذا الكمبيوتر من غير نت، وكل البيانات تتخزن عليه.</div>
        <ol className="wizard-steps">
          {STEPS.map((s, i) => <li key={s} className={i === step ? "active" : i < step ? "done" : ""}>{i < step ? "✓" : i + 1} {s}</li>)}
        </ol>

        {step === 0 && (
          <>
            <span>نوع النشاط</span>
            <div className="type-grid">
              {TYPES.map((t) => (
                <button type="button" key={t.id} disabled={!t.ready} className={f.businessType === t.id ? "picked" : ""} onClick={() => set({ businessType: t.id })}>
                  <span>{t.icon}</span>{t.name}
                </button>
              ))}
            </div>
            <div className="form-grid">
              <label>اسم المحل<input value={f.businessName} onChange={(e) => set({ businessName: e.target.value })} required minLength={2} maxLength={120} autoFocus placeholder="مثلاً: سوبرماركت النور" /></label>
              <label>اسم الفرع<input value={f.storeName} onChange={(e) => set({ storeName: e.target.value })} required minLength={2} maxLength={120} /></label>
              <label>المدينة<input value={f.city} onChange={(e) => set({ city: e.target.value })} maxLength={80} placeholder="طرابلس" /></label>
              <label>هاتف المحل<input className="num" type="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={40} placeholder="09xxxxxxxx" /></label>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="form-grid">
              <label>اسمك<input value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} required minLength={2} autoFocus /></label>
              <label>البريد الإلكتروني (للدخول للإدارة)<input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} required /></label>
              <label>كلمة السر (8 حروف أو أكثر)
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input type={show ? "text" : "password"} value={f.password} onChange={(e) => set({ password: e.target.value })} required minLength={8} />
                  <button type="button" onClick={() => setShow(!show)} aria-label="إظهار كلمة السر">{show ? "🙈" : "👁️"}</button>
                </div>
              </label>
              <label>رقمك السري للكاشير (4 لين 8 أرقام)<input className="num" inputMode="numeric" type="password" value={f.pin} onChange={(e) => set({ pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} required /></label>
              <label>اسم هذا الجهاز<input value={f.deviceName} onChange={(e) => set({ deviceName: e.target.value })} required maxLength={60} /></label>
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy || !ok[step]}>{step < 1 ? "التالي" : busy ? "جاري إعداد المحل…" : "إنشاء المحل وابدأ"}</button>
        {step === 0 && (
          restoring ? (
            <div className="card stack"><RestoreUpload token={null} /><button type="button" className="ghost" onClick={() => setRestoring(false)}>إلغاء</button></div>
          ) : (
            <div className="row"><span className="muted">نقلت من جهاز قديم؟</span><button type="button" className="ghost" onClick={() => setRestoring(true)}>استرجع نسخة احتياطية</button></div>
          )
        )}
      </form>
    </div>
  );
}
