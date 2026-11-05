import { useEffect, useState } from "react";
import { PERMISSIONS, PERMISSION_KEYS, ROLE_NAMES, ROLE_PERMISSIONS, formatMoney, toMinor, type Permission } from "@pos/shared";
import type { Call } from "./Admin";
import { Modal } from "../pos/dialogs";

type RoleKey = keyof typeof ROLE_NAMES;
interface U {
  id: string; name: string; email: string | null; role: RoleKey; job_title: string | null; active: boolean; has_pin: boolean;
  permissions: Permission[] | null; effective: Permission[];
  salary_minor: number | null; day_minutes: number | null; hired_on: string | null;
}

const ROLE_HINT: Record<RoleKey, string> = {
  owner: "كل شي",
  manager: "يدير المحل كامل ما عدا الاشتراك والنسخ الاحتياطي",
  accountant: "التقارير والمصروفات والرواتب والموردين والديون",
  data_entry: "يدخل الأصناف وفواتير التوريد والعروض",
  cashier: "الكاشير بس، وصفحة راتبه",
};

/** Staff: who they are, how they sign in, what they may open, and their pay. */
export function Staff({ call, isOwner, mine }: { call: Call; isOwner: boolean; mine: Permission[] }) {
  const [users, setUsers] = useState<U[]>([]);
  const [edit, setEdit] = useState<U | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => call<U[]>("/users").then(setUsers).catch((e) => setError((e as Error).message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const canPay = mine.includes("payroll");
  const canStaff = mine.includes("staff");

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">كل موظف يدخل للكاشير برقمه السري، ولوحة الإدارة بالبريد وكلمة السر. وكل واحد يشوف صفحة «راتبي» حقته بس.</span>
        <span className="spacer" />
        {canStaff && <button className="primary" onClick={() => setEdit("new")}>+ موظف جديد</button>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="staff-grid">
        {users.map((u) => (
          <div key={u.id} className={`card staff-card ${u.active ? "" : "off"}`}>
            <div className="row">
              <div className="avatar">{u.name.trim().slice(0, 1)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b className="ellipsis">{u.name}</b>
                <div className="muted ellipsis">{u.job_title || ROLE_NAMES[u.role]}{u.email && ` · ${u.email}`}</div>
              </div>
              {u.active ? <span className="badge ok">فعال</span> : <span className="badge bad">موقوف</span>}
            </div>
            <div className="row wrap">
              <span className="badge">{ROLE_NAMES[u.role]}</span>
              {u.permissions && <span className="badge off">صلاحيات مخصصة</span>}
              {u.has_pin && <span className="badge">🔢 رقم سري</span>}
              {u.email && <span className="badge">✉️ دخول للإدارة</span>}
            </div>
            <small className="muted">{u.role === "owner" ? "كل الصلاحيات" : u.effective.length ? u.effective.map((p) => PERMISSIONS[p]).join("، ") : "الكاشير فقط"}</small>
            {canPay && u.salary_minor !== null && <div className="row"><span className="muted">الراتب</span><span className="spacer" /><b className="num">{u.salary_minor ? formatMoney(u.salary_minor) : "—"}</b></div>}
            {(canStaff || canPay) && (u.role !== "owner" || isOwner) && <button onClick={() => setEdit(u)}>تعديل</button>}
          </div>
        ))}
      </div>
      {edit && <Editor call={call} user={edit === "new" ? null : edit} isOwner={isOwner} mine={mine} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

function Editor({ call, user, isOwner, mine, onClose, onSaved }: { call: Call; user: U | null; isOwner: boolean; mine: Permission[]; onClose: () => void; onSaved: () => void }) {
  const canPay = mine.includes("payroll");
  const canStaff = mine.includes("staff");
  const [f, setF] = useState({
    name: user?.name ?? "",
    jobTitle: user?.job_title ?? "",
    role: (user?.role ?? "cashier") as RoleKey,
    pin: "",
    email: user?.email ?? "",
    password: "",
    custom: !!user?.permissions,
    perms: (user?.permissions ?? ROLE_PERMISSIONS[user?.role ?? "cashier"]) as Permission[],
    salary: user?.salary_minor ? String(user.salary_minor / 1000) : "",
    hours: String((user?.day_minutes ?? 480) / 60),
    hiredOn: user?.hired_on ?? "",
    active: user?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const perms = f.custom ? f.perms : [...ROLE_PERMISSIONS[f.role]];
  const roles = (Object.keys(ROLE_NAMES) as RoleKey[]).filter((r) => r !== "owner" || isOwner);

  async function save() {
    setError(null);
    const body: Record<string, unknown> = {};
    if (canStaff) {
      Object.assign(body, { name: f.name, role: f.role, jobTitle: f.jobTitle || null, permissions: f.role === "owner" || !f.custom ? null : f.perms });
      if (f.pin) body.pin = f.pin;
      if (f.email !== (user?.email ?? "")) body.email = f.email || null;
      if (f.password) body.password = f.password;
      if (user && f.active !== user.active) body.active = f.active;
    } else {
      body.jobTitle = f.jobTitle || null;
    }
    if (canPay) {
      body.salaryMinor = toMinor(Number(f.salary.replace(",", ".")) || 0);
      body.dayMinutes = Math.round((Number(f.hours) || 8) * 60);
      body.hiredOn = f.hiredOn || null;
    }
    try {
      if (user) await call(`/users/${user.id}`, { method: "PATCH", body });
      else await call("/users", { body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal title={user ? `تعديل ${user.name}` : "موظف جديد"} onClose={onClose}>
      <div className="stack staff-editor">
        {canStaff && (
          <>
            <div className="row">
              <label style={{ flex: 2 }}>الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
              <label style={{ flex: 1 }}>المسمى الوظيفي<input value={f.jobTitle} placeholder="مثلا: قصاب، محاسب" onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></label>
            </div>
            <b>الدور</b>
            <div className="role-pick">
              {roles.map((r) => (
                <button key={r} className={f.role === r ? "active" : ""} onClick={() => setF({ ...f, role: r, perms: [...ROLE_PERMISSIONS[r]] })}>
                  <b>{ROLE_NAMES[r]}</b><small>{ROLE_HINT[r]}</small>
                </button>
              ))}
            </div>
            {f.role !== "owner" && (
              <>
                <label className="check"><input type="checkbox" checked={f.custom} onChange={(e) => setF({ ...f, custom: e.target.checked, perms: perms })} /> صلاحيات مخصصة لهذا الشخص</label>
                <div className="perm-grid">
                  {PERMISSION_KEYS.map((p) => {
                    const allowed = isOwner || mine.includes(p);
                    return (
                      <label key={p} className={`check ${!f.custom || !allowed ? "dim" : ""}`}>
                        <input type="checkbox" disabled={!f.custom || !allowed} checked={perms.includes(p)}
                          onChange={(e) => setF({ ...f, perms: e.target.checked ? [...f.perms, p] : f.perms.filter((x) => x !== p) })} />
                        {PERMISSIONS[p]}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            <b>الدخول</b>
            <div className="row">
              <label style={{ flex: 1 }}>الرقم السري للكاشير{user?.has_pin && <span className="muted"> (اتركه فاضي ما يتغيرش)</span>}
                <input className="num" inputMode="numeric" value={f.pin} placeholder="4 إلى 8 أرقام" onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
              </label>
              <label style={{ flex: 1 }}>البريد (للدخول للإدارة)<input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
              <label style={{ flex: 1 }}>كلمة السر{user?.email && <span className="muted"> (اتركها فاضية)</span>}<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
            </div>
          </>
        )}
        {canPay && (
          <>
            <b>الراتب</b>
            <div className="row">
              <label style={{ flex: 1 }}>الراتب الشهري (د.ل)<input className="num" inputMode="decimal" value={f.salary} onChange={(e) => setF({ ...f, salary: e.target.value })} /></label>
              <label style={{ flex: 1 }}>ساعات العمل في اليوم<input className="num" inputMode="decimal" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
              <label style={{ flex: 1 }}>تاريخ التعيين<input type="date" value={f.hiredOn} onChange={(e) => setF({ ...f, hiredOn: e.target.value })} /></label>
            </div>
            <small className="muted">التأخير والغياب يتحسبوا من الراتب: اليوم = الراتب ÷ 30، والدقيقة = اليوم ÷ دقائق العمل.</small>
          </>
        )}
        {user && canStaff && user.role !== "owner" && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> الحساب فعال</label>}
        {error && <div className="error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>إلغاء</button>
          <button className="primary" disabled={canStaff && (f.name.length < 2 || (!user && f.pin.length < 4 && !(f.email && f.password.length >= 8)))} onClick={() => void save()}>حفظ</button>
        </div>
      </div>
    </Modal>
  );
}
