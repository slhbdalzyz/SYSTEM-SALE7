import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatMoney } from "@pos/shared";
import { api, ApiError } from "../api";
import { session, tokenValid } from "../session";
import { METHOD_LABEL, STATE_BADGE, STATE_LABEL, date, parseMoney, type Plan, type SubState } from "../billing";

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** The back office of the service itself: every shop that signed up, what it pays, and who is behind. */
export function Platform() {
  const [token, setToken] = useState(() => (tokenValid(session.platformToken) ? session.platformToken : null));
  const logout = useCallback(() => {
    session.platformToken = null;
    setToken(null);
  }, []);
  const call: Call = useCallback(
    async (path, opts) => {
      try {
        return await api(path, { ...opts, token });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) logout();
        throw e;
      }
    },
    [token, logout],
  );
  if (!token) return <Login onToken={(t) => { session.platformToken = t; setToken(t); }} />;
  return <Console call={call} logout={logout} />;
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onToken((await api<{ token: string }>("/platform/login", { body: { email, password } })).token);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="center">
      <form className="card stack" style={{ width: "min(400px, 100%)" }} onSubmit={submit}>
        <h1 style={{ margin: 0 }}>إدارة المنصة</h1>
        <p className="muted" style={{ margin: 0 }}>للي يديروا الخدمة، مش لأصحاب المحلات.</p>
        <label>البريد الإلكتروني<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>كلمة السر<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary big">دخول</button>
      </form>
    </div>
  );
}

const TABS = { overview: "نظرة عامة", tenants: "المحلات", plans: "الباقات", settings: "الإعدادات" } as const;

function Console({ call, logout }: { call: Call; logout: () => void }) {
  const [tab, setTab] = useState<keyof typeof TABS>("overview");
  const [tenant, setTenant] = useState<string | null>(null);
  return (
    <div className="admin">
      <div className="row">
        <h1 style={{ margin: 0 }}>إدارة المنصة</h1>
        <span className="spacer" />
        <button onClick={logout}>خروج</button>
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
          <button key={k} className={tab === k && !tenant ? "active" : ""} onClick={() => { setTab(k); setTenant(null); }}>{TABS[k]}</button>
        ))}
      </div>
      {tenant ? (
        <TenantDetail call={call} id={tenant} back={() => setTenant(null)} />
      ) : (
        <>
          {tab === "overview" && <Overview call={call} open={setTenant} />}
          {tab === "tenants" && <Tenants call={call} open={setTenant} />}
          {tab === "plans" && <Plans call={call} />}
          {tab === "settings" && <Settings call={call} />}
        </>
      )}
    </div>
  );
}

interface Row {
  id: string;
  name: string;
  phone: string | null;
  owner_email: string | null;
  plan_name: string;
  price_minor: number;
  state: SubState;
  status_reason: string | null;
  paid_until: string;
  days_left: number;
  stores: number;
  devices: number;
  sales30: number;
  revenue30: number;
  last_seen_at: string | null;
  created_at: string;
}

function Overview({ call, open }: { call: Call; open: (id: string) => void }) {
  const [o, setO] = useState<{ tenants: number; byState: Record<string, number>; mrrMinor: number; expiringSoon: number; paid30Minor: number; payments30: number; signups30: number } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    void call<typeof o>("/platform/overview").then(setO);
    void call<Row[]>("/platform/tenants").then(setRows);
  }, [call]);
  if (!o) return <div className="muted">جاري التحميل…</div>;
  const attention = rows.filter((r) => r.state === "grace" || r.state === "locked" || ((r.state === "trial" || r.state === "active") && r.days_left <= 7));
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><span className="muted">الدخل الشهري المتكرر</span><b className="num">{formatMoney(o.mrrMinor)}</b></div>
        <div className="kpi"><span className="muted">المحصّل آخر 30 يوم</span><b className="num">{formatMoney(o.paid30Minor)}</b><span className="muted">{o.payments30} دفعة</span></div>
        <div className="kpi"><span className="muted">المحلات</span><b className="num">{o.tenants}</b><span className="muted">{o.signups30} جديد هالشهر</span></div>
        <div className="kpi"><span className="muted">مشتركين</span><b className="num">{(o.byState.active ?? 0) + (o.byState.grace ?? 0)}</b></div>
        <div className="kpi"><span className="muted">في التجربة</span><b className="num">{o.byState.trial ?? 0}</b></div>
        <div className="kpi"><span className="muted">مقفول أو موقوف</span><b className="num">{(o.byState.locked ?? 0) + (o.byState.suspended ?? 0)}</b></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>يحتاجوا متابعة</h3>
        {attention.length === 0 ? <p className="muted">كل شي تمام.</p> : <TenantTable rows={attention} open={open} />}
      </div>
    </div>
  );
}

