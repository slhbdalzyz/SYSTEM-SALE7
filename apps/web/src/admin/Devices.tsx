import { useEffect, useState } from "react";
import { session } from "../session";
import { db } from "../localdb";
import type { Screen } from "../App";
import type { Call } from "./Admin";

interface D { id: string; name: string; prefix: string; kind: "pos" | "price_checker"; active: boolean; backup: boolean; last_seen_at: string | null }

export function Devices({ call, storeId, storeName, go, isOwner }: { call: Call; storeId: string; storeName: string; go: (s: Screen) => void; isOwner: boolean }) {
  const [devices, setDevices] = useState<D[]>([]);
  const [name, setName] = useState("كاشير 1");
  const [error, setError] = useState<string | null>(null);
  const load = () => call<D[]>("/devices").then(setDevices).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const thisId = session.device?.id;

  async function registerThis(kind: "pos" | "price_checker") {
    setError(null);
    try {
      const r = await call<{ id: string; prefix: string; deviceToken: string }>("/devices", { body: { storeId, name, kind } });
      // A different shop may have used this browser before; start from a clean local copy.
      await db.delete();
      await db.open();
      session.deviceToken = r.deviceToken;
      session.device = { id: r.id, name, prefix: r.prefix, storeName };
      session.staffToken = null;
      session.deviceKind = kind;
      go(kind === "pos" ? "pin" : "price");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      {!session.deviceToken && (
        <div className="card row" style={{ alignItems: "end" }}>
          <label style={{ flex: 1 }}>اسم هذا الجهاز<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary" onClick={() => registerThis("pos")} disabled={!name}>اعتماد هذا الجهاز ككاشير</button>
          <button onClick={() => registerThis("price_checker")} disabled={!name}>اعتماده كقارئ أسعار</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="muted small">«نسخة يومية»: جهاز الكاشير في تطبيق ويندوز يحفظ نسخة من كل بيانات المحل في «المستندات\POS-Backups» مرة في اليوم، ويخلّي آخر 30 نسخة. فعّلها بس على جهاز في مكان آمن.</div>
      <div className="card">
        <table>
          <thead><tr><th>الجهاز</th><th>الرمز</th><th>آخر ظهور</th><th>الحالة</th><th title="تطبيق ويندوز يحفظ نسخة من كل بيانات المحل على الجهاز كل يوم">نسخة يومية</th><th /></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}{d.kind === "price_checker" && <span className="badge off" style={{ marginInlineStart: 8 }}>قارئ أسعار</span>}{d.id === thisId && <span className="badge ok" style={{ marginInlineStart: 8 }}>هذا الجهاز</span>}</td>
                <td className="num">{d.prefix}</td>
                <td className="num">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("en-GB") : "—"}</td>
                <td>{d.active ? <span className="badge ok">فعال</span> : <span className="badge bad">موقوف</span>}</td>
                <td>
                  {d.kind === "pos" && (
                    <label className="check">
                      <input type="checkbox" checked={d.backup} disabled={!isOwner}
                        onChange={async (e) => { await call(`/devices/${d.id}/backup`, { method: "PATCH", body: { backup: e.target.checked } }).catch((err) => setError((err as Error).message)); await load(); }} />
                      {d.backup ? "مفعّلة" : "لا"}
                    </label>
                  )}
                </td>
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
