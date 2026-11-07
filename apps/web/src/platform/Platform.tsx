import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FEATURES, formatMoney, ROLE_NAMES, HEALTH_LABELS, platformCan, PLATFORM_ROLE_LABELS, type Feature, type Health, type PlatformPerm, type PlatformRole } from "@pos/shared";
import { downloadCsv } from "../admin/charts";
import { AgentPage, AgentsTab, AnnouncementsTab, AuditTab, CouponsTab, HealthBadge, MyAccount, openInvoice, RemindersTab, RevenueTab, TeamTab, TicketsTab } from "./Pro";
import { api, ApiError } from "../api";
import { session, tokenValid } from "../session";
import { METHOD_LABEL, STATE_BADGE, STATE_LABEL, date, parseMoney, type Plan, type SubState } from "../billing";

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** Opens the shop's own back office in a new tab, read only, with a token the owner allowed. */
async function supportLogin(call: Call, tenantId: string) {
  const w = window.open("", "_blank");
  try {
    const r = await call<{ token: string }>(`/platform/tenants/${tenantId}/support-login`, { body: {} });
    const url = `${location.pathname}?support=${encodeURIComponent(r.token)}`;
    if (w) w.location.href = url;
    else location.href = url;
  } catch (e) {
    w?.close();
    alert((e as Error).message);
  }
}

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
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ token?: string; twoFactor?: boolean }>("/platform/login", { body: { email, password, code: code || undefined } });
      if (r.twoFactor) setCode("");
      else if (r.token) onToken(r.token);
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
        {code !== null && (
          <label>رمز التحقق من تطبيق المصادقة
            <input className="num" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary big">دخول</button>
      </form>
    </div>
  );
}

/** Each tab and the permission it needs; an agent gets their own page only. */
const TABS: Record<string, { label: string; perm: PlatformPerm | null }> = {
  overview: { label: "نظرة عامة", perm: "view" },
  tenants: { label: "المحلات", perm: "view" },
  revenue: { label: "الإيرادات", perm: "revenue" },
  reminders: { label: "التذكيرات", perm: "reminders" },
  tickets: { label: "الدعم الفني", perm: "tickets" },
  announce: { label: "الإعلانات", perm: "announce" },
  coupons: { label: "الكوبونات", perm: "coupons" },
  agents: { label: "الوكلاء", perm: "agents" },
  plans: { label: "الباقات", perm: "plans" },
  team: { label: "الفريق", perm: "team" },
  audit: { label: "السجل", perm: "audit" },
  errors: { label: "أخطاء السيرفر", perm: "errors" },
  settings: { label: "الإعدادات", perm: "settings" },
  me: { label: "حسابي", perm: null },
};

