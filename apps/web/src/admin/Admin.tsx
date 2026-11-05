import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { session } from "../session";
import type { Screen } from "../App";
import { Products } from "./Products";
import { Reports } from "./Reports";
import { Home } from "./Home";
import { Staff } from "./Staff";
import { Devices } from "./Devices";
import { Customers } from "./Customers";
import { Purchasing } from "./Purchasing";
import { Branches } from "./Branches";
import { Offers } from "./Offers";
import { Labels, type LabelDraft } from "./Labels";
import { Subscription, subNotice, type Sub } from "./Subscription";
import { Expenses } from "./Expenses";
import { Alerts } from "../owner/Alerts";
import { AlertSettings, BackupCard, RestoreCard } from "../owner/Settings";
import { setPreferredView } from "../owner/Owner";
import { Payroll } from "./Payroll";
import { Money } from "./Money";
import { MyPay } from "./MyPay";
import { ROLE_NAMES, type Permission } from "@pos/shared";

export interface Me {
  user: { id: string; name: string; role: string; job_title?: string | null; permissions: Permission[] };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; address: string | null; receipt_footer: string | null; active: boolean }[];
}

export type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** The owner's screens, grouped as they appear in the side menu. */
const NAV = [
  { group: "", items: { home: ["🏠", "لوحة التحكم"], reports: ["📊", "التقارير"], alerts: ["🔔", "التنبيهات"] } },
  { group: "المخزون", items: { products: ["📦", "الأصناف والأقسام"], purchasing: ["🚚", "المشتريات والموردين"], branches: ["🏬", "الفروع والتحويلات"], labels: ["🏷️", "ملصقات الباركود"] } },
  { group: "المبيعات", items: { customers: ["👥", "العملاء والديون"], offers: ["🎁", "العروض"] } },
  { group: "المال", items: { money: ["🏦", "الخزينة والأرصدة"], expenses: ["💸", "المصروفات"] } },
  { group: "الموظفين", items: { staff: ["🧑‍💼", "الموظفين والصلاحيات"], payroll: ["💰", "الرواتب"], mypay: ["💼", "راتبي"] } },
  { group: "الإدارة", items: { devices: ["🖥️", "الأجهزة"], backup: ["💾", "النسخ الاحتياطي"], subscription: ["⭐", "الاشتراك"] } },
] as const;
type ItemKeys<T> = T extends { items: infer I } ? keyof I : never;
type Tab = ItemKeys<(typeof NAV)[number]>;
const TABS = Object.assign({}, ...NAV.map((g) => g.items)) as Record<Tab, readonly [string, string]>;

/** What opens each screen. "owner" = the shop owner only; null = everyone (their own pay). */
const NEEDS: Record<Tab, Permission | "owner" | null> = {
  home: "reports", reports: "reports", alerts: "alerts", products: "products", purchasing: "purchasing", branches: "branches", labels: "products",
  customers: "customers", offers: "offers", expenses: "expenses", money: "money", staff: "staff", payroll: "payroll", mypay: null, devices: "devices",
  backup: "owner", subscription: "owner",
};

