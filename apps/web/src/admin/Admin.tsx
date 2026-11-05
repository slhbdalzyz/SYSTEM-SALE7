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

export interface Me {
  user: { id: string; name: string; role: string };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; address: string | null; receipt_footer: string | null; active: boolean }[];
}

export type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/** The owner's screens, grouped as they appear in the side menu. */
const NAV = [
  { group: "", items: { home: ["🏠", "لوحة التحكم"], reports: ["📊", "التقارير"], alerts: ["🔔", "التنبيهات"] } },
  { group: "المخزون", items: { products: ["📦", "الأصناف والأقسام"], purchasing: ["🚚", "المشتريات والموردين"], branches: ["🏬", "الفروع والتحويلات"], labels: ["🏷️", "ملصقات الباركود"] } },
  { group: "المبيعات", items: { customers: ["👥", "العملاء والديون"], offers: ["🎁", "العروض"], expenses: ["💸", "المصروفات"] } },
  { group: "الإدارة", items: { staff: ["🧑‍💼", "الموظفين"], devices: ["🖥️", "الأجهزة"], backup: ["💾", "النسخ الاحتياطي"], subscription: ["⭐", "الاشتراك"] } },
] as const;
type ItemKeys<T> = T extends { items: infer I } ? keyof I : never;
type Tab = ItemKeys<(typeof NAV)[number]>;
const TABS = Object.assign({}, ...NAV.map((g) => g.items)) as Record<Tab, readonly [string, string]>;

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
          {NAV.map((g) => (
            <div key={g.group} className="side-group">
              {g.group && <small>{g.group}</small>}
              {(Object.keys(g.items) as Tab[]).map((k) => (
                <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                  <span className="side-icon">{TABS[k][0]}</span>{TABS[k][1]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="avatar">{me.user.name.trim().slice(0, 1)}</div>
          <div style={{ minWidth: 0, flex: 1 }}><b className="ellipsis">{me.user.name}</b><small>{isOwner ? "صاحب المحل" : "مدير"}</small></div>
          <button className="ghost" onClick={logout}>خروج</button>
        </div>
      </aside>
      <div className="side-scrim" onClick={() => setMenu(false)} />
      <main className="main">
        <header className="topbar">
          <button className="ghost burger" onClick={() => setMenu(true)} aria-label="القائمة">☰</button>
          <h1>{TABS[tab][0]} {TABS[tab][1]}</h1>
          <span className="spacer" />
          <button onClick={() => { setPreferredView("owner"); go("owner"); }}>📱 عرض التلفون</button>
          {session.deviceToken && <button className="primary" onClick={() => go("pin")}>🛒 شاشة الكاشير</button>}
        </header>
        {notice && tab !== "subscription" && (
          <div className={notice.bad ? "error" : "notice"} onClick={() => setTab("subscription")} style={{ cursor: "pointer" }}>
            {notice.text} <u>التفاصيل</u>
          </div>
        )}
        <div className="stack" key={store.id}>
          {tab === "home" && <Home call={call} storeId={store.id} userName={me.user.name} open={setTab} />}
          {tab === "reports" && <Reports call={call} storeId={store.id} stores={open} />}
          {tab === "products" && <Products call={call} storeId={store.id} />}
          {tab === "purchasing" && <Purchasing call={call} storeId={store.id} onLabels={(d) => { setLabelDraft(d); setTab("labels"); }} />}
          {tab === "labels" && <Labels call={call} storeId={store.id} storeName={me.tenant.name} draft={labelDraft} clearDraft={() => setLabelDraft(null)} />}
          {tab === "branches" && <Branches call={call} storeId={store.id} isOwner={isOwner} onStoresChanged={loadMe} />}
          {tab === "offers" && <Offers call={call} storeId={store.id} stores={me.stores} />}
          {tab === "customers" && <Customers call={call} />}
          {tab === "alerts" && <><Alerts call={call} /><AlertSettings call={call} isOwner={isOwner} /></>}
          {tab === "expenses" && <Expenses call={call} storeId={store.id} stores={open} />}
          {tab === "backup" && (isOwner ? <><BackupCard /><RestoreCard /></> : <div className="notice">النسخة الاحتياطية لصاحب المحل فقط</div>)}
          {tab === "staff" && <Staff call={call} isOwner={isOwner} />}
          {tab === "subscription" && <Subscription call={call} />}
          {tab === "devices" && <Devices call={call} storeId={store.id} storeName={store.name} go={go} isOwner={isOwner} />}
        </div>
      </main>
    </div>
  );
}