function TenantTable({ rows, open }: { rows: Row[]; open: (id: string) => void }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>المحل</th><th>الباقة</th><th>الحالة</th><th>لين</th><th>أجهزة</th><th>مبيعات 30 يوم</th><th>آخر نشاط</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => open(r.id)} style={{ cursor: "pointer" }}>
              <td><b>{r.name}</b><div className="muted num">{r.owner_email ?? ""} {r.phone ?? ""}</div></td>
              <td>{r.plan_name}</td>
              <td><span className={`badge ${STATE_BADGE[r.state]}`}>{STATE_LABEL[r.state]}</span></td>
              <td className="num">{date(r.paid_until)}<div className="muted">{r.days_left >= 0 ? `باقي ${r.days_left} يوم` : `فات ${-r.days_left} يوم`}</div></td>
              <td className="num">{r.devices}</td>
              <td className="num">{r.sales30}<div className="muted">{formatMoney(r.revenue30)}</div></td>
              <td className="num">{r.last_seen_at ? date(r.last_seen_at) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tenants({ call, open }: { call: Call; open: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [state, setState] = useState<SubState | "">("");
  useEffect(() => {
    const t = setTimeout(() => void call<Row[]>(`/platform/tenants${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [call, q]);
  const shown = state ? rows.filter((r) => r.state === state) : rows;
  return (
    <div className="card stack">
      <div className="row">
        <input placeholder="ابحث بالاسم أو الهاتف أو البريد" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <select value={state} onChange={(e) => setState(e.target.value as SubState | "")} style={{ width: "auto" }}>
          <option value="">كل الحالات</option>
          {(Object.keys(STATE_LABEL) as SubState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
        </select>
      </div>
      <TenantTable rows={shown} open={open} />
      {shown.length === 0 && <p className="muted">ما فيش محلات.</p>}
    </div>
  );
}

interface Detail extends Row {
  plan_code: string;
  max_stores: number;
  max_devices: number;
  max_users: number;
  users: { name: string; email: string | null; role: string; active: boolean }[];
  devices: never;
  payments: { id: string; months: number; amount_minor: number; method: string; reference: string | null; period_from: string; period_to: string; created_at: string; plan_code: string; recorded_by_name: string | null }[];
  log: { action: string; data: Record<string, unknown> | null; created_at: string; admin_name: string | null }[];
}

const ROLE_LABEL: Record<string, string> = { owner: "مالك", manager: "مدير", cashier: "كاشير" };

function describe(action: string, d: Record<string, unknown> | null): string {
  if (action === "payment.record" && d) return `سجّل دفعة: ${d.months} شهر · ${METHOD_LABEL[d.method as string] ?? d.method} · ${formatMoney(Number(d.amountMinor))}`;
  if (action === "tenant.update" && d) {
    const parts: string[] = [];
    if (d.status) parts.push(`الحالة ← ${STATE_LABEL[d.status as SubState] ?? d.status}${d.reason ? ` (${d.reason})` : ""}`);
    if (d.planCode) parts.push(`الباقة ← ${d.planCode}`);
    if (d.extendDays) parts.push(`تمديد ${d.extendDays} يوم`);
    if (d.phone !== undefined) parts.push(`الهاتف ← ${d.phone ?? "—"}`);
    return parts.join(" · ") || "تعديل";
  }
  return action;
}

function TenantDetail({ call, id, back }: { call: Call; id: string; back: () => void }) {
  const [t, setT] = useState<Detail | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [pay, setPay] = useState({ months: "1", planCode: "", method: "bank", amount: "", reference: "" });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => call<Detail>(`/platform/tenants/${id}`).then((d) => {
    setT(d);
    setPay((p) => ({ ...p, planCode: p.planCode || d.plan_code }));
  }), [call, id]);
  useEffect(() => {
    void load();
    void call<Plan[]>("/platform/plans").then(setPlans);
  }, [call, load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ text: ok });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  if (!t) return <div className="muted">جاري التحميل…</div>;
  const plan = plans.find((p) => p.code === pay.planCode);
  const months = Number(pay.months) || 1;
  const due = (plan?.price_minor ?? 0) * months;
  const patch = (body: unknown, ok: string) => act(() => call(`/platform/tenants/${id}`, { method: "PATCH", body }), ok);

  return (
    <div className="stack">
      <div className="row">
        <button onClick={back}>→ رجوع</button>
        <h2 style={{ margin: 0 }}>{t.name}</h2>
        <span className={`badge ${STATE_BADGE[t.state]}`}>{STATE_LABEL[t.state]}</span>
        {t.status_reason && <span className="muted">({t.status_reason})</span>}
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div className="kpis">
        <div className="kpi"><span className="muted">الباقة</span><b>{t.plan_name}</b><span className="muted num">{formatMoney(t.price_minor)} / شهر</span></div>
        <div className="kpi"><span className="muted">مدفوع لين</span><b className="num">{date(t.paid_until)}</b><span className="muted">{t.days_left >= 0 ? `باقي ${t.days_left} يوم` : `فات ${-t.days_left} يوم`}</span></div>
        <div className="kpi"><span className="muted">التواصل</span><b className="num" style={{ fontSize: "1rem" }}>{t.phone ?? "—"}</b><span className="muted">{t.users.find((u) => u.role === "owner")?.email}</span></div>
        <div className="kpi"><span className="muted">مشترك من</span><b className="num">{date(t.created_at)}</b></div>
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>تسجيل دفعة</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>الباقة
            <select value={pay.planCode} onChange={(e) => setPay({ ...pay, planCode: e.target.value })}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name} ({formatMoney(p.price_minor)})</option>)}
            </select>
          </label>
          <label>عدد الأشهر
            <select value={pay.months} onChange={(e) => setPay({ ...pay, months: e.target.value })}>
              {[1, 2, 3, 6, 12].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label>الطريقة
            <select value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>المبلغ<input className="num" placeholder={formatMoney(due, "")} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} style={{ width: 120 }} /></label>
          <label>رقم الإيصال / الحوالة<input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
          <button
            className="primary"
            onClick={() =>
              act(
                () => call(`/platform/tenants/${id}/payments`, {
                  body: { months, planCode: pay.planCode, method: pay.method, reference: pay.reference || undefined, amountMinor: pay.amount ? parseMoney(pay.amount) : undefined },
                }),
                "تم تسجيل الدفعة وتمديد الاشتراك",
              ).then(() => setPay((p) => ({ ...p, amount: "", reference: "" })))
            }
          >
            تسجيل {formatMoney(pay.amount ? parseMoney(pay.amount) ?? 0 : due)}
          </button>
        </div>
      </div>

      <div className="card row">
        <b>إجراءات</b>
        <span className="spacer" />
        <button onClick={() => patch({ extendDays: 7 }, "تم تمديد 7 أيام")}>تمديد 7 أيام</button>
        {t.state === "suspended" || t.state === "cancelled" ? (
          <button onClick={() => patch({ status: "active" }, "تم تفعيل الحساب")}>تفعيل</button>
        ) : (
          <button className="danger" onClick={() => { const reason = prompt("سبب الإيقاف (يظهر لصاحب المحل)"); if (reason !== null) void patch({ status: "suspended", reason }, "تم إيقاف الحساب"); }}>إيقاف</button>
        )}
        <button onClick={() => { const phone = prompt("رقم الهاتف", t.phone ?? ""); if (phone !== null) void patch({ phone: phone || null }, "تم الحفظ"); }}>تعديل الهاتف</button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>الدفعات</h3>
        {t.payments.length === 0 ? <p className="muted">ما فيش دفعات.</p> : (
          <table>
            <thead><tr><th>التاريخ</th><th>الباقة</th><th>المدة</th><th>الطريقة</th><th>المرجع</th><th>المبلغ</th><th>سجّلها</th></tr></thead>
            <tbody>
              {t.payments.map((p) => (
                <tr key={p.id}>
                  <td className="num">{date(p.created_at)}</td>
                  <td>{plans.find((x) => x.code === p.plan_code)?.name ?? p.plan_code}</td>
                  <td className="num">{p.months} شهر<div className="muted">{date(p.period_from)} ← {date(p.period_to)}</div></td>
                  <td>{METHOD_LABEL[p.method]}</td>
                  <td className="num">{p.reference ?? "—"}</td>
                  <td className="num">{formatMoney(p.amount_minor)}</td>
                  <td>{p.recorded_by_name ?? "المحل (أونلاين)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>المستخدمين</h3>
        <table>
          <tbody>
            {t.users.map((u, i) => <tr key={i}><td>{u.name}</td><td className="num">{u.email ?? ""}</td><td>{ROLE_LABEL[u.role] ?? u.role}</td><td>{u.active ? "" : "موقوف"}</td></tr>)}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>السجل</h3>
        {t.log.length === 0 ? <p className="muted">فاضي.</p> : (
          <table>
            <tbody>
              {t.log.map((l, i) => (
                <tr key={i}>
                  <td className="num">{new Date(l.created_at).toLocaleString("en-GB")}</td>
                  <td>{l.admin_name}</td>
                  <td>{describe(l.action, l.data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Plans({ call }: { call: Call }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => call<Plan[]>("/platform/plans").then(setPlans), [call]);
  useEffect(() => void load(), [load]);
  const edit = (i: number, k: keyof Plan, v: unknown) => setPlans((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  async function save(p: Plan) {
    setMsg(null);
    try {
      await call(`/platform/plans/${p.code}`, {
        method: "PUT",
        body: { name: p.name, priceMinor: p.price_minor, maxStores: Number(p.max_stores), maxDevices: Number(p.max_devices), maxUsers: Number(p.max_users), active: p.active ?? true, sort: p.sort ?? 0 },
      });
      setMsg(`تم حفظ باقة «${p.name}»`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="card stack">
      <p className="muted" style={{ margin: 0 }}>تغيير السعر يطبق على الدفعات الجاية بس. الحدود تطبق على طول.</p>
      {msg && <div className="badge ok">{msg}</div>}
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>الرمز</th><th>الاسم</th><th>السعر الشهري</th><th>فروع</th><th>أجهزة</th><th>مستخدمين</th><th>معروضة</th><th /></tr></thead>
          <tbody>
            {plans.map((p, i) => (
              <tr key={p.code}>
                <td className="num">{p.code}</td>
                <td><input value={p.name} onChange={(e) => edit(i, "name", e.target.value)} /></td>
                <td><input className="num" defaultValue={formatMoney(p.price_minor, "")} onBlur={(e) => edit(i, "price_minor", parseMoney(e.target.value) ?? p.price_minor)} style={{ width: 110 }} /></td>
                <td><input className="num" value={p.max_stores} onChange={(e) => edit(i, "max_stores", e.target.value)} style={{ width: 60 }} /></td>
                <td><input className="num" value={p.max_devices} onChange={(e) => edit(i, "max_devices", e.target.value)} style={{ width: 60 }} /></td>
                <td><input className="num" value={p.max_users} onChange={(e) => edit(i, "max_users", e.target.value)} style={{ width: 60 }} /></td>
                <td><input type="checkbox" style={{ width: "auto" }} checked={p.active ?? true} onChange={(e) => edit(i, "active", e.target.checked)} /></td>
                <td><button className="primary" onClick={() => void save(plans[i])}>حفظ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Settings({ call }: { call: Call }) {
  const [s, setS] = useState<{ payment_instructions: string; grace_days: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => void call<typeof s>("/platform/settings").then(setS), [call]);
  if (!s) return <div className="muted">جاري التحميل…</div>;
  return (
    <div className="card stack">
      <label>طريقة الدفع (تظهر لأصحاب المحلات في صفحة «الاشتراك»)
        <textarea rows={4} value={s.payment_instructions} onChange={(e) => setS({ ...s, payment_instructions: e.target.value })} />
      </label>
      <label>أيام المهلة بعد انتهاء الاشتراك قبل القفل
        <input className="num" type="number" min={0} max={60} value={s.grace_days} onChange={(e) => setS({ ...s, grace_days: Number(e.target.value) })} style={{ width: 100 }} />
      </label>
      {msg && <div className="badge ok">{msg}</div>}
      <div><button className="primary" onClick={() => void call("/platform/settings", { method: "PUT", body: s }).then(() => setMsg("تم الحفظ"))}>حفظ</button></div>
    </div>
  );
}
