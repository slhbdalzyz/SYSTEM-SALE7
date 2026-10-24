import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { session } from "../session";
import type { Screen } from "../App";
import { Products } from "./Products";
import { Report } from "./Report";
import { Staff } from "./Staff";
import { Devices } from "./Devices";

export interface Me {
  user: { id: string; name: string; role: string };
  tenant: { id: string; name: string; currency: string };
  stores: { id: string; name: string; address: string | null; receipt_footer: string | null }[];
}

export type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

const TABS = { report: "التقرير اليومي", products: "الأصناف والمخزون", staff: "الموظفين", devices: "الأجهزة" } as const;

export function Admin({ go }: { go: (s: Screen) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<keyof typeof TABS>("report");
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    call<Me>("/me").then(setMe).catch((e) => setError((e as Error).message));
  }, [call]);

  if (error) return <div className="center"><div className="error">{error}</div></div>;
  if (!me) return <div className="center muted">جاري التحميل…</div>;
  const store = me.stores[0];

  return (
    <div className="admin">
      <div className="row">
        <h1 style={{ margin: 0 }}>{me.tenant.name}</h1>
        <span className="muted">{store.name} · {me.user.name}</span>
        <span className="spacer" />
        {session.deviceToken && <button className="primary" onClick={() => go("pin")}>شاشة الكاشير</button>}
        <button onClick={logout}>خروج</button>
      </div>
      <div className="tabs">
        {(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => (
          <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{TABS[k]}</button>
        ))}
      </div>
      {tab === "report" && <Report call={call} storeId={store.id} />}
      {tab === "products" && <Products call={call} storeId={store.id} />}
      {tab === "staff" && <Staff call={call} isOwner={me.user.role === "owner"} />}
      {tab === "devices" && <Devices call={call} storeId={store.id} storeName={store.name} go={go} />}
    </div>
  );
}
