import { useEffect, useState } from "react";
import type { Call } from "./Admin";

interface U { id: string; name: string; email: string | null; role: string; active: boolean; has_pin: boolean }
const ROLE: Record<string, string> = { owner: "مالك", manager: "مدير", cashier: "كاشير" };

export function Staff({ call, isOwner }: { call: Call; isOwner: boolean }) {
  const [users, setUsers] = useState<U[]>([]);
  const [f, setF] = useState({ name: "", role: "cashier", pin: "" });
  const [error, setError] = useState<string | null>(null);
  const load = () => call<U[]>("/users").then(setUsers);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    setError(null);
    try {
      await call("/users", { body: f });
      setF({ name: "", role: "cashier", pin: "" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setPin(u: U) {
    const pin = prompt(`رقم سري جديد لـ ${u.name} (4 إلى 8 أرقام)`);
    if (!pin) return;
    try {
      await call(`/users/${u.id}`, { method: "PATCH", body: { pin } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="card row" style={{ alignItems: "end" }}>
        <label style={{ flex: 2 }}>الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label style={{ flex: 1 }}>الدور
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="cashier">كاشير</option>
            <option value="manager">مدير</option>
            {isOwner && <option value="owner">مالك</option>}
          </select>
        </label>
        <label style={{ flex: 1 }}>الرقم السري<input className="num" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} /></label>
        <button className="primary" onClick={add} disabled={!f.name || f.pin.length < 4}>إضافة</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead><tr><th>الاسم</th><th>الدور</th><th>رقم سري</th><th>الحالة</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="muted">{u.email}</div></td>
                <td>{ROLE[u.role]}</td>
                <td>{u.has_pin ? "✓" : "—"}</td>
                <td>{u.active ? <span className="badge ok">فعال</span> : <span className="badge bad">موقوف</span>}</td>
                <td className="row">
                  <button onClick={() => setPin(u)}>تغيير الرقم السري</button>
                  {u.role !== "owner" && (
                    <button className={u.active ? "danger" : ""} onClick={async () => { await call(`/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }); await load(); }}>
                      {u.active ? "إيقاف" : "تفعيل"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
