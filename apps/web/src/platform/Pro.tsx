import { useCallback, useEffect, useState } from "react";
import { couponLabel, formatMoney, HEALTH_LABELS, PLATFORM_ROLE_LABELS, PLATFORM_ROLES, type Health, type PlatformRole } from "@pos/shared";
import { METHOD_LABEL, date, parseMoney, type Plan } from "../billing";
import { BarChart, TimeChart, downloadCsv } from "../admin/charts";
import { printInvoice, type SubscriptionInvoice } from "./invoice";

export type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

const when = (s: string) => new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
export const HEALTH_BADGE: Record<Health, string> = { new: "off", good: "ok", drop: "warn", idle: "bad" };

function useLoad<T>(call: Call, path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call<T>(path).then(setData).catch((e) => setError((e as Error).message)), [call, path]);
  useEffect(() => void load(), [load]);
  return { data, error, load };
}

function Msg({ m }: { m: { text: string; bad?: boolean } | null }) {
  return m ? <div className={m.bad ? "error" : "badge ok"}>{m.text}</div> : null;
}

function useAct(after?: () => unknown) {
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      await after?.();
      setMsg({ text: ok });
      return true;
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
      return false;
    }
  };
  return { msg, act };
}

export async function openInvoice(call: Call, path: string) {
  const v = await call<SubscriptionInvoice>(path);
  if (!printInvoice(v)) alert("المتصفح منع النافذة. اسمح بالنوافذ المنبثقة لهذا الموقع.");
}

// ---- Revenue ----

interface Revenue {
  months: { month: string; collected: number; discounts: number; payments: number; signups: number; renewals: number }[];
  byPlan: { code: string; name: string; shops: number; mrr: number }[];
  mrr: number;
  due30: { shops: number; minor: number };
}
interface PaymentRow { id: string; invoice_no: number; created_at: string; months: number; bonus_months: number; amount_minor: number; discount_minor: number; coupon_code: string | null; method: string; reference: string | null; period_from: string; period_to: string; plan_code: string; tenant_name: string; agent_name: string | null }

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;

