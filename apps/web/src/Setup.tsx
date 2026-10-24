import { useState, type FormEvent } from "react";
import { api } from "./api";
import { session } from "./session";
import type { Screen } from "./App";

/** First screen on a browser that is not a registered cashier yet: owner signs in or opens a new account. */
export function Setup({ go }: { go: (s: Screen) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [f, setF] = useState({ email: "", password: "", businessName: "", storeName: "الفرع الرئيسي", ownerName: "" });
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
          : await api<{ token: string }>("/auth/register", { body: f });
      session.adminToken = r.token;
      go("admin");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof typeof f, label: string, type = "text") => (
    <label>
      {label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required />
    </label>
  );

  return (
    <div className="center">
      <form className="card stack" style={{ width: "min(420px, 100%)" }} onSubmit={submit}>
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