function Console({ call, logout }: { call: Call; logout: () => void }) {
  const [me, setMe] = useState<{ name: string; role: PlatformRole } | null>(null);
  const [tab, setTab] = useState("overview");
  const [tenant, setTenant] = useState<string | null>(null);
  useEffect(() => void call<{ name: string; role: PlatformRole }>("/platform/me").then(setMe), [call]);
  if (!me) return <div className="center muted">جاري التحميل…</div>;
  const tabs = Object.keys(TABS).filter((k) => (me.role === "agent" ? k === "me" : !TABS[k].perm || platformCan(me.role, TABS[k].perm!)));
  const current = me.role === "agent" && tab !== "me" ? "agent" : tab;
  const can = (p: PlatformPerm) => platformCan(me.role, p);
  return (
    <div className="admin">
      <div className="row">
        <h1 style={{ margin: 0 }}>إدارة المنصة</h1>
        <span className="muted">{me.name} · {PLATFORM_ROLE_LABELS[me.role]}</span>
        <span className="spacer" />
        <button onClick={logout}>خروج</button>
      </div>
      <div className="tabs" style={{ flexWrap: "wrap" }}>
        {me.role === "agent" && <button className={current === "agent" ? "active" : ""} onClick={() => setTab("agent")}>محلاتي وعمولتي</button>}
        {tabs.map((k) => (
          <button key={k} className={current === k && !tenant ? "active" : ""} onClick={() => { setTab(k); setTenant(null); }}>{TABS[k].label}</button>
        ))}
      </div>
      {tenant && me.role !== "agent" ? (
        <TenantDetail call={call} id={tenant} back={() => setTenant(null)} can={can} />
      ) : (
        <>
          {current === "agent" && <AgentPage call={call} self />}
          {current === "overview" && <Overview call={call} open={setTenant} />}
          {current === "tenants" && <Tenants call={call} open={setTenant} />}
          {current === "revenue" && <RevenueTab call={call} />}
          {current === "reminders" && <RemindersTab call={call} open={setTenant} />}
          {current === "tickets" && <TicketsTab call={call} open={setTenant} supportLogin={(id) => void supportLogin(call, id)} />}
          {current === "announce" && <AnnouncementsTab call={call} />}
          {current === "coupons" && <CouponsTab call={call} />}
          {current === "agents" && <AgentsTab call={call} open={setTenant} />}
          {current === "plans" && <Plans call={call} />}
          {current === "team" && <TeamTab call={call} />}
          {current === "audit" && <AuditTab call={call} open={setTenant} />}
          {current === "errors" && <Errors call={call} />}
          {current === "settings" && <Settings call={call} />}
          {current === "me" && <MyAccount call={call} />}
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
  health: Health;
  sales7: number;
  sales_prev7: number;
  agent_name: string | null;
  agent_id: string | null;
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
  const live = rows.filter((r) => r.state !== "suspended" && r.state !== "cancelled");
  const atRisk = live.filter((r) => r.health === "idle" || r.health === "drop");
  const healthCount = (h: Health) => live.filter((r) => r.health === h).length;
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
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>صحة المحلات</h3>
          {(["good", "new", "drop", "idle"] as Health[]).map((h) => <span key={h}><HealthBadge h={h} /> <b className="num">{healthCount(h)}</b></span>)}
        </div>
        <p className="muted" style={{ margin: "6px 0" }}>محل «بطّل يستعمل» ما فتحش النظام 3 أيام أو ما باعش هالأسبوع، و«مبيعاته نقصت» باع أقل من نص الأسبوع اللي قبله. اتصل بيهم قبل ما يوقفوا الاشتراك.</p>
        {atRisk.length === 0 ? <p className="muted">كل المحلات شغالة ✓</p> : <TenantTable rows={atRisk} open={open} />}
      </div>
    </div>
  );
}

function TenantTable({ rows, open }: { rows: Row[]; open: (id: string) => void }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead><tr><th>المحل</th><th>الباقة</th><th>الحالة</th><th>لين</th><th>الصحة</th><th>أجهزة</th><th>مبيعات 30 يوم</th><th>آخر نشاط</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => open(r.id)} style={{ cursor: "pointer" }}>
              <td><b>{r.name}</b><div className="muted num">{r.owner_email ?? ""} {r.phone ?? ""}</div>{r.agent_name && <div className="muted">وكيل: {r.agent_name}</div>}</td>
              <td>{r.plan_name}</td>
              <td><span className={`badge ${STATE_BADGE[r.state]}`}>{STATE_LABEL[r.state]}</span></td>
              <td className="num">{date(r.paid_until)}<div className="muted">{r.days_left >= 0 ? `باقي ${r.days_left} يوم` : `فات ${-r.days_left} يوم`}</div></td>
              <td><HealthBadge h={r.health} /><div className="muted num">{r.sales7} هالأسبوع · {r.sales_prev7} قبله</div></td>
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
  const [health, setHealth] = useState<Health | "">("");
  useEffect(() => {
    const t = setTimeout(() => void call<Row[]>(`/platform/tenants${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [call, q]);
  const shown = rows.filter((r) => (!state || r.state === state) && (!health || r.health === health));
  return (
    <div className="card stack">
      <div className="row">
        <input placeholder="ابحث بالاسم أو الهاتف أو البريد" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <select value={state} onChange={(e) => setState(e.target.value as SubState | "")} style={{ width: "auto" }}>
          <option value="">كل الحالات</option>
          {(Object.keys(STATE_LABEL) as SubState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
        </select>
        <select value={health} onChange={(e) => setHealth(e.target.value as Health | "")} style={{ width: "auto" }}>
          <option value="">كل المحلات</option>
          {(Object.keys(HEALTH_LABELS) as Health[]).map((h) => <option key={h} value={h}>{HEALTH_LABELS[h]}</option>)}
        </select>
        <button onClick={() => downloadCsv("المحلات", ["المحل", "الهاتف", "البريد", "الباقة", "الحالة", "مدفوع لين", "الصحة", "مبيعات 30 يوم", "إيراد 30 يوم", "آخر نشاط", "الوكيل", "مشترك من"],
          shown.map((r) => [r.name, r.phone ?? "", r.owner_email ?? "", r.plan_name, STATE_LABEL[r.state], date(r.paid_until), HEALTH_LABELS[r.health], r.sales30, r.revenue30 / 1000, r.last_seen_at ? date(r.last_seen_at) : "", r.agent_name ?? "", date(r.created_at)]))}>⬇ Excel</button>
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
  payments: { id: string; invoice_no?: number; months: number; bonus_months?: number; discount_minor?: number; coupon_code?: string | null; amount_minor: number; method: string; reference: string | null; period_from: string; period_to: string; created_at: string; plan_code: string; recorded_by_name: string | null }[];
  features: Partial<Record<Feature, boolean>>;
  plan_features: Partial<Record<Feature, boolean>>;
  support_until: string | null;
  log: { action: string; data: Record<string, unknown> | null; created_at: string; admin_name: string | null }[];
}

const ROLE_LABEL: Record<string, string> = ROLE_NAMES;

function describe(action: string, d: Record<string, unknown> | null): string {
  if (action === "payment.record" && d) return `سجّل دفعة: ${d.months} شهر · ${METHOD_LABEL[d.method as string] ?? d.method} · ${formatMoney(Number(d.amountMinor))}${d.coupon ? ` · كوبون ${d.coupon}` : ""}${d.invoice ? ` · فاتورة ${d.invoice}` : ""}`;
  if (action === "support.login") return "دخل حساب المحل للدعم (قراءة بس)";
  if (action === "ticket.reply") return `رد على طلب الدعم #${d?.number}`;
  if (action === "reminder.sent") return `بعت تذكير تجديد (${d?.channel})`;
  if (action === "tenant.update" && d) {
    const parts: string[] = [];
    if (d.status) parts.push(`الحالة ← ${STATE_LABEL[d.status as SubState] ?? d.status}${d.reason ? ` (${d.reason})` : ""}`);
    if (d.planCode) parts.push(`الباقة ← ${d.planCode}`);
    if (d.extendDays) parts.push(`تمديد ${d.extendDays} يوم`);
    if (d.phone !== undefined) parts.push(`الهاتف ← ${d.phone ?? "—"}`);
    if (d.agentId !== undefined) parts.push(d.agentId ? "غيّر الوكيل" : "شال الوكيل");
    if (d.features) parts.push(`الميزات ← ${Object.entries(d.features as Record<string, boolean>).map(([k, v]) => `${FEATURES[k as Feature] ?? k} ${v ? "مفتوحة" : "مقفولة"}`).join("، ") || "حسب الباقة"}`);
    return parts.join(" · ") || "تعديل";
  }
  return action;
}

function TenantDetail({ call, id, back, can }: { call: Call; id: string; back: () => void; can: (p: PlatformPerm) => boolean }) {
  const [t, setT] = useState<Detail | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [pay, setPay] = useState({ months: "1", planCode: "", method: "bank", amount: "", reference: "", coupon: "" });
  const [agents, setAgents] = useState<{ id: string; name: string; city: string | null }[]>([]);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => call<Detail>(`/platform/tenants/${id}`).then((d) => {
    setT(d);
    setPay((p) => ({ ...p, planCode: p.planCode || d.plan_code }));
  }), [call, id]);
  useEffect(() => {
    void load();
    void call<Plan[]>("/platform/plans").then(setPlans);
    if (can("agents")) void call<{ id: string; name: string; city: string | null }[]>("/platform/agents").then(setAgents);
  }, [call, load, can]);

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

      {can("payments") && <div className="card stack">
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
          <label>كوبون<input value={pay.coupon} onChange={(e) => setPay({ ...pay, coupon: e.target.value.toUpperCase() })} style={{ width: 110, direction: "ltr" }} /></label>
          <button
            className="primary"
            onClick={() =>
              act(
                () => call(`/platform/tenants/${id}/payments`, {
                  body: { months, planCode: pay.planCode, method: pay.method, reference: pay.reference || undefined, amountMinor: pay.amount ? parseMoney(pay.amount) : undefined, couponCode: pay.coupon || undefined },
                }),
                "تم تسجيل الدفعة وتمديد الاشتراك",
              ).then(() => setPay((p) => ({ ...p, amount: "", reference: "", coupon: "" })))
            }
          >
            تسجيل {pay.coupon && !pay.amount ? "" : formatMoney(pay.amount ? parseMoney(pay.amount) ?? 0 : due)}
          </button>
        </div>
      </div>}

      <div className="card row">
        <b>إجراءات</b>
        <span className="spacer" />
        {can("support") && (t.support_until && new Date(t.support_until) > new Date()
          ? <button onClick={() => void supportLogin(call, id)}>👁 دخول للدعم (قراءة بس، لين {new Date(t.support_until).toLocaleTimeString("en-GB", { timeStyle: "short" })})</button>
          : <span className="muted">دخول الدعم: المالك ما سمحش</span>)}
        <button onClick={() => patch({ extendDays: 7 }, "تم تمديد 7 أيام")}>تمديد 7 أيام</button>
        {t.state === "suspended" || t.state === "cancelled" ? (
          <button onClick={() => patch({ status: "active" }, "تم تفعيل الحساب")}>تفعيل</button>
        ) : (
          <button className="danger" onClick={() => { const reason = prompt("سبب الإيقاف (يظهر لصاحب المحل)"); if (reason !== null) void patch({ status: "suspended", reason }, "تم إيقاف الحساب"); }}>إيقاف</button>
        )}
        <button onClick={() => { const phone = prompt("رقم الهاتف", t.phone ?? ""); if (phone !== null) void patch({ phone: phone || null }, "تم الحفظ"); }}>تعديل الهاتف</button>
        {can("edit") && can("agents") && (
          <select value={t.agent_id ?? ""} onChange={(e) => void patch({ agentId: e.target.value || null }, "تم تغيير الوكيل")} style={{ width: "auto" }}>
            <option value="">بدون وكيل</option>
            {agents.map((a) => <option key={a.id} value={a.id}>وكيل: {a.name}{a.city ? ` (${a.city})` : ""}</option>)}
          </select>
        )}
      </div>

      {can("edit") && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>الميزات لهذا المحل</h3>
          <p className="muted" style={{ margin: 0 }}>«حسب الباقة» ياخذ إعداد باقته. تقدر تفتح ميزة لمحل وحده أو تقفلها عليه.</p>
          <div className="row" style={{ gap: 16 }}>
            {(Object.keys(FEATURES) as Feature[]).map((f) => {
              const own = t.features?.[f];
              const planOn = t.plan_features?.[f] ?? true;
              return (
                <label key={f}>{FEATURES[f]}
                  <select value={own === undefined ? "" : own ? "on" : "off"} style={{ width: "auto" }}
                    onChange={(e) => {
                      const next = { ...t.features };
                      if (e.target.value === "") delete next[f];
                      else next[f] = e.target.value === "on";
                      void patch({ features: next }, "تم الحفظ");
                    }}>
                    <option value="">حسب الباقة ({planOn ? "مفتوحة" : "مقفولة"})</option>
                    <option value="on">مفتوحة</option>
                    <option value="off">مقفولة</option>
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>الدفعات</h3>
        {t.payments.length === 0 ? <p className="muted">ما فيش دفعات.</p> : (
          <table>
            <thead><tr><th>#</th><th>التاريخ</th><th>الباقة</th><th>المدة</th><th>الطريقة</th><th>المرجع</th><th>المبلغ</th><th>سجّلها</th><th /></tr></thead>
            <tbody>
              {t.payments.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.invoice_no ?? ""}</td>
                  <td className="num">{date(p.created_at)}</td>
                  <td>{plans.find((x) => x.code === p.plan_code)?.name ?? p.plan_code}</td>
                  <td className="num">{p.months} شهر<div className="muted">{date(p.period_from)} ← {date(p.period_to)}</div></td>
                  <td>{METHOD_LABEL[p.method]}</td>
                  <td className="num">{p.reference ?? "—"}</td>
                  <td className="num">{formatMoney(p.amount_minor)}{p.discount_minor ? <div className="muted">خصم {formatMoney(p.discount_minor)} · {p.coupon_code}</div> : null}{p.bonus_months ? <div className="muted">+{p.bonus_months} شهر مجاناً</div> : null}</td>
                  <td>{p.recorded_by_name ?? "المحل (أونلاين)"}</td>
                  <td><button onClick={() => void openInvoice(call, `/platform/payments/${p.id}/invoice`)}>🧾</button></td>
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
        body: { name: p.name, priceMinor: p.price_minor, maxStores: Number(p.max_stores), maxDevices: Number(p.max_devices), maxUsers: Number(p.max_users), active: p.active ?? true, sort: p.sort ?? 0, features: p.features ?? {} },
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
          <thead><tr><th>الرمز</th><th>الاسم</th><th>السعر الشهري</th><th>فروع</th><th>أجهزة</th><th>مستخدمين</th><th>الميزات</th><th>معروضة</th><th /></tr></thead>
          <tbody>
            {plans.map((p, i) => (
              <tr key={p.code}>
                <td className="num">{p.code}</td>
                <td><input value={p.name} onChange={(e) => edit(i, "name", e.target.value)} /></td>
                <td><input className="num" defaultValue={formatMoney(p.price_minor, "")} onBlur={(e) => edit(i, "price_minor", parseMoney(e.target.value) ?? p.price_minor)} style={{ width: 110 }} /></td>
                <td><input className="num" value={p.max_stores} onChange={(e) => edit(i, "max_stores", e.target.value)} style={{ width: 60 }} /></td>
                <td><input className="num" value={p.max_devices} onChange={(e) => edit(i, "max_devices", e.target.value)} style={{ width: 60 }} /></td>
                <td><input className="num" value={p.max_users} onChange={(e) => edit(i, "max_users", e.target.value)} style={{ width: 60 }} /></td>
                <td style={{ minWidth: 220 }}>
                  <div className="row" style={{ gap: 8 }}>
                    {(Object.keys(FEATURES) as Feature[]).map((f) => (
                      <label key={f} className="row" style={{ gap: 3, fontSize: ".85rem" }}>
                        <input type="checkbox" style={{ width: "auto" }} checked={p.features?.[f] ?? true} onChange={(e) => edit(i, "features", { ...(p.features ?? {}), [f]: e.target.checked })} />{FEATURES[f]}
                      </label>
                    ))}
                  </div>
                </td>
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

interface PlatformSettings {
  payment_instructions: string;
  grace_days: number;
  reminder_message?: string;
  company?: { name: string; phone: string; address: string; taxNo: string };
  sms?: { enabled: boolean; url: string; token: string };
}

function Settings({ call }: { call: Call }) {
  const [s, setS] = useState<PlatformSettings | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => void call<PlatformSettings>("/platform/settings").then(setS), [call]);
  if (!s) return <div className="muted">جاري التحميل…</div>;
  const company = s.company ?? { name: "", phone: "", address: "", taxNo: "" };
  const sms = s.sms ?? { enabled: false, url: "", token: "" };
  const save = () => call("/platform/settings", { method: "PUT", body: { ...s, company, sms } })
    .then(() => setMsg({ text: "تم الحفظ" })).catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>الاشتراك</h3>
        <label>طريقة الدفع (تظهر لأصحاب المحلات في صفحة «الاشتراك»)
          <textarea rows={4} value={s.payment_instructions} onChange={(e) => setS({ ...s, payment_instructions: e.target.value })} />
        </label>
        <label>أيام المهلة بعد انتهاء الاشتراك قبل القفل
          <input className="num" type="number" min={0} max={60} value={s.grace_days} onChange={(e) => setS({ ...s, grace_days: Number(e.target.value) })} style={{ width: 100 }} />
        </label>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>بيانات الشركة (تطلع في الفواتير)</h3>
        <div className="row">
          <label>الاسم<input value={company.name} onChange={(e) => setS({ ...s, company: { ...company, name: e.target.value } })} /></label>
          <label>الهاتف<input className="num" value={company.phone} onChange={(e) => setS({ ...s, company: { ...company, phone: e.target.value } })} /></label>
          <label>العنوان<input value={company.address} onChange={(e) => setS({ ...s, company: { ...company, address: e.target.value } })} /></label>
          <label>الرقم الضريبي<input className="num" value={company.taxNo} onChange={(e) => setS({ ...s, company: { ...company, taxNo: e.target.value } })} /></label>
        </div>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>رسالة تذكير التجديد</h3>
        <textarea rows={3} value={s.reminder_message ?? ""} onChange={(e) => setS({ ...s, reminder_message: e.target.value })} />
        <div className="muted">تقدر تستعمل: <code>{"{shop}"}</code> اسم المحل، <code>{"{date}"}</code> تاريخ النهاية، <code>{"{days}"}</code> الأيام الباقية، <code>{"{plan}"}</code> الباقة، <code>{"{price}"}</code> السعر.</div>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>بوابة الرسائل النصية (SMS)</h3>
        <p className="muted" style={{ margin: 0 }}>
          باش تنبعت التذكيرات SMS تلقائياً تحتاج حساب عند مزوّد رسائل (مثلاً شركات الرسائل الجماعية في ليبيا أو خدمة دولية). النظام يبعت طلب POST فيه <code>{"{ to, message }"}</code> للرابط هذا، والمفتاح يمشي في <code>Authorization: Bearer</code>.
          من غير بوابة، التذكير يوصل للمحل في التطبيق وعلى تلفون المالك، ويستناك في «التذكيرات» تبعته واتساب بضغطة.
        </p>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={sms.enabled} onChange={(e) => setS({ ...s, sms: { ...sms, enabled: e.target.checked } })} />تشغيل الإرسال التلقائي</label>
        <div className="row">
          <label style={{ flex: 2 }}>رابط البوابة<input value={sms.url} onChange={(e) => setS({ ...s, sms: { ...sms, url: e.target.value } })} placeholder="https://…" style={{ direction: "ltr" }} /></label>
          <label style={{ flex: 1 }}>المفتاح<input type="password" value={sms.token} onChange={(e) => setS({ ...s, sms: { ...sms, token: e.target.value } })} autoComplete="off" /></label>
        </div>
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
      <div><button className="primary" onClick={() => void save()}>حفظ</button></div>
    </div>
  );
}

interface ServerError { id: number; at: string; method: string | null; url: string | null; message: string | null; stack: string | null; tenant_name: string | null }

/** The server's last errors (kept 30 days), so a problem is seen before a shop calls about it. */
function Errors({ call }: { call: Call }) {
  const [data, setData] = useState<{ rows: ServerError[]; last24h: number } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call<{ rows: ServerError[]; last24h: number }>("/platform/errors").then(setData).catch((e) => setError((e as Error).message)), [call]);
  useEffect(() => void load(), [load]);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">جاري التحميل…</div>;
  return (
    <div className="stack">
      <div className="row">
        <span className={`badge ${data.last24h ? "bad" : "ok"}`}>{data.last24h ? `${data.last24h} خطأ في آخر 24 ساعة` : "ما فيش أخطاء في آخر 24 ساعة ✓"}</span>
        <span className="muted">فحص صحة السيرفر وقاعدة البيانات: <code>/api/health</code> (حطه في أي خدمة مراقبة).</span>
        <span className="spacer" />
        <button onClick={() => void load()}>تحديث</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table>
          <thead><tr><th>الوقت</th><th>المحل</th><th>الطلب</th><th>الخطأ</th></tr></thead>
          <tbody>
            {data.rows.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 24 }}>ما فيش أخطاء مسجلة</td></tr>}
            {data.rows.map((r) => (
              <tr key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: "pointer", verticalAlign: "top" }}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{r.tenant_name ?? "—"}</td>
                <td className="num" style={{ direction: "ltr", textAlign: "left" }}>{r.method} {r.url}</td>
                <td style={{ direction: "ltr", textAlign: "left", maxWidth: 520 }}>
                  {r.message}
                  {open === r.id && r.stack && <pre style={{ whiteSpace: "pre-wrap", fontSize: ".75rem", margin: "6px 0 0" }}>{r.stack}</pre>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
