import { useEffect, useState } from "react";
import { api } from "../api";
import { getMeta, setMeta } from "../localdb";
import { session, type DeviceInfo } from "../session";
import type { Screen } from "../App";

interface StaffUser {
  id: string;
  name: string;
  role: string;
}

export function PinScreen({ go }: { go: (s: Screen) => void }) {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [device, setDevice] = useState<DeviceInfo | null>(session.device);
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const cached = await getMeta<StaffUser[]>("staff");
      if (cached) setUsers(cached);
      try {
        const r = await api<{ device: DeviceInfo; users: StaffUser[] }>("/auth/device-users", { body: { deviceToken: session.deviceToken } });
        setUsers(r.users);
        setDevice(r.device);
        session.device = r.device;
        await setMeta("staff", r.users);
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          // The owner disabled this device.
          session.deviceToken = null;
          session.device = null;
          go("setup");
        } else if (!cached) setError((e as Error).message);
      }
    })();
  }, [go]);

  async function login(p = pin) {
    if (!userId || p.length < 4) return;
    setError(null);
    try {
      const r = await api<{ token: string }>("/auth/pin", { body: { deviceToken: session.deviceToken, userId, pin: p } });
      session.staffToken = r.token;
      await setMeta("staffName", users.find((u) => u.id === userId)?.name ?? "");
      go("pos");
    } catch (e) {
      setPin("");
      setError((e as Error).message);
    }
  }

  function press(k: string) {
    if (k === "del") return setPin(pin.slice(0, -1));
    if (k === "ok") return void login();
    const next = (pin + k).slice(0, 8);
    setPin(next);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("del");
      else if (e.key === "Enter") press("ok");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="center">
      <div className="card stack" style={{ width: "min(460px, 100%)" }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{device?.name ?? "جهاز الكاشير"}</h2>
          <span className="spacer" />
          <span className="muted">{device?.storeName}</span>
        </div>
        <div className="users">
          {users.map((u) => (
            <button key={u.id} className={u.id === userId ? "active" : ""} onClick={() => { setUserId(u.id); setPin(""); }}>
              {u.name}
            </button>
          ))}
        </div>
        {userId && (
          <>
            <div className="num" style={{ textAlign: "center", fontSize: "2rem", letterSpacing: ".5em", minHeight: "2.6rem" }}>
              {"•".repeat(pin.length)}
            </div>
            <div className="pinpad" dir="ltr">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "ok"].map((k) => (
                <button key={k} className={k === "ok" ? "primary" : ""} onClick={() => press(k)}>
                  {k === "del" ? "⌫" : k === "ok" ? "دخول" : k}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button onClick={() => go(session.adminToken ? "admin" : "setup")}>الإدارة</button>
      </div>
    </div>
  );
}