export function RevenueTab({ call }: { call: Call }) {
  const { data } = useLoad<Revenue>(call, "/platform/revenue?months=12");
  const [range, setRange] = useState({ from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const pays = useLoad<PaymentRow[]>(call, `/platform/payments?from=${range.from}&to=${range.to}`);
  if (!data) return <div className="muted">جاري التحميل…</div>;
  const total = (pays.data ?? []).reduce((s, p) => s + p.amount_minor, 0);
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><span className="muted">الدخل الشهري المتكرر</span><b className="num">{formatMoney(data.mrr)}</b></div>
        <div className="kpi"><span className="muted">هالشهر</span><b className="num">{formatMoney(data.months.at(-1)?.collected ?? 0)}</b><span className="muted">{data.months.at(-1)?.payments ?? 0} دفعة</span></div>
        <div className="kpi"><span className="muted">مستحق خلال 30 يوم</span><b className="num">{formatMoney(data.due30.minor)}</b><span className="muted">{data.due30.shops} محل</span></div>
        <div className="kpi"><span className="muted">خصومات الكوبونات (السنة)</span><b className="num">{formatMoney(data.months.reduce((s, m) => s + m.discounts, 0))}</b></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>المحصّل كل شهر</h3>
        <BarChart name="المحصّل" data={data.months.map((m) => ({ label: monthLabel(m.month), value: m.collected, sub: `${m.payments} دفعة` }))} fmt={formatMoney} height={220} />
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>محلات جديدة وتجديدات</h3>
        <TimeChart data={data.months.map((m) => ({ label: monthLabel(m.month), values: [m.signups, m.renewals] }))} names={["اشتركوا جديد", "جددوا"]} fmt={(n) => n.toLocaleString("en", { maximumFractionDigits: 1 })} height={200} />
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>حسب الباقة</h3>
        <table>
          <thead><tr><th>الباقة</th><th>المحلات</th><th>الدخل الشهري</th></tr></thead>
          <tbody>{data.byPlan.map((p) => <tr key={p.code}><td>{p.name}</td><td className="num">{p.shops}</td><td className="num">{formatMoney(p.mrr)}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="card stack">
        <div className="row" style={{ alignItems: "end" }}>
          <h3 style={{ margin: 0 }}>الدفعات والفواتير</h3>
          <span className="spacer" />
          <label>من<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label>إلى<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button onClick={() => downloadCsv(`دفعات-${range.from}-${range.to}`, ["رقم الفاتورة", "التاريخ", "المحل", "الباقة", "الأشهر", "مجاناً", "المبلغ", "الخصم", "الكوبون", "الطريقة", "المرجع", "الوكيل"],
            (pays.data ?? []).map((p) => [p.invoice_no, date(p.created_at), p.tenant_name, p.plan_code, p.months, p.bonus_months, p.amount_minor / 1000, p.discount_minor / 1000, p.coupon_code ?? "", METHOD_LABEL[p.method] ?? p.method, p.reference ?? "", p.agent_name ?? ""]))}>⬇ Excel</button>
        </div>
        <div className="muted">{pays.data?.length ?? 0} دفعة · المجموع <b className="num">{formatMoney(total)}</b></div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>#</th><th>التاريخ</th><th>المحل</th><th>المدة</th><th>المبلغ</th><th>الطريقة</th><th /></tr></thead>
            <tbody>
              {(pays.data ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.invoice_no}</td>
                  <td className="num">{date(p.created_at)}</td>
                  <td>{p.tenant_name}{p.agent_name && <div className="muted">وكيل: {p.agent_name}</div>}</td>
                  <td className="num">{p.months} شهر{p.bonus_months ? ` +${p.bonus_months}` : ""}</td>
                  <td className="num">{formatMoney(p.amount_minor)}{p.discount_minor ? <div className="muted">خصم {formatMoney(p.discount_minor)} ({p.coupon_code})</div> : null}</td>
                  <td>{METHOD_LABEL[p.method] ?? p.method}</td>
                  <td><button onClick={() => void openInvoice(call, `/platform/payments/${p.id}/invoice`)}>🧾 فاتورة</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---- Reminders ----

interface Reminder { id: string; kind: "7d" | "3d" | "locked"; period_end: string; message: string; sent_at: string | null; channel: string | null; error: string | null; created_at: string; tenant_id: string; tenant_name: string; phone: string | null; wa: string | null }
const KIND_LABEL = { "7d": "قبل 7 أيام", "3d": "قبل 3 أيام", locked: "انقفل" };
const CHANNEL_LABEL: Record<string, string> = { sms: "رسالة SMS", whatsapp: "واتساب", skipped: "تخطّي" };

export function RemindersTab({ call, open }: { call: Call; open: (id: string) => void }) {
  const { data, load } = useLoad<Reminder[]>(call, "/platform/reminders");
  const { msg, act } = useAct(load);
  if (!data) return <div className="muted">جاري التحميل…</div>;
  const pending = data.filter((r) => !r.sent_at);
  const done = data.filter((r) => r.sent_at);
  const mark = (id: string, channel: string) => call(`/platform/reminders/${id}/sent`, { body: { channel } }).then(load);
  return (
    <div className="stack">
      <div className="card row">
        <div>
          <b>تذكيرات التجديد</b>
          <div className="muted">قبل 7 أيام و3 أيام من نهاية الاشتراك، ويوم ينقفل. توصل للمحل تنبيه في التطبيق وعلى تلفون المالك دايماً. لو ضبطت بوابة SMS في الإعدادات تنبعت رسالة نصية تلقائياً، وإلا تستنى هنا تبعتها بضغطة على واتساب.</div>
        </div>
        <span className="spacer" />
        <button onClick={() => void act(() => call("/platform/reminders/run", { body: {} }), "تم الفحص")}>افحص الآن</button>
      </div>
      <Msg m={msg} />
      <div className="card">
        <h3 style={{ marginTop: 0 }}>تستنى الإرسال ({pending.length})</h3>
        {pending.length === 0 ? <p className="muted">ما فيش تذكيرات تستنى.</p> : (
          <table>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id} style={{ verticalAlign: "top" }}>
                  <td><b style={{ cursor: "pointer" }} onClick={() => open(r.tenant_id)}>{r.tenant_name}</b><div className="muted num">{r.phone ?? "بدون هاتف"}</div><span className={`badge ${r.kind === "locked" ? "bad" : "off"}`}>{KIND_LABEL[r.kind]}</span></td>
                  <td style={{ maxWidth: 460 }}>{r.message}{r.error && <div className="error">SMS فشلت: {r.error}</div>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.wa ? (
                      <a className="btn primary" href={`https://wa.me/${r.wa}?text=${encodeURIComponent(r.message)}`} target="_blank" rel="noreferrer" onClick={() => void mark(r.id, "whatsapp")}>واتساب</a>
                    ) : <span className="muted">ما فيش رقم</span>}{" "}
                    <button onClick={() => void mark(r.id, "skipped")}>تخطّي</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>انبعتت (آخر 30 يوم)</h3>
        {done.length === 0 ? <p className="muted">ولا واحد.</p> : (
          <table>
            <tbody>{done.map((r) => <tr key={r.id}><td>{r.tenant_name}</td><td>{KIND_LABEL[r.kind]}</td><td>{CHANNEL_LABEL[r.channel ?? ""] ?? r.channel}</td><td className="num">{when(r.sent_at!)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---- Coupons ----

interface Coupon { id: string; code: string; kind: "percent" | "months"; value: number; plan_code: string | null; min_months: number; max_uses: number | null; used: number; valid_until: string | null; active: boolean; note: string | null; discount_total: number }

export function CouponsTab({ call }: { call: Call }) {
  const { data, load } = useLoad<Coupon[]>(call, "/platform/coupons");
  const plans = useLoad<Plan[]>(call, "/platform/plans");
  const { msg, act } = useAct(load);
  const [f, setF] = useState({ code: "", kind: "percent" as "percent" | "months", value: "10", planCode: "", minMonths: "1", maxUses: "", validUntil: "", note: "" });
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>كوبون جديد</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>الكود<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="EID20" style={{ width: 130, direction: "ltr" }} /></label>
          <label>النوع
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "percent" })}><option value="percent">خصم %</option><option value="months">أشهر مجانية</option></select>
          </label>
          <label>{f.kind === "percent" ? "النسبة %" : "عدد الأشهر"}<input className="num" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} style={{ width: 80 }} /></label>
          <label>الباقة
            <select value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}><option value="">كل الباقات</option>{(plans.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
          </label>
          <label>أقل مدة (شهر)<input className="num" value={f.minMonths} onChange={(e) => setF({ ...f, minMonths: e.target.value })} style={{ width: 70 }} /></label>
          <label>أقصى استعمال<input className="num" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} placeholder="بلا حد" style={{ width: 90 }} /></label>
          <label>ينتهي<input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
          <label>ملاحظة<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="primary" onClick={() => void act(() => call("/platform/coupons", { body: {
            code: f.code, kind: f.kind, value: Number(f.value), planCode: f.planCode || null, minMonths: Number(f.minMonths) || 1,
            maxUses: f.maxUses ? Number(f.maxUses) : null, validUntil: f.validUntil ? new Date(`${f.validUntil}T23:59:59`).toISOString() : null, note: f.note || null,
          } }), "تمت إضافة الكوبون").then((ok) => ok && setF({ ...f, code: "", note: "" }))}>إضافة</button>
        </div>
        <div className="muted">كل محل يستعمل الكوبون مرة وحدة. يكتبه صاحب المحل في صفحة «الاشتراك» وقت الدفع، أو تكتبه أنت وقت تسجيل دفعة.</div>
      </div>
      <Msg m={msg} />
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>الكود</th><th>العرض</th><th>الشروط</th><th>استعمل</th><th>خصومات</th><th>الحالة</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((c) => {
              const expired = c.valid_until && new Date(c.valid_until) < new Date();
              return (
                <tr key={c.id}>
                  <td className="num"><b>{c.code}</b>{c.note && <div className="muted">{c.note}</div>}</td>
                  <td>{couponLabel(c)}</td>
                  <td className="muted">{c.plan_code ? `باقة ${c.plan_code}` : "كل الباقات"} · {c.min_months}+ شهر{c.valid_until ? ` · لين ${date(c.valid_until)}` : ""}</td>
                  <td className="num">{c.used}{c.max_uses ? ` / ${c.max_uses}` : ""}</td>
                  <td className="num">{formatMoney(c.discount_total)}</td>
                  <td><span className={`badge ${c.active && !expired ? "ok" : "off"}`}>{!c.active ? "موقوف" : expired ? "منتهي" : "شغال"}</span></td>
                  <td><button onClick={() => void act(() => call(`/platform/coupons/${c.id}`, { method: "PATCH", body: { active: !c.active } }), "تم")}>{c.active ? "إيقاف" : "تشغيل"}</button></td>
                </tr>
              );
            })}
            {data?.length === 0 && <tr><td colSpan={7} className="muted">ما فيش كوبونات.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Agents ----

interface Agent { id: string; name: string; phone: string | null; city: string | null; code: string; commission_bp: number; active: boolean; shops: number; paying: number; collected: number; earned: number; paid: number; balance: number }
interface AgentDetail { agent: Agent; shops: { id: string; name: string; status: string; paid_until: string; created_at: string; plan_code: string; paid: number; commission: number }[]; payouts: { id: string; amount_minor: number; note: string | null; created_at: string }[] }

const signupLink = (code: string) => `${location.origin}${location.pathname}?ref=${code}`;

export function AgentsTab({ call, open }: { call: Call; open: (id: string) => void }) {
  const { data, load } = useLoad<Agent[]>(call, "/platform/agents");
  const { msg, act } = useAct(load);
  const empty = { id: "", name: "", phone: "", city: "", code: "", commissionPct: "10", active: true };
  const [f, setF] = useState(empty);
  const [show, setShow] = useState<string | null>(null);
  const save = () => act(() => call(f.id ? `/platform/agents/${f.id}` : "/platform/agents", {
    method: f.id ? "PUT" : "POST",
    body: { name: f.name, phone: f.phone || null, city: f.city || null, code: f.code, commissionPct: Number(f.commissionPct), active: f.active },
  }), "تم الحفظ").then((ok) => ok && setF(empty));
  if (show) return <AgentPage call={call} id={show} back={() => { setShow(null); void load(); }} open={open} />;
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>{f.id ? "تعديل وكيل" : "وكيل جديد"}</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>المدينة<input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} style={{ width: 120 }} /></label>
          <label>الهاتف<input className="num" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={{ width: 130 }} /></label>
          <label>كود التسجيل<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="MISR1" style={{ width: 110, direction: "ltr" }} /></label>
          <label>العمولة %<input className="num" value={f.commissionPct} onChange={(e) => setF({ ...f, commissionPct: e.target.value })} style={{ width: 70 }} /></label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />شغال</label>
          <button className="primary" onClick={() => void save()}>حفظ</button>
          {f.id && <button onClick={() => setF(empty)}>إلغاء</button>}
        </div>
        <div className="muted">المحل اللي يسجّل برابط الوكيل أو يكتب كوده يتبعه، والوكيل ياخذ نسبته من كل دفعة يدفعها المحل. تقدر تعطيه حساب دخول (دور «وكيل») من تبويب «الفريق» يشوف فيه محلاته وعمولته بس.</div>
      </div>
      <Msg m={msg} />
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>الوكيل</th><th>الكود</th><th>المحلات</th><th>المحصّل منهم</th><th>العمولة</th><th>مدفوع له</th><th>الباقي له</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td><b style={{ cursor: "pointer" }} onClick={() => setShow(a.id)}>{a.name}</b><div className="muted">{a.city} <span className="num">{a.phone}</span></div>{!a.active && <span className="badge off">موقوف</span>}</td>
                <td className="num">{a.code}<div><button className="link" onClick={() => void navigator.clipboard?.writeText(signupLink(a.code))}>نسخ رابط التسجيل</button></div></td>
                <td className="num">{a.shops}<div className="muted">{a.paying} يدفعوا</div></td>
                <td className="num">{formatMoney(a.collected)}</td>
                <td className="num">{formatMoney(a.earned)}<div className="muted">{a.commission_bp / 100}%</div></td>
                <td className="num">{formatMoney(a.paid)}</td>
                <td className="num"><b>{formatMoney(a.balance)}</b></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button onClick={() => setShow(a.id)}>التفاصيل</button>{" "}
                  <button onClick={() => setF({ id: a.id, name: a.name, phone: a.phone ?? "", city: a.city ?? "", code: a.code, commissionPct: String(a.commission_bp / 100), active: a.active })}>تعديل</button>
                </td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={8} className="muted">ما فيش وكلاء.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AgentPage({ call, id, back, open, self }: { call: Call; id?: string; back?: () => void; open?: (id: string) => void; self?: boolean }) {
  const { data, load } = useLoad<AgentDetail>(call, self ? "/platform/agent/me" : `/platform/agents/${id}`);
  const { msg, act } = useAct(load);
  const [amount, setAmount] = useState("");
  if (!data) return <div className="muted">جاري التحميل…</div>;
  const a = data.agent;
  return (
    <div className="stack">
      <div className="row">
        {back && <button onClick={back}>→ رجوع</button>}
        <h2 style={{ margin: 0 }}>{a.name}</h2>
        <span className="muted">{a.city}</span>
      </div>
      <div className="kpis">
        <div className="kpi"><span className="muted">المحلات</span><b className="num">{a.shops}</b><span className="muted">{a.paying} يدفعوا</span></div>
        <div className="kpi"><span className="muted">العمولة ({a.commission_bp / 100}%)</span><b className="num">{formatMoney(a.earned)}</b></div>
        <div className="kpi"><span className="muted">استلم</span><b className="num">{formatMoney(a.paid)}</b></div>
        <div className="kpi"><span className="muted">الباقي له</span><b className="num">{formatMoney(a.balance)}</b></div>
      </div>
      <div className="card row">
        <div><b>رابط التسجيل</b><div className="num" style={{ direction: "ltr" }}>{signupLink(a.code)}</div><div className="muted">أو يكتب صاحب المحل الكود <b className="num">{a.code}</b> وقت التسجيل.</div></div>
        <span className="spacer" />
        <button onClick={() => void navigator.clipboard?.writeText(signupLink(a.code))}>نسخ</button>
      </div>
      {!self && (
        <div className="card row" style={{ alignItems: "end" }}>
          <label>صرف عمولة<input className="num" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={formatMoney(Math.max(a.balance, 0), "")} style={{ width: 120 }} /></label>
          <button className="primary" onClick={() => void act(() => call(`/platform/agents/${a.id}/payouts`, { body: { amountMinor: parseMoney(amount || formatMoney(a.balance, "")) } }), "تم تسجيل الصرف").then((ok) => ok && setAmount(""))}>تسجيل صرف</button>
          <Msg m={msg} />
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>المحلات</h3>
        <table>
          <thead><tr><th>المحل</th><th>اشترك</th><th>مدفوع لين</th><th>دفع</th><th>العمولة</th></tr></thead>
          <tbody>
            {data.shops.map((s) => (
              <tr key={s.id} onClick={() => open?.(s.id)} style={{ cursor: open ? "pointer" : undefined }}>
                <td><b>{s.name}</b> <span className="muted">{s.plan_code}</span></td><td className="num">{date(s.created_at)}</td><td className="num">{date(s.paid_until)}</td>
                <td className="num">{formatMoney(s.paid)}</td><td className="num">{formatMoney(s.commission)}</td>
              </tr>
            ))}
            {data.shops.length === 0 && <tr><td colSpan={5} className="muted">ما فيش محلات بعد.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>المصروف للوكيل</h3>
        {data.payouts.length === 0 ? <p className="muted">ما فيش.</p> : (
          <table><tbody>{data.payouts.map((p) => <tr key={p.id}><td className="num">{date(p.created_at)}</td><td className="num">{formatMoney(p.amount_minor)}</td><td>{p.note}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

// ---- Announcements ----

interface Announcement { id: string; title: string; body: string; level: "info" | "warn" | "promo"; plans: string[] | null; tenant_ids: string[] | null; starts_at: string; ends_at: string | null; active: boolean; seen: number; created_at: string }
const LEVEL_LABEL = { info: "معلومة", warn: "تنبيه", promo: "عرض" };

export function AnnouncementsTab({ call }: { call: Call }) {
  const { data, load } = useLoad<Announcement[]>(call, "/platform/announcements");
  const plans = useLoad<Plan[]>(call, "/platform/plans");
  const { msg, act } = useAct(load);
  const empty = { title: "", body: "", level: "info" as Announcement["level"], plans: [] as string[], endsAt: "", alert: true };
  const [f, setF] = useState(empty);
  const body = (a: Announcement, active: boolean) => ({ title: a.title, body: a.body, level: a.level, plans: a.plans, tenantIds: a.tenant_ids, startsAt: a.starts_at, endsAt: a.ends_at, active });
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>إعلان جديد</h3>
        <label>العنوان<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="مثلاً: صيانة الليلة من 2 لـ 3 الفجر" /></label>
        <label>التفاصيل<textarea rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <div className="row" style={{ alignItems: "end" }}>
          <label>النوع<select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Announcement["level"] })}>{Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <div>
            <div className="muted">لمين</div>
            <div className="row" style={{ gap: 10 }}>
              {(plans.data ?? []).map((p) => (
                <label key={p.code} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: "auto" }} checked={f.plans.includes(p.code)} onChange={(e) => setF({ ...f, plans: e.target.checked ? [...f.plans, p.code] : f.plans.filter((x) => x !== p.code) })} />{p.name}</label>
              ))}
              <span className="muted">{f.plans.length ? "" : "(الكل)"}</span>
            </div>
          </div>
          <label>ينتهي<input type="date" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></label>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={f.alert} onChange={(e) => setF({ ...f, alert: e.target.checked })} />ابعته كمان تنبيه على تلفون المالك</label>
          <button className="primary" onClick={() => void act(() => call("/platform/announcements", { body: {
            title: f.title, body: f.body, level: f.level, plans: f.plans.length ? f.plans : null, endsAt: f.endsAt ? new Date(`${f.endsAt}T23:59:59`).toISOString() : null, alert: f.alert,
          } }), "تم نشر الإعلان").then((ok) => ok && setF(empty))}>نشر</button>
        </div>
        <div className="muted">يظهر شريط فوق في لوحة المحل لين يسكّره كل مستخدم.</div>
      </div>
      <Msg m={msg} />
      <div className="card">
        <table>
          <thead><tr><th>الإعلان</th><th>لمين</th><th>المدة</th><th>سكّروه</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td><span className={`badge ${a.level === "warn" ? "bad" : a.level === "promo" ? "ok" : "off"}`}>{LEVEL_LABEL[a.level]}</span> <b>{a.title}</b><div className="muted">{a.body}</div></td>
                <td>{a.tenant_ids ? `${a.tenant_ids.length} محل` : a.plans ? a.plans.join("، ") : "الكل"}</td>
                <td className="num">{date(a.starts_at)}{a.ends_at ? ` ← ${date(a.ends_at)}` : ""}</td>
                <td className="num">{a.seen}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button onClick={() => void act(() => call(`/platform/announcements/${a.id}`, { method: "PUT", body: body(a, !a.active) }), "تم")}>{a.active ? "إيقاف" : "تشغيل"}</button>{" "}
                  <button className="danger" onClick={() => confirm("نحذف الإعلان؟") && void act(() => call(`/platform/announcements/${a.id}`, { method: "DELETE" }), "تم الحذف")}>حذف</button>
                </td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={5} className="muted">ما فيش إعلانات.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Support tickets ----

interface TicketRow { id: string; number: number; subject: string; status: "open" | "answered" | "closed"; created_at: string; updated_at: string; tenant_id: string; tenant_name: string; phone: string | null; assigned_name: string | null; messages: number }
export interface TicketView { id: string; number: number; subject: string; status: TicketRow["status"]; created_at: string; tenant_id?: string; tenant_name?: string; phone?: string | null; support_until?: string | null; messages: { id: string; author: "shop" | "platform"; body: string; created_at: string; name: string | null }[] }
export const TICKET_LABEL = { open: "مفتوح", answered: "تم الرد", closed: "مقفول" };
export const TICKET_BADGE = { open: "bad", answered: "ok", closed: "off" };

export function TicketsTab({ call, open, supportLogin }: { call: Call; open: (id: string) => void; supportLogin: (tenantId: string) => void }) {
  const [status, setStatus] = useState<"open" | "answered" | "closed" | "all">("open");
  const { data, load } = useLoad<{ rows: TicketRow[]; counts: Record<string, number> }>(call, `/platform/tickets?status=${status}`);
  const [sel, setSel] = useState<string | null>(null);
  if (sel) return <TicketPage call={call} id={sel} back={() => { setSel(null); void load(); }} open={open} supportLogin={supportLogin} />;
  return (
    <div className="stack">
      <div className="tabs">
        {(["open", "answered", "closed", "all"] as const).map((s) => (
          <button key={s} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>{s === "all" ? "الكل" : TICKET_LABEL[s]}{s !== "all" && data?.counts[s] ? ` (${data.counts[s]})` : ""}</button>
        ))}
      </div>
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>الموضوع</th><th>المحل</th><th>آخر تحديث</th><th>الحالة</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map((t) => (
              <tr key={t.id} onClick={() => setSel(t.id)} style={{ cursor: "pointer" }}>
                <td className="num">{t.number}</td><td><b>{t.subject}</b><div className="muted">{t.messages} رسالة{t.assigned_name ? ` · ${t.assigned_name}` : ""}</div></td>
                <td>{t.tenant_name}</td><td className="num">{when(t.updated_at)}</td><td><span className={`badge ${TICKET_BADGE[t.status]}`}>{TICKET_LABEL[t.status]}</span></td>
              </tr>
            ))}
            {data?.rows.length === 0 && <tr><td colSpan={5} className="muted">ما فيش طلبات.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Conversation({ t }: { t: TicketView }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {t.messages.map((m) => (
        <div key={m.id} className="card" style={{ padding: 10, background: m.author === "platform" ? "var(--ok-bg, #eef8f1)" : undefined, marginInlineStart: m.author === "platform" ? 40 : 0, marginInlineEnd: m.author === "shop" ? 40 : 0 }}>
          <div className="muted" style={{ fontSize: ".8rem" }}>{m.author === "platform" ? "الدعم الفني" : "المحل"} · {m.name} · <span className="num">{when(m.created_at)}</span></div>
          <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
        </div>
      ))}
    </div>
  );
}

function TicketPage({ call, id, back, open, supportLogin }: { call: Call; id: string; back: () => void; open: (id: string) => void; supportLogin: (tenantId: string) => void }) {
  const { data, load } = useLoad<TicketView>(call, `/platform/tickets/${id}`);
  const { msg, act } = useAct(load);
  const [reply, setReply] = useState("");
  if (!data) return <div className="muted">جاري التحميل…</div>;
  const canLook = data.support_until && new Date(data.support_until) > new Date();
  return (
    <div className="stack">
      <div className="row">
        <button onClick={back}>→ رجوع</button>
        <h2 style={{ margin: 0 }}>#{data.number} {data.subject}</h2>
        <span className={`badge ${TICKET_BADGE[data.status]}`}>{TICKET_LABEL[data.status]}</span>
        <span className="spacer" />
        <button onClick={() => open(data.tenant_id!)}>{data.tenant_name}</button>
        {canLook ? <button onClick={() => supportLogin(data.tenant_id!)}>👁 افتح حساب المحل (قراءة بس)</button> : <span className="muted">المحل ما سمحش بالدخول للدعم</span>}
      </div>
      <Conversation t={data} />
      <div className="card stack">
        <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="الرد على المحل…" />
        <div className="row">
          <button className="primary" disabled={!reply.trim()} onClick={() => void act(() => call(`/platform/tickets/${id}/reply`, { body: { body: reply } }), "تم الإرسال").then((ok) => ok && setReply(""))}>إرسال</button>
          <button disabled={!reply.trim()} onClick={() => void act(() => call(`/platform/tickets/${id}/reply`, { body: { body: reply, close: true } }), "تم الإرسال والقفل").then((ok) => ok && setReply(""))}>إرسال وقفل</button>
          <span className="spacer" />
          {data.status !== "closed" && <button onClick={() => void act(() => call(`/platform/tickets/${id}`, { method: "PATCH", body: { status: "closed" } }), "تم القفل")}>قفل بدون رد</button>}
        </div>
        <Msg m={msg} />
      </div>
    </div>
  );
}

// ---- Team ----

interface Member { id: string; name: string; email: string; role: PlatformRole; active: boolean; totp_enabled: boolean; last_login_at: string | null; agent_id: string | null; agent_name: string | null }
const ROLE_HELP: Record<PlatformRole, string> = {
  owner: "كل شي، والفريق",
  manager: "كل شي ما عدا الفريق",
  accountant: "الدفعات والإيرادات والكوبونات والوكلاء والسجل",
  support: "المحلات وتذاكر الدعم والإعلانات والتذكيرات والدخول للدعم",
  agent: "محلاته وعمولته بس",
};

export function TeamTab({ call }: { call: Call }) {
  const { data, load } = useLoad<Member[]>(call, "/platform/team");
  const agents = useLoad<Agent[]>(call, "/platform/agents");
  const { msg, act } = useAct(load);
  const empty = { name: "", email: "", role: "support" as PlatformRole, password: "", agentId: "" };
  const [f, setF] = useState(empty);
  return (
    <div className="stack">
      <div className="card stack">
        <h3 style={{ margin: 0 }}>عضو جديد</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label>الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>البريد<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ direction: "ltr" }} /></label>
          <label>الدور<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as PlatformRole })}>{PLATFORM_ROLES.map((r) => <option key={r} value={r}>{PLATFORM_ROLE_LABELS[r]}</option>)}</select></label>
          {f.role === "agent" && <label>الوكيل<select value={f.agentId} onChange={(e) => setF({ ...f, agentId: e.target.value })}><option value="">—</option>{(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          <label>كلمة السر<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></label>
          <button className="primary" onClick={() => void act(() => call("/platform/team", { body: { ...f, agentId: f.agentId || null } }), "تمت الإضافة").then((ok) => ok && setF(empty))}>إضافة</button>
        </div>
        <div className="muted">{PLATFORM_ROLE_LABELS[f.role]}: {ROLE_HELP[f.role]}.</div>
      </div>
      <Msg m={msg} />
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>الاسم</th><th>الدور</th><th>تحقق بخطوتين</th><th>آخر دخول</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((m) => (
              <tr key={m.id}>
                <td><b>{m.name}</b><div className="muted num">{m.email}</div>{!m.active && <span className="badge off">موقوف</span>}</td>
                <td>
                  <select value={m.role} onChange={(e) => void act(() => call(`/platform/team/${m.id}`, { method: "PATCH", body: { role: e.target.value, agentId: m.agent_id } }), "تم تغيير الدور")} style={{ width: "auto" }}>
                    {PLATFORM_ROLES.map((r) => <option key={r} value={r}>{PLATFORM_ROLE_LABELS[r]}</option>)}
                  </select>
                  {m.agent_name && <div className="muted">{m.agent_name}</div>}
                </td>
                <td>{m.totp_enabled ? <span className="badge ok">مفعّل</span> : <span className="badge off">لا</span>}</td>
                <td className="num">{m.last_login_at ? when(m.last_login_at) : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button onClick={() => { const p = prompt("كلمة السر الجديدة (8 أحرف على الأقل). يتلغى التحقق بخطوتين ويعيد إعداده."); if (p) void act(() => call(`/platform/team/${m.id}`, { method: "PATCH", body: { password: p } }), "تم تغيير كلمة السر"); }}>كلمة السر</button>{" "}
                  <button className={m.active ? "danger" : ""} onClick={() => void act(() => call(`/platform/team/${m.id}`, { method: "PATCH", body: { active: !m.active } }), m.active ? "تم الإيقاف" : "تم التفعيل")}>{m.active ? "إيقاف" : "تفعيل"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Audit log ----

interface AuditRow { id: string; at: string; action: string; data: Record<string, unknown> | null; tenant_id: string | null; tenant_name: string | null; admin_name: string | null; admin_role: PlatformRole | null }
const ACTION_LABEL: Record<string, string> = {
  "admin.login": "دخول", "admin.2fa_on": "فعّل التحقق بخطوتين", "admin.2fa_off": "لغى التحقق بخطوتين", "admin.2fa_failed": "رمز تحقق غلط",
  "payment.record": "سجّل دفعة", "tenant.update": "عدّل محل", "plan.save": "عدّل باقة", "settings.save": "عدّل الإعدادات",
  "team.add": "أضاف عضو", "team.edit": "عدّل عضو", "coupon.add": "أضاف كوبون", "coupon.edit": "عدّل كوبون",
  "agent.add": "أضاف وكيل", "agent.edit": "عدّل وكيل", "agent.payout": "صرف عمولة", "announcement.add": "نشر إعلان", "announcement.edit": "عدّل إعلان", "announcement.delete": "حذف إعلان",
  "ticket.reply": "رد على تذكرة", "support.login": "دخل حساب محل للدعم", "reminders.run": "فحص التذكيرات", "reminder.sent": "بعت تذكير",
};
const GROUPS = { "": "الكل", admin: "الدخول", payment: "الدفعات", tenant: "المحلات", team: "الفريق", coupon: "الكوبونات", agent: "الوكلاء", support: "دخول الدعم", settings: "الإعدادات" };

export function AuditTab({ call, open }: { call: Call; open: (id: string) => void }) {
  const [group, setGroup] = useState<keyof typeof GROUPS>("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [more, setMore] = useState(true);
  const page = useCallback(async (before?: string) => {
    const r = await call<AuditRow[]>(`/platform/audit?limit=100${group ? `&action=${group}.` : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    setRows((x) => (before ? [...x, ...r] : r));
    setMore(r.length === 100);
  }, [call, group]);
  useEffect(() => void page(), [page]);
  const detail = (d: Record<string, unknown> | null) => {
    if (!d) return "";
    if (d.amountMinor) return `${d.months ?? ""} شهر · ${formatMoney(Number(d.amountMinor))}${d.invoice ? ` · فاتورة ${d.invoice}` : ""}`;
    return Object.entries(d).filter(([, v]) => v !== undefined && v !== null && typeof v !== "object").map(([k, v]) => `${k}: ${v}`).join(" · ").slice(0, 160);
  };
  return (
    <div className="stack">
      <div className="row">
        <select value={group} onChange={(e) => setGroup(e.target.value as keyof typeof GROUPS)} style={{ width: "auto" }}>
          {Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="muted">كل عملية يديرها فريق المنصة تتسجل هنا، وما تنمسحش ولا تتعدل.</span>
        <span className="spacer" />
        <button onClick={() => downloadCsv("سجل-المنصة", ["الوقت", "الشخص", "العملية", "المحل", "التفاصيل"], rows.map((r) => [when(r.at), r.admin_name ?? "", ACTION_LABEL[r.action] ?? r.action, r.tenant_name ?? "", detail(r.data)]))}>⬇ Excel</button>
      </div>
      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>الوقت</th><th>مين</th><th>العملية</th><th>المحل</th><th>التفاصيل</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{when(r.at)}</td>
                <td>{r.admin_name}{r.admin_role && <div className="muted">{PLATFORM_ROLE_LABELS[r.admin_role]}</div>}</td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td>{r.tenant_id ? <button className="link" onClick={() => open(r.tenant_id!)}>{r.tenant_name ?? "محل"}</button> : ""}</td>
                <td className="muted">{detail(r.data)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && rows.length > 0 && <div><button onClick={() => void page(rows.at(-1)!.at)}>أقدم…</button></div>}
    </div>
  );
}

// ---- My account: two-step sign-in ----

export function MyAccount({ call }: { call: Call }) {
  const { data, load } = useLoad<{ name: string; email: string; role: PlatformRole; totp_enabled: boolean }>(call, "/platform/me");
  const { msg, act } = useAct(load);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  if (!data) return <div className="muted">جاري التحميل…</div>;
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <h3 style={{ margin: 0 }}>حسابي</h3>
      <div>{data.name} · <span className="num">{data.email}</span> · {PLATFORM_ROLE_LABELS[data.role]}</div>
      <h4 style={{ margin: "8px 0 0" }}>التحقق بخطوتين</h4>
      {data.totp_enabled ? (
        <>
          <div className="badge ok">مفعّل ✓ يطلب منك رمز التطبيق مع كل دخول.</div>
          <div className="row"><input className="num" placeholder="الرمز الحالي" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 140 }} />
            <button className="danger" onClick={() => void act(() => call("/platform/2fa/disable", { body: { code } }), "تم الإلغاء").then(() => setCode(""))}>إلغاء التحقق</button></div>
        </>
      ) : setup ? (
        <>
          <p style={{ margin: 0 }}>افتح تطبيق Google Authenticator أو Microsoft Authenticator، اختار «إضافة حساب» ثم «إدخال مفتاح»، واكتب هذا المفتاح:</p>
          <div className="num" style={{ direction: "ltr", fontSize: "1.1rem", letterSpacing: 2, userSelect: "all" }}>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
          <div className="row"><input className="num" placeholder="الرمز من التطبيق" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 160 }} />
            <button className="primary" onClick={() => void act(() => call("/platform/2fa/enable", { body: { code } }), "تم التفعيل ✓").then((ok) => ok && (setSetup(null), setCode("")))}>تفعيل</button></div>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>حماية إضافية: حتى لو حد عرف كلمة السر، ما يقدرش يدخل من غير الرمز اللي في تلفونك. ننصح بيها لكل الفريق.</p>
          <div><button className="primary" onClick={() => void call<{ secret: string; uri: string }>("/platform/2fa/setup", { body: {} }).then(setSetup)}>إعداد التحقق بخطوتين</button></div>
        </>
      )}
      <Msg m={msg} />
    </div>
  );
}

export function HealthBadge({ h }: { h: Health }) {
  return <span className={`badge ${HEALTH_BADGE[h]}`}>{HEALTH_LABELS[h]}</span>;
}
