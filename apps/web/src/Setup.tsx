import { useEffect, useState, type FormEvent } from "react";
import { formatMoney } from "@pos/shared";
import type { Plan } from "./billing";
import { api } from "./api";
import { session } from "./session";
import type { Screen } from "./App";
import { prefersOwnerView } from "./owner/Owner";

/** First screen on a browser that is not a registered cashier yet: owner signs in or opens a new account. */
export function Setup({ go }: { go: (s: Screen) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [f, setF] = useState({ email: "", password: "", businessName: "", storeName: "الفرع الرئيسي", ownerName: "", phone: "", planCode: "basic" });
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => {
    if (mode === "register" && !plans.length) void api<Plan[]>("/plans").then(setPlans).catch(() => undefined);
  }, [mode, plans.length]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === "login"
          ? await api<{ token: string }>("/auth/login", { body: { email: f.email, password: f.password } })
          : await api<{ token: string }>("/auth/register", { body: { ...f, phone: f.phone || undefined } });
      session.adminToken = r.token;
      go(mode === "login" && prefersOwnerView() ? "owner" : "admin");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof f, label: string, type = "text", required = true) => (
    <label>
      {label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={required} />
    </label>
  );

  return (
    <div className="center">
      <form className="card stack" style={{ width: mode === "register" ? "min(640px, 100%)" : "min(420px, 100%)" }} onSubmit={submit}>
        <h1 style={{ margin: 0 }}>نظام نقاط البيع</h1>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>دخول</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>حساب جديد</button>
        </div>
        {mode === "register" && (
          <>
            {field("businessName", "اسم النشاط")}
            {field("storeName", "اسم الفرع")}
            {field("ownerName", "اسمك")}
            {field("phone", "رقم الهاتف", "tel", false)}
            {plans.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span>الباقة <span className="badge ok">أول 14 يوم مجاناً</span></span>
                <div className="plans">
                  {plans.map((p) => (
                    <button type="button" key={p.code} className={`plan ${f.planCode === p.code ? "picked" : ""}`} onClick={() => setF({ ...f, planCode: p.code })}>
                      <b>{p.name}</b>
                      <span className="num plan-price">{formatMoney(p.price_minor)}<span className="muted"> / شهر</span></span>
                      <span className="muted">{p.max_stores} فرع · {p.max_devices} أجهزة · {p.max_users} مستخدم</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {field("email", "البريد الإلكتروني", "email")}
        {field("password", "كلمة السر", "password")}
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy}>{mode === "login" ? "دخول" : "إنشاء الحساب"}</button>
        <p className="muted" style={{ margin: 0, fontSize: ".85rem" }}>
          بعد الدخول تقدر تعتمد هذا الجهاز ككاشير من صفحة «الأجهزة».
        </p>
      </form>
    </div>
  );
}
