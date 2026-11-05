import { useEffect, useState, type FormEvent } from "react";
import { formatMoney } from "@pos/shared";
import type { Plan } from "./billing";
import { api } from "./api";
import { session } from "./session";
import type { Screen } from "./App";
import { prefersOwnerView } from "./owner/Owner";

const FEATURES: [string, string, string][] = [
  ["🛒", "كاشير سريع", "باركود، ميزان، عروض، تعليق فواتير، واختصارات لوحة المفاتيح"],
  ["📡", "يشتغل من غير نت", "البيع ما يوقفش لو طاح النت، ويتزامن وحده أول ما يرجع"],
  ["📦", "المخزون والتوريد", "فواتير الموردين، الصلاحية، التعبئة (صندوق، كرتونة)، والجرد"],
  ["👥", "العملاء والديون", "حدود الدين، كشف الحساب، والتذكير على الواتساب"],
  ["📲", "الفاتورة على الواتساب", "الزبون يستلم فاتورته على تلفونه برابط يفتحه ويطبعه"],
  ["📊", "التقارير والأرباح", "المبيعات والربح يوم بيوم، الأقسام، الأصناف، والكاشيرات"],
  ["📱", "محلك في جيبك", "تتابع المبيعات والتنبيهات من تلفونك وين ما كنت"],
  ["🏬", "الفروع والموظفين", "تحويلات بين الفروع، صلاحيات لكل موظف، والرواتب"],
];

const TYPES: { id: string; icon: string; name: string; ready: boolean }[] = [
  { id: "grocery", icon: "🛒", name: "بقالة / سوبرماركت", ready: true },
  { id: "other", icon: "🏪", name: "محل تجاري آخر", ready: true },
  { id: "clothing", icon: "👕", name: "ملابس وأحذية", ready: false },
  { id: "pharmacy", icon: "💊", name: "صيدلية", ready: false },
  { id: "butcher", icon: "🥩", name: "جزارة", ready: false },
  { id: "restaurant", icon: "🍽️", name: "مطعم / مقهى", ready: false },
];

/** First screen on a browser that is not a registered cashier yet: what the system is, then sign in or open a shop. */
export function Setup({ go }: { go: (s: Screen) => void }) {
  const [mode, setMode] = useState<"landing" | "login" | "register">(() => {
    const q = new URLSearchParams(location.search);
    // On a till (the owner pressed «الإدارة») or with ?login: straight to signing in.
    if (q.has("welcome")) return "landing";
    return q.has("login") || session.deviceToken ? "login" : "landing";
  });
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => void api<Plan[]>("/plans").then(setPlans).catch(() => undefined), []);
  const start = (planCode?: string) => {
    setMode("register");
    try {
      if (planCode) sessionStorage.setItem("pos.plan", planCode);
    } catch {
      /* private mode: the plan is picked again on the form */
    }
    window.scrollTo?.(0, 0);
  };
  if (mode === "login") return <Login go={go} onRegister={() => start()} onBack={() => setMode("landing")} />;
  if (mode === "register") return <Register go={go} plans={plans} onLogin={() => setMode("login")} onBack={() => setMode("landing")} />;
  return <Landing plans={plans} onStart={start} onLogin={() => setMode("login")} />;
}

function Landing({ plans, onStart, onLogin }: { plans: Plan[]; onStart: (plan?: string) => void; onLogin: () => void }) {
  return (
    <div className="landing">
      <header className="land-top">
        <b className="land-brand"><span className="logo">ن</span> نظام نقاط البيع</b>
        <span className="spacer" />
        <button onClick={onLogin}>دخول</button>
        <button className="primary" onClick={() => onStart()}>ابدأ مجاناً</button>
      </header>

      <section className="land-hero">
        <h1>نظام بيع متكامل لمحلك<br /><span>يشتغل حتى من غير نت</span></h1>
        <p>كاشير، مخزون، موردين، ديون، تقارير، وفواتير على الواتساب. من جهاز الكاشير ومن تلفونك.</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="primary big" onClick={() => onStart()}>جرّب 14 يوم مجاناً</button>
          <a className="button big" href="https://pos-demo-sale7.vercel.app" target="_blank" rel="noopener">شوف النسخة التجريبية</a>
        </div>
        <small className="muted">من غير بطاقة دفع · التسجيل ياخذ دقيقتين</small>
      </section>

      <section className="land-features">
        {FEATURES.map(([icon, title, text]) => (
          <div key={title} className="land-feature"><span>{icon}</span><b>{title}</b><small>{text}</small></div>
        ))}
      </section>

      <section className="land-steps">
        <h2>تبدأ في 3 خطوات</h2>
        <ol>
          <li><b>سجّل محلك</b><span>اسم المحل والنشاط وحسابك.</span></li>
          <li><b>ضيف أصنافك</b><span>بفاتورة توريد أو بطاقة صنف، والباركود يتعمل تلقائياً للي ما عنده.</span></li>
          <li><b>اعتمد جهاز الكاشير</b><span>أي كمبيوتر بالمتصفح أو تطبيق ويندوز، وابدأ البيع.</span></li>
        </ol>
      </section>

      {plans.length > 0 && (
        <section className="land-plans">
          <h2>الباقات</h2>
          <div className="plans">
            {plans.map((p) => (
              <div key={p.code} className="plan">
                <b>{p.name}</b>
                <span className="num plan-price">{formatMoney(p.price_minor)}<span className="muted"> / شهر</span></span>
                <span className="muted">{p.max_stores} فرع · {p.max_devices} أجهزة · {p.max_users} مستخدم</span>
                <button className="primary" onClick={() => onStart(p.code)}>ابدأ التجربة</button>
              </div>
            ))}
          </div>
          <small className="muted">أول 14 يوم مجاناً لكل الباقات. الدفع بعدها بالبطاقات المحلية أو سداد أو إدفع لي.</small>
        </section>
      )}

      <footer className="land-foot">
        <span>عندك حساب؟</span>
        <button onClick={onLogin}>دخول</button>
      </footer>
    </div>
  );
}

