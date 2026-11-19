import { useCallback, useEffect, useState } from "react";
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
  // True once the server answered: an empty list then means nobody has a PIN yet, not "still loading".
  const [loaded, setLoaded] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [saving, setSaving] = useState(false);

  const loadUsers = useCallback(async () => {
    const cached = await getMeta<StaffUser[]>("staff");
    if (cached) setUsers(cached);
    try {
      const r = await api<{ device: DeviceInfo; users: StaffUser[] }>("/auth/device-users", { body: { deviceToken: session.deviceToken } });
      setUsers(r.users);
      setDevice(r.device);
      session.device = r.device;
      setLoaded(true);
      await setMeta("staff", r.users);
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        // The owner disabled this device.
        session.deviceToken = null;
        session.device = null;
        go("setup");
      } else if (!cached) setError((e as Error).message);
    }
  }, [go]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  /** A new shop's owner signs up with a password only, so the till has nobody to list: let them set their own PIN here. */
  async function saveOwnPin() {
    if (!/^\d{4,8}$/.test(newPin)) return setError("الرقم السري من 4 لين 8 أرقام");
    setSaving(true);
    setError(null);
    try {
      const me = await api<{ user: { id: string } }>("/me", { token: session.adminToken });
      await api(`/users/${me.user.id}`, { method: "PATCH", body: { pin: newPin }, token: session.adminToken });
      setNewPin("");
      await loadUsers();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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
        {users.length === 0 && !loaded && !error && <div className="muted">جاري التحميل… (أول مرة تاخذ ثواني)</div>}
        {users.length === 0 && loaded && (
          <div className="stack">
            <div className="notice">ما فيش حد عنده رقم سري للكاشير لسه.</div>
            {session.adminToken ? (
              <>
                <div className="muted">حط رقم سري لحسابك وادخل بيه توا، وبعدين تقدر تضيف الكاشيرات من «الموظفين» في الإدارة.</div>
                <div className="row">
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    placeholder="رقم سري (4 لين 8 أرقام)"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") void saveOwnPin();
                    }}
                    style={{ flex: 1 }}
                  />
                  <button className="primary" disabled={saving || newPin.length < 4} onClick={() => void saveOwnPin()}>حفظ</button>
                </div>
              </>
            ) : (
              <div className="muted">ادخل للإدارة وضيف رقم سري لحسابك أو للكاشير من «الموظفين».</div>
            )}
          </div>
        )}
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
