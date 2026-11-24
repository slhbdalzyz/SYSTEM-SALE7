import { useEffect, useState } from "react";
import {
  DEFAULT_KEYS, FUNCTION_KEYS, LAYOUT_SPECS, TILL_ACTIONS, TILL_ACTION_LABELS, TILL_BUTTONS, TILL_BUTTON_LABELS, TILL_LAYOUTS,
  keyMap, layoutForBusiness, readShopSettings, tillButtons, type TillAction, type TillButton, type TillLayout, type TillLayoutSettings,
} from "@pos/shared";
import type { Call } from "./Admin";

interface Device { id: string; name: string; kind?: string; store_name?: string }
interface User { id: string; name: string; role: string; active?: boolean }

/**
 * «🖥 واجهة الكاشير»: the owner picks the cashier screen's layout for the shop, a till or a
 * cashier; which buttons show and in what order; the keyboard; the big total; the cash notes.
 */
export function TillLayoutCard({ call, businessType }: { call: Call; businessType?: string | null }) {
  const [s, setS] = useState<TillLayoutSettings | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<TillLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    call<{ settings: unknown }>("/settings").then((r) => {
      const t = readShopSettings(r.settings).tillLayout;
      setS(t);
      setNotes(t.cashNotes.join("، "));
    }).catch((e) => setError((e as Error).message));
    call<Device[]>("/devices").then((d) => setDevices(d.filter((x) => !x.kind || x.kind === "pos"))).catch(() => setDevices([]));
    call<User[]>("/users").then((u) => setUsers(u.filter((x) => x.active !== false))).catch(() => setUsers([]));
  }, [call]);

  async function save(next: TillLayoutSettings) {
    setError(null);
    setSaved(false);
    setS(next);
    try {
      const r = await call<{ tillLayout: TillLayoutSettings }>("/settings/till-layout", { method: "PATCH", body: next });
      setS(r.tillLayout);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s) return error ? <div className="error">{error}</div> : null;
  const shopLayout: TillLayout = s.shop === "auto" ? layoutForBusiness(businessType) : s.shop;
  const shown = preview ?? shopLayout;
  const order = tillButtons({ ...s, buttons: Object.fromEntries(TILL_BUTTONS.map((b) => [b, true])) }, shown);
  const visible = new Set(tillButtons(s, shown));
  const keys = keyMap(s);
  const keyFor = (a: TillAction) => Object.keys(keys).find((k) => keys[k] === a) ?? DEFAULT_KEYS[a];

  const move = (b: TillButton, d: -1 | 1) => {
    const list = [...order];
    const i = list.indexOf(b);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    void save({ ...s, order: list });
  };
  const pickFor = (kind: "devices" | "users", id: string, v: string) => {
    const map = { ...s[kind] };
    if (v) map[id] = v as TillLayout;
    else delete map[id];
    void save({ ...s, [kind]: map });
  };

  return (
    <section className="card stack">
      <b>🖥 واجهة الكاشير</b>
      <small className="muted">اختار شكل شاشة البيع اللي يناسب نشاطك. تقدر تعطي كل جهاز أو كل كاشير واجهة غير، والكاشير يبدّل حجم الخط والوضع الليلي بس. التغيير يوصل للأجهزة في المزامنة الجاية.</small>

      <div className="layout-picks">
        <label className={`layout-pick ${s.shop === "auto" ? "active" : ""}`}>
          <input type="radio" name="till-layout" checked={s.shop === "auto"} onChange={() => void save({ ...s, shop: "auto" })} />
          <span><b>✨ حسب نشاط المحل</b><br /><small className="muted">توا: {LAYOUT_SPECS[layoutForBusiness(businessType)].icon} {LAYOUT_SPECS[layoutForBusiness(businessType)].label}</small></span>
        </label>
        {TILL_LAYOUTS.map((id) => (
          <label key={id} className={`layout-pick ${s.shop === id ? "active" : ""}`} onMouseEnter={() => setPreview(id)} onMouseLeave={() => setPreview(null)}>
            <input type="radio" name="till-layout" checked={s.shop === id} onChange={() => void save({ ...s, shop: id })} />
            <span><b>{LAYOUT_SPECS[id].icon} {LAYOUT_SPECS[id].label}</b><br /><small className="muted">{LAYOUT_SPECS[id].text}</small></span>
          </label>
        ))}
      </div>

      {(devices.length > 0 || users.length > 0) && (
        <details>
          <summary>واجهة خاصة لجهاز أو لكاشير</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {devices.map((d) => (
              <label key={d.id} className="row" style={{ gap: 8 }}>🖥 {d.name}{d.store_name ? <small className="muted"> · {d.store_name}</small> : null}
                <select value={s.devices[d.id] ?? ""} onChange={(e) => pickFor("devices", d.id, e.target.value)} style={{ width: "auto" }}>
                  <option value="">زي المحل</option>
                  {TILL_LAYOUTS.map((id) => <option key={id} value={id}>{LAYOUT_SPECS[id].icon} {LAYOUT_SPECS[id].label}</option>)}
                </select>
              </label>
            ))}
            {users.filter((u) => u.role !== "owner").map((u) => (
              <label key={u.id} className="row" style={{ gap: 8 }}>👤 {u.name}
                <select value={s.users[u.id] ?? ""} onChange={(e) => pickFor("users", u.id, e.target.value)} style={{ width: "auto" }}>
                  <option value="">زي الجهاز</option>
                  {TILL_LAYOUTS.map((id) => <option key={id} value={id}>{LAYOUT_SPECS[id].icon} {LAYOUT_SPECS[id].label}</option>)}
                </select>
              </label>
            ))}
            <small className="muted">الترتيب: واجهة الكاشير، وبعدها واجهة الجهاز، وبعدها واجهة المحل.</small>
          </div>
        </details>
      )}

      <details>
        <summary>الأزرار اللي تبان وترتيبها ({LAYOUT_SPECS[shown].label})</summary>
        <div className="stack" style={{ gap: 4, marginTop: 8 }}>
          {order.map((b, i) => (
            <div key={b} className="row" style={{ gap: 6 }}>
              <label className="check" style={{ flex: 1 }}>
                <input type="checkbox" checked={visible.has(b)} onChange={(e) => void save({ ...s, buttons: { ...s.buttons, [b]: e.target.checked } })} /> {TILL_BUTTON_LABELS[b]}
              </label>
              <button className="ghost small" disabled={i === 0} onClick={() => move(b, -1)} aria-label="فوق">▲</button>
              <button className="ghost small" disabled={i === order.length - 1} onClick={() => move(b, 1)} aria-label="تحت">▼</button>
            </div>
          ))}
          <button className="ghost" onClick={() => void save({ ...s, buttons: {}, order: [] })}>رجّع زي ما كانت الواجهة</button>
          <small className="muted">بعض الأزرار تبان بس لو الميزة شغالة في محلك (البدائل، عرض السعر، التوصيل، القوائم الجاهزة).</small>
        </div>
      </details>

      <details>
        <summary>مفاتيح الكيبورد (F1–F12)</summary>
        <div className="stack" style={{ gap: 4, marginTop: 8 }}>
          {TILL_ACTIONS.map((a) => (
            <label key={a} className="row" style={{ gap: 8 }}>
              <span style={{ flex: 1 }}>{TILL_ACTION_LABELS[a]}</span>
              <select value={keyFor(a)} style={{ width: 90 }} onChange={(e) => void save({ ...s, keys: { ...s.keys, [a]: e.target.value as (typeof FUNCTION_KEYS)[number] } })}>
                {FUNCTION_KEYS.map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
          ))}
          <small className="muted">لو اخترت مفتاح عند حاجة ثانية، يتبادلوا.</small>
          <button className="ghost" onClick={() => void save({ ...s, keys: {} })}>رجّع المفاتيح الأصلية</button>
        </div>
      </details>

      <label className="check">
        <input type="checkbox" checked={s.bigTotal ?? LAYOUT_SPECS[shopLayout].bigTotal} onChange={(e) => void save({ ...s, bigTotal: e.target.checked })} />
        المجموع كبير فوق، مع عدد القطع والباقي للزبون
      </label>
      <label>أوراق الكاش السريع (د.ل)
        <input value={notes} onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            const list = [...new Set(notes.split(/[،,\s]+/).map(Number).filter((x) => x > 0 && x <= 1000))].slice(0, 6).sort((a, b) => b - a);
            const cashNotes = list.length ? list : [50, 20, 10, 5];
            setNotes(cashNotes.join("، "));
            void save({ ...s, cashNotes });
          }} />
        <small className="muted">تبان في واجهات البيع السريع والمطعم واللمس، تحت المجموع.</small>
      </label>
      {saved && <span className="badge ok">تم الحفظ ✓</span>}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
