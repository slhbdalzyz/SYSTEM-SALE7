import { useCallback, useEffect, useState } from "react";
import { formatMoney, formatQty } from "@pos/shared";
import { api, ApiError } from "../api";
import { session } from "../session";
import type { Screen } from "../App";
import type { Call, Me } from "../admin/Admin";
import { Expenses } from "../admin/Expenses";
import { Alerts, ago } from "./Alerts";
import { AlertSettings, BackupCard } from "./Settings";

export interface Dashboard {
  date: string;
  today: { totalMinor: number; salesCount: number; avgMinor: number; profitMinor: number; expensesMinor: number; netMinor: number; yesterdayUntilNowMinor: number; yesterdayMinor: number };
  month: { totalMinor: number; salesCount: number; profitMinor: number; expensesMinor: number; netMinor: number };
  week: { day: string; totalMinor: number; salesCount: number; profitMinor: number }[];
  stores: { id: string; name: string; totalMinor: number; salesCount: number }[];
  lowStock: { count: number; items: { id: string; name: string; storeName: string; stockMilli: number; minMilli: number; weighted: boolean }[] };
  openShifts: { id: string; cashier: string; device: string; storeName: string; openedAt: string; expectedCashMinor: number }[];
  customersOweMinor: number;
  weOweMinor: number;
  unreadAlerts: number;
}

type Tab = "home" | "alerts" | "expenses" | "more";
const DAYS = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];
const dayName = (iso: string) => DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];

function store(k: string, v?: string | null): string | null {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
  return null;
}

/** Remembers which screen the owner prefers on this device: the phone view or the full admin. */
export const setPreferredView = (v: "owner" | "admin") => store("pos.view", v);
export function prefersOwnerView(): boolean {
  const q = new URLSearchParams(location.search).get("view");
  if (q === "owner" || q === "admin") return q === "owner";
  const saved = store("pos.view");
  if (saved) return saved === "owner";
  return typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 760px)").matches;
}