export function Admin({ go }: { go: (s: Screen) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTabState] = useState<Tab>("home");
  const [menu, setMenu] = useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    setMenu(false);
    window.scrollTo?.(0, 0);
  };
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
  const [labelDraft, setLabelDraft] = useState<LabelDraft[] | null>(null);
  const [storeId, setStoreId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("pos.adminStore");
    } catch {
      return null;
    }
  });
  const pickStore = (id: string) => {
    setStoreId(id);
    try {
      localStorage.setItem("pos.adminStore", id);
    } catch {
      /* private mode */
    }
  };

  const logout = useCallback(() => {
    session.adminToken = null;
    go(session.deviceToken ? "pin" : "setup");
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

  const loadMe = useCallback(() => call<Me>("/me").then(setMe).catch((e) => setError((e as Error).message)), [call]);
  useEffect(() => {
    void loadMe();
    call<Sub>("/subscription")
      .then((s) => {
        setSub(s);
        if (["locked", "suspended", "cancelled"].includes(s.state) || new URLSearchParams(location.search).has("payment")) setTab("subscription");
      })
      .catch(() => setSub(null));
  }, [call, loadMe]);
  const notice = sub && subNotice(sub);

  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!me) return <div className="center muted">جاري التحميل…</div>;
  const open = me.stores.filter((s) => s.active);
  const store = open.find((s) => s.id === storeId) ?? open[0] ?? me.stores[0];

  const isOwner = me.user.role === "owner";
  const can = (t: Tab) => {
    const n = NEEDS[t];
    return n === null || isOwner || (n !== "owner" && me.user.permissions.includes(n));
  };
  // Someone who can't see the dashboard starts on the first screen they can open.
  const shown: Tab = can(tab) ? tab : ((Object.keys(TABS) as Tab[]).find(can) ?? "mypay");
  return (
    <div className={`shell ${menu ? "menu-open" : ""}`}>
      <aside className="side">
        <div className="side-brand">
          <div className="logo">{me.tenant.name.trim().slice(0, 1)}</div>
          <div style={{ minWidth: 0 }}>
            <b className="ellipsis">{me.tenant.name}</b>
            {open.length > 1 ? (
              <select value={store.id} onChange={(e) => pickStore(e.target.value)} aria-label="الفرع">
                {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : <small>{store.name}</small>}
          </div>
        </div>
        <nav>
          {NAV.map((g) => ({ g, keys: (Object.keys(g.items) as Tab[]).filter(can) })).filter((x) => x.keys.length).map(({ g, keys }) => (
            <div key={g.group} className="side-group">
              {g.group && <small>{g.group}</small>}
              {keys.map((k) => (
                <button key={k} className={shown === k ? "active" : ""} onClick={() => setTab(k)}>
                  <span className="side-icon">{TABS[k][0]}</span>{TABS[k][1]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="avatar">{me.user.name.trim().slice(0, 1)}</div>
          <div style={{ minWidth: 0, flex: 1 }}><b className="ellipsis">{me.user.name}</b><small>{me.user.job_title || ROLE_NAMES[me.user.role as keyof typeof ROLE_NAMES]}</small></div>
          <button className="ghost" onClick={logout}>خروج</button>
        </div>
      </aside>
      <div className="side-scrim" onClick={() => setMenu(false)} />
      <main className="main">
        <header className="topbar">
          <button className="ghost burger" onClick={() => setMenu(true)} aria-label="القائمة">☰</button>
          <h1>{TABS[shown][0]} {TABS[shown][1]}</h1>
          <span className="spacer" />
          {can("reports") && <button onClick={() => { setPreferredView("owner"); go("owner"); }}>📱 عرض التلفون</button>}
          {session.deviceToken && <button className="primary" onClick={() => go("pin")}>🛒 شاشة الكاشير</button>}
        </header>
        {notice && isOwner && shown !== "subscription" && (
          <div className={notice.bad ? "error" : "notice"} onClick={() => setTab("subscription")} style={{ cursor: "pointer" }}>
            {notice.text} <u>التفاصيل</u>
          </div>
        )}
        <div className="stack" key={store.id}>
          {shown === "home" && <Home call={call} storeId={store.id} userName={me.user.name} open={setTab} />}
          {shown === "reports" && <Reports call={call} storeId={store.id} stores={open} />}
          {shown === "products" && <Products call={call} storeId={store.id} />}
          {shown === "purchasing" && <Purchasing call={call} storeId={store.id} onLabels={(d) => { setLabelDraft(d); setTab("labels"); }} />}
          {shown === "labels" && <Labels call={call} storeId={store.id} storeName={me.tenant.name} draft={labelDraft} clearDraft={() => setLabelDraft(null)} />}
          {shown === "branches" && <Branches call={call} storeId={store.id} isOwner={isOwner} onStoresChanged={loadMe} />}
          {shown === "offers" && <Offers call={call} storeId={store.id} stores={me.stores} />}
          {shown === "customers" && <Customers call={call} />}
          {shown === "alerts" && <><Alerts call={call} /><AlertSettings call={call} isOwner={isOwner} /></>}
          {shown === "expenses" && <Expenses call={call} storeId={store.id} stores={open} />}
          {shown === "backup" && (isOwner ? <><BackupCard /><RestoreCard /></> : <div className="notice">النسخة الاحتياطية لصاحب المحل فقط</div>)}
          {shown === "staff" && <Staff call={call} isOwner={isOwner} mine={me.user.permissions} />}
          {shown === "payroll" && <Payroll call={call} storeId={store.id} />}
          {shown === "money" && <Money call={call} />}
          {shown === "mypay" && <MyPay token={session.adminToken} />}
          {shown === "subscription" && <Subscription call={call} />}
          {shown === "devices" && <Devices call={call} storeId={store.id} storeName={store.name} go={go} isOwner={isOwner} />}
        </div>
      </main>
    </div>
  );
}
