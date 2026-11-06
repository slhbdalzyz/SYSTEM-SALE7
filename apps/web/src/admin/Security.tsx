import { useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import type { Call } from "./Admin";

/** The QR an authenticator app scans, drawn here so the secret never leaves the page. */
function Qr({ text }: { text: string }) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return <div style={{ background: "#fff", padding: 8, borderRadius: 8, lineHeight: 0 }} dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 5, margin: 2, scalable: false }) }} />;
}

/**
 * Two-step sign-in for the admin page: with it on, a stolen password is not enough,
 * a code from the phone's authenticator app is asked for too.
 */
export function SecurityCard({ call }: { call: Call }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [off, setOff] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [hasEmail, setHasEmail] = useState(true);
  useEffect(() => void call<{ user: { email: string | null; totp_enabled?: boolean } }>("/me").then((m) => { setOn(!!m.user.totp_enabled); setHasEmail(!!m.user.email); }), [call]);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (on === null || !hasEmail) return null;
  return (
    <section className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>🔐 التحقق بخطوتين</h3>
        <span className={`badge ${on ? "ok" : "off"}`}>{on ? "مفعّل" : "مش مفعّل"}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        لما تدخل للإدارة يطلب منك رمز من تطبيق في تلفونك (Google Authenticator أو Microsoft Authenticator) زيادة على كلمة السر. لو حد عرف كلمة السر ما يقدرش يدخل.
      </p>
      {done && <div className="badge ok">{done}</div>}
      {!on && !setup && <div><button className="primary" onClick={() => run(async () => { setSetup(await call("/auth/2fa/setup", { method: "POST" })); setDone(null); })}>فعّل التحقق بخطوتين</button></div>}
      {!on && setup && (
        <div className="stack">
          <div className="totp-qr">
            <b>1. افتح التطبيق وامسح الكود</b>
            <Qr text={setup.uri} />
            <span className="muted">أو اكتب المفتاح هذا يدوي:</span>
            <span className="totp-secret">{setup.secret.match(/.{1,4}/g)?.join(" ")}</span>
          </div>
          <label>2. اكتب الرمز اللي طلعلك في التطبيق
            <input className="num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ letterSpacing: 6, textAlign: "center", maxWidth: 220 }} />
          </label>
          <div className="row">
            <button onClick={() => { setSetup(null); setCode(""); }}>إلغاء</button>
            <button className="primary" disabled={code.length !== 6} onClick={() => run(async () => { await call("/auth/2fa/enable", { body: { code } }); setOn(true); setSetup(null); setCode(""); setDone("✓ تفعّل. من الدخول الجاي يطلب منك الرمز."); })}>تأكيد وتفعيل</button>
          </div>
        </div>
      )}
      {on && !off && <div><button className="danger" onClick={() => setOff(true)}>إيقاف التحقق بخطوتين</button></div>}
      {on && off && (
        <div className="row wrap" style={{ alignItems: "end" }}>
          <label>كلمة السر<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>الرمز من التطبيق<input className="num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 140 }} /></label>
          <button onClick={() => setOff(false)}>رجوع</button>
          <button className="danger" disabled={!password || code.length !== 6} onClick={() => run(async () => { await call("/auth/2fa/disable", { body: { password, code } }); setOn(false); setOff(false); setPassword(""); setCode(""); setDone("تم الإيقاف."); })}>أوقف</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