/** The shop owner's phone: today at a glance, alerts, expenses, and the rest one tap away. */
export function Owner({ go }: { go: (s: Screen) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get("tab") === "alerts" ? "alerts" : "home"));
  const [storeId, setStoreId] = useState<string | null>(() => store("pos.ownerStore"));
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const logout = useCallback(() => {
    session.adminToken = null;
    go("setup");
  }, [go]);
  const call: Call = useCallback(
    async (path, opts) => {
      try {
        return await api(path, { ...opts, token: session.adminToken });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) logout();
        throw e;
      }
    },
    [logout],
  );
  useEffect(() => void call<Me>("/me").then(setMe).catch((e) => setError((e as Error).message)), [call]);

  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!me) return <div className="center muted">جاري التحميل…</div>;
  const open = me.stores.filter((s) => s.active);
  const current = open.find((s) => s.id === storeId) ? storeId : null;
  const pick = (id: string | null) => {
    setStoreId(id);
    store("pos.ownerStore", id);
  };
  const full = () => {
    setPreferredView("admin");
    go("admin");
  };

  return (
    <div className="owner">
      <header className="owner-top">
        <div>
          <b>{me.tenant.name}</b>
          {open.length > 1 ? (
            <select value={current ?? ""} onChange={(e) => pick(e.target.value || null)} aria-label="الفرع">
              <option value="">كل الفروع</option>
              {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (
            <span className="muted small"> · {open[0]?.name}</span>
          )}
        </div>
        <button className="bell" onClick={() => setTab("alerts")} aria-label="التنبيهات">
          🔔{unread > 0 && <span className="dot num">{unread > 99 ? "99+" : unread}</span>}
        </button>
      </header>
      <main className="owner-main">
        {tab === "home" && <Home call={call} storeId={current} onUnread={setUnread} />}
        {tab === "alerts" && <Alerts call={call} onRead={setUnread} />}
        {tab === "expenses" && <Expenses key={current ?? "all"} call={call} storeId={current} stores={open} />}
        {tab === "more" && (
          <div className="stack">
            <AlertSettings call={call} isOwner={me.user.role === "owner"} />
            {me.user.role === "owner" && <BackupCard />}
            <div className="card stack">
              <b>{me.user.name}</b>
              <button onClick={full}>الإدارة الكاملة (الأصناف، المشتريات، الموظفين…)</button>
              {session.deviceToken && <button onClick={() => go("pin")}>شاشة الكاشير</button>}
              <button className="danger" onClick={logout}>خروج</button>
            </div>
          </div>
        )}
      </main>
      <nav className="owner-nav">
        {([["home", "🏠", "اليوم"], ["alerts", "🔔", "التنبيهات"], ["expenses", "🧾", "المصروفات"], ["more", "⚙️", "المزيد"]] as const).map(([k, icon, label]) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            <span aria-hidden>{icon}</span>
            {label}
            {k === "alerts" && unread > 0 && <span className="dot num">{unread}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Change({ now, then }: { now: number; then: number }) {
  if (!then) return null;
  const pct = Math.round(((now - then) / Math.abs(then)) * 100);
  return <span className={`change ${pct >= 0 ? "up" : "down"}`}>{pct >= 0 ? "▲" : "▼"} <span className="num">{Math.abs(pct)}%</span></span>;
}

function Home({ call, storeId, onUnread }: { call: Call; storeId: string | null; onUnread: (n: number) => void }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<Dashboard>(`/dashboard${storeId ? `?storeId=${storeId}` : ""}`);
      setD(r);
      setAt(new Date());
      setError(null);
      onUnread(r.unreadAlerts);
    } catch (e) {
      setError((e as ApiError).status === 0 ? "ما فيش نت. هذي آخر أرقام وصلت." : (e as Error).message);
    }
  }, [call, storeId, onUnread]);

  useEffect(() => {
    void load();
    // Fresh numbers every minute while the screen is in front of the owner.
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load]);

  if (!d) return error ? <div className="error">{error}</div> : <div className="muted">جاري التحميل…</div>;
  const max = Math.max(1, ...d.week.map((w) => w.totalMinor));
  const t = d.today;

  return (
    <div className="stack">
      {error && <div className="error">{error}</div>}
      <section className="hero">
        <span>مبيعات اليوم</span>
        <b className="num">{formatMoney(t.totalMinor)}</b>
        <span className="small">
          أمس لين نفس الوقت <span className="num">{formatMoney(t.yesterdayUntilNowMinor)}</span> <Change now={t.totalMinor} then={t.yesterdayUntilNowMinor} />
        </span>
      </section>
      <div className="tiles">
        <div className="tile"><span className="muted">الفواتير</span><b className="num">{t.salesCount}</b></div>
        <div className="tile"><span className="muted">متوسط الفاتورة</span><b className="num">{formatMoney(t.avgMinor)}</b></div>
        <div className="tile"><span className="muted">الربح بعد التكلفة</span><b className="num">{formatMoney(t.profitMinor)}</b></div>
        <div className="tile"><span className="muted">الصافي بعد المصاريف</span><b className={`num${t.netMinor < 0 ? " neg" : ""}`}>{formatMoney(t.netMinor)}</b></div>
      </div>

      <section className="card stack">
        <b>آخر 7 أيام</b>
        <div className="bars" role="list">
          {d.week.map((w) => (
            <div key={w.day} className={`bar${w.day === d.date ? " today" : ""}`} role="listitem" title={`${w.day}: ${formatMoney(w.totalMinor)}`}>
              <span className="bar-val num">{w.totalMinor ? Math.round(w.totalMinor / 1000).toLocaleString("en-US") : ""}</span>
              <div className="bar-track"><div className="bar-fill" style={{ height: `${Math.max(2, (w.totalMinor / max) * 100)}%` }} /></div>
              <span className="bar-day">{w.day === d.date ? "اليوم" : dayName(w.day)}</span>
            </div>
          ))}
        </div>
        <span className="muted small">بالدينار، بعد المرتجعات</span>
      </section>

      <section className="card stack">
        <b>الشهر لين توا</b>
        <div className="kv"><span>المبيعات ({d.month.salesCount} فاتورة)</span><b className="num">{formatMoney(d.month.totalMinor)}</b></div>
        <div className="kv"><span>الربح بعد تكلفة البضاعة</span><b className="num">{formatMoney(d.month.profitMinor)}</b></div>
        <div className="kv"><span>المصاريف</span><b className="num">− {formatMoney(d.month.expensesMinor)}</b></div>
        <div className="kv total"><span>الصافي</span><b className={`num${d.month.netMinor < 0 ? " neg" : ""}`}>{formatMoney(d.month.netMinor)}</b></div>
      </section>

      {d.stores.length > 1 && (
        <section className="card stack">
          <b>الفروع اليوم</b>
          {d.stores.map((s) => <div key={s.id} className="kv"><span>{s.name} <span className="muted small">({s.salesCount})</span></span><b className="num">{formatMoney(s.totalMinor)}</b></div>)}
        </section>
      )}

      <section className="card stack">
        <b>الكاشيرات المفتوحة</b>
        {d.openShifts.length === 0 && <span className="muted">ما فيش وردية مفتوحة</span>}
        {d.openShifts.map((s) => (
          <div key={s.id} className="kv">
            <span>{s.cashier} <span className="muted small">· {s.device}{d.stores.length > 1 ? ` · ${s.storeName}` : ""} · فتح {ago(s.openedAt)}</span></span>
            <span><span className="muted small">في الدرج </span><b className="num">{formatMoney(s.expectedCashMinor)}</b></span>
          </div>
        ))}
      </section>

      <section className="card stack">
        <div className="row"><b>النواقص</b>{d.lowStock.count > 0 && <span className="badge bad num">{d.lowStock.count}</span>}</div>
        {d.lowStock.count === 0 && <span className="muted">كل الأصناف فوق الحد الأدنى</span>}
        {d.lowStock.items.map((p) => (
          <div key={`${p.id}-${p.storeName}`} className="kv">
            <span>{p.name}{d.stores.length > 1 ? <span className="muted small"> · {p.storeName}</span> : null}</span>
            <span className={p.stockMilli <= 0 ? "neg" : "warn"}>
              {p.stockMilli <= 0 ? "خلص" : <>باقي <span className="num">{formatQty(p.stockMilli, p.weighted)}</span></>}
              <span className="muted small"> / <span className="num">{formatQty(p.minMilli, p.weighted)}</span></span>
            </span>
          </div>
        ))}
        {d.lowStock.count > d.lowStock.items.length && <span className="muted small">و{d.lowStock.count - d.lowStock.items.length} غيرهم في صفحة المشتريات</span>}
      </section>

      <section className="card stack">
        <b>الديون</b>
        <div className="kv"><span>على الزبائن (لينا)</span><b className="num">{formatMoney(d.customersOweMinor)}</b></div>
        <div className="kv"><span>للموردين (علينا)</span><b className="num">{formatMoney(d.weOweMinor)}</b></div>
      </section>
      {at && <div className="muted small" style={{ textAlign: "center" }}>آخر تحديث {at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · <button className="link" onClick={load}>تحديث</button></div>}
    </div>
  );
}
