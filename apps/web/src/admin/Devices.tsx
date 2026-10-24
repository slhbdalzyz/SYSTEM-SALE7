import { useEffect, useState } from "react";
import { session } from "../session";
import { db } from "../localdb";
import type { Screen } from "../App";
import type { Call } from "./Admin";

interface D { id: string; name: string; prefix: string; active: boolean; last_seen_at: string | null }

export function Devices({ call, storeId, storeName, go }: { call: Call; storeId: string; storeName: string; go: (s: Screen) => void }) {
  const [devices, setDevices] = useState<D[]>([]);
  const [name, setName] = useState("كاشير 1");
  const [error, setError] = useState<string | null>(null);
  const load = () => call<D[]>("/devices").then(setDevices).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const thisId = session.device?.id;

  async function registerThis() {
    setError(null);
    try {
      const r = await call<{ id: string; prefix: string; deviceToken: string }>("/devices", { body: { storeId, name } });
      // A different shop may have used this browser before; start from a clean local copy.
      await db.delete();
      await db.open();
      session.deviceToken = r.deviceToken;
      session.device = { id: r.id, name, prefix: r.prefix, storeName };
      session.staffToken = null;
      go("pin");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      {!session.deviceToken && (
        <div className="card row" style={{ alignItems: "end" }}>
          <label style={{ flex: 1 }}>اسم هذا الجهاز<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary" onClick={registerThis} disabled={!name}>اعتماد هذا الجهاز ككاشير</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead><tr><th>الجهاز</th><th>الرمز</th><th>آخر ظهور</th><th>الحالة</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}{d.id === thisId && <span className="badge ok" style={{ marginInlineStart: 8 }}>هذا الجهاز</span>}</td>
                <td className="num">{d.prefix}</td>
                <td className="num">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("en-GB") : "—"}</td>
                <td>{d.active ? <span className="badge ok">فعال</span> : <span className="badge bad">موقوف</span>}</td>
                <td>
                  <button className={d.active ? "danger" : ""} onClick={async () => { await call(`/devices/${d.id}`, { method: "PATCH", body: { active: !d.active } }); await load(); }}>
                    {d.active ? "إيقاف (ضايع/مسروق)" : "تفعيل"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