function Login({ go, onRegister, onBack }: { go: (s: Screen) => void; onRegister: () => void; onBack: () => void }) {
  const [f, setF] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("/auth/login", { body: f });
      session.adminToken = r.token;
      go(prefersOwnerView() ? "owner" : "admin");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center">
      <form className="card stack" style={{ width: "min(420px, 100%)" }} onSubmit={submit}>
        <button type="button" className="ghost back" onClick={onBack}>→ رجوع</button>
        <h1 style={{ margin: 0 }}>دخول</h1>
        <label>البريد الإلكتروني<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoFocus /></label>
        <label>كلمة السر<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy}>دخول</button>
        <p className="muted" style={{ margin: 0, fontSize: ".85rem" }}>بعد الدخول تقدر تعتمد هذا الجهاز ككاشير من صفحة «الأجهزة».</p>
        <div className="row"><span className="muted">ما عندكش حساب؟</span><button type="button" className="ghost" onClick={onRegister}>سجّل محلك</button></div>
      </form>
    </div>
  );
}

function Register({ go, plans, onLogin, onBack }: { go: (s: Screen) => void; plans: Plan[]; onLogin: () => void; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [f, setF] = useState(() => ({
    businessType: "grocery", businessName: "", storeName: "الفرع الرئيسي", city: "", phone: "",
    planCode: (() => { try { return sessionStorage.getItem("pos.plan") ?? "basic"; } catch { return "basic"; } })(),
    ownerName: "", email: "", password: "",
  }));
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const STEPS = ["المحل", "الباقة", "حسابك"];
  const ok = [
    f.businessName.trim().length >= 2 && f.storeName.trim().length >= 2,
    !!f.planCode,
    f.ownerName.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(f.email) && f.password.length >= 8,
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step < 2) {
      if (ok[step]) setStep(step + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("/auth/register", { body: { ...f, phone: f.phone || undefined, city: f.city || undefined } });
      session.adminToken = r.token;
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
        <button type="button" className="ghost back" onClick={() => (step ? setStep(step - 1) : onBack())}>→ رجوع</button>
        <h1 style={{ margin: 0 }}>سجّل محلك</h1>
        <ol className="wizard-steps">
          {STEPS.map((s, i) => <li key={s} className={i === step ? "active" : i < step ? "done" : ""}>{i < step ? "✓" : i + 1} {s}</li>)}
        </ol>

        {step === 0 && (
          <>
            <span>نوع النشاط</span>
            <div className="type-grid">
              {TYPES.map((t) => (
                <button type="button" key={t.id} disabled={!t.ready} className={f.businessType === t.id ? "picked" : ""} onClick={() => set({ businessType: t.id })}>
                  <span>{t.icon}</span>{t.name}{!t.ready && <small>قريباً</small>}
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
            <span>اختار الباقة <span className="badge ok">أول 14 يوم مجاناً</span></span>
            <div className="plans">
              {plans.map((p) => (
                <button type="button" key={p.code} className={`plan ${f.planCode === p.code ? "picked" : ""}`} onClick={() => set({ planCode: p.code })}>
                  <b>{p.name}</b>
                  <span className="num plan-price">{formatMoney(p.price_minor)}<span className="muted"> / شهر</span></span>
                  <span className="muted">{p.max_stores} فرع · {p.max_devices} أجهزة · {p.max_users} مستخدم</span>
                </button>
              ))}
            </div>
            <div className="muted">تقدر تغيّر الباقة بعدين من صفحة «الاشتراك». ما فيش دفع توا.</div>
          </>
        )}

        {step === 2 && (
          <>
            <label>اسمك<input value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} required minLength={2} autoFocus /></label>
            <label>البريد الإلكتروني<input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} required /></label>
            <label>كلمة السر (8 حروف أو أكثر)
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <input type={show ? "text" : "password"} value={f.password} onChange={(e) => set({ password: e.target.value })} required minLength={8} />
                <button type="button" onClick={() => setShow(!show)} aria-label="إظهار كلمة السر">{show ? "🙈" : "👁️"}</button>
              </div>
            </label>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy || !ok[step]}>{step < 2 ? "التالي" : busy ? "جاري إنشاء المحل…" : "إنشاء المحل وابدأ"}</button>
        <div className="row"><span className="muted">عندك حساب؟</span><button type="button" className="ghost" onClick={onLogin}>دخول</button></div>
      </form>
    </div>
  );
}
