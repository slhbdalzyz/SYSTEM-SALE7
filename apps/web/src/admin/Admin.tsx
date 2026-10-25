import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { session } from "../session";
import type { Screen } from "../App";
import { Products } from "./Products";
import { Report } from "./Report";
import { Staff } from "./Staff";
import { Devices } from "./Devices";
import { Customers } from "./Customers";
import { Purchasing } from "./Purchasing";
import { Branches } from "./Branches";
import { Subscription, subNotice, type Sub } from "./Subscription";

export interface Me {
  user: { id: string; name: string; role: string };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; address: string | null; receipt_footer: string | null; active: boolean }[];
}

export type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

const TABS = { report: "التقرير اليومي", products: "الأصناف والمخزون", purchasing: "المشتريات والموردين", branches: "الفروع والتحويلات", customers: "العملاء والديون", staff: "الموظفين", devices: "الأجهزة", subscription: "الاشتراك" } as const;

export function Admin({ go }: { go: (s: Screen) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<keyof typeof TABS>("report");
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
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
        if (["locked", "suspended", "cancelled"].includes(s.state)) setTab("subscription");
      })
      .catch(() => setSub(null));
  }, [call, loadMe]);
  const notice = sub && subNotice(sub);

  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!me) return <div className="center muted">جاري التحميل…</div>;
  const open = me.stores.filter((s) => s.active);
  const store = open.find((s) => s.id === storeId) ?? open[0] ?? me.stores[0];

  return (
    <div className="admin">
      <div className="row">
        <h1 style={{ margin: 0 }}>{me.tenant.name}</h1>
        {open.length > 1 ? (
          <select value={store.id} onChange={(e) => pickStore(e.target.value)} style={{ width: "auto" }} aria-label="الفرع">
            {open.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <span className="muted">{store.name}</span>
        )}
        <span className="muted">{me.user.name}</span>
        <span className="spacer" />
        {session.deviceToken && <button className="primary" onClick={() => go("pin")}>شاشة الكاشير</button>}
        <button onClick={logout}>خروج</button>
      </div>
      {notice && tab !== "subscription" && (
        <div className={notice.bad ? "error" : "notice"} onClick={() => setTab("subscription")} style={{ cursor: "pointer" }}>
          {notice.text} <u>التفاصيل</u>
        </div>
      )}
      <div className="tabs">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{TABS[k]}</button>
        ))}
      </div>
      <div className="stack" key={store.id}>
      {tab === "report" && <Report call={call} storeId={store.id} />}
      {tab === "products" && <Products call={call} storeId={store.id} />}
      {tab === "purchasing" && <Purchasing call={call} storeId={store.id} />}
      {tab === "branches" && <Branches call={call} storeId={store.id} isOwner={me.user.role === "owner"} onStoresChanged={loadMe} />}
      {tab === "customers" && <Customers call={call} />}
      {tab === "staff" && <Staff call={call} isOwner={me.user.role === "owner"} />}
      {tab === "subscription" && <Subscription call={call} />}
      {tab === "devices" && <Devices call={call} storeId={store.id} storeName={store.name} go={go} />}
      </div>
    </div>
  );
}
