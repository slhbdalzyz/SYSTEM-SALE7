import { useCallback, useEffect, useState } from "react";
import { sendText } from "../whatsapp";
import type { Call } from "./Admin";

interface Req { id: string; name: string; created_at: string; user_name: string; store_name: string }
interface Access { shopCode: string; autoApprove: boolean; requests: Req[] }

/** New devices waiting for the owner: approve or refuse, from the till's admin or the phone. */
function Requests({ call, list, reload }: { call: Call; list: Req[]; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const answer = async (id: string, a: "approve" | "reject") => {
    setError(null);
    try {
      await call(`/devices/requests/${id}/${a}`, { method: "POST", body: {} });
    } catch (e) {
      setError((e as Error).message);
    }
    reload();
  };
  if (!list.length) return null;
  return (
    <div className="card stack" style={{ borderColor: "var(--warn, #d97706)" }}>
      <b>🖥️ أجهزة جديدة تستنى موافقتك</b>
      {list.map((r) => (
        <div key={r.id} className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}><b>{r.user_name}</b> يبي يدخل من «{r.name}» في {r.store_name}<br /><small className="muted num">{new Date(r.created_at).toLocaleString("en-GB")}</small></span>
          <button className="primary" onClick={() => void answer(r.id, "approve")}>موافق</button>
          <button className="danger" onClick={() => void answer(r.id, "reject")}>رفض</button>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function useAccess(call: Call, every = 0) {
  const [a, setA] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void call<Access>("/devices/access").then(setA).catch((e) => setError((e as Error).message)), [call]);
  useEffect(() => {
    load();
    if (!every) return;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every]);
  return { a, error, load };
}

/** On the owner's phone home: only shows up when a device is waiting. */
export function PendingDevices({ call }: { call: Call }) {
  const { a, load } = useAccess(call, 15000);
  return a ? <Requests call={call} list={a.requests} reload={load} /> : null;
}

/** The shop code, the WhatsApp link, and whether new devices need the owner's yes. */
export function DeviceAccess({ call, stores }: { call: Call; stores: { id: string; name: string }[] }) {
  const { a, error: loadError, load } = useAccess(call, 15000);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState({ storeId: stores[0]?.id ?? "", name: "كاشير", kind: "pos" });
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!a) return loadError ? <div className="error">{loadError}</div> : null;

  const run = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  };
  const makeLink = () => run(async () => {
    const r = await call<{ code: string; expiresAt: string }>("/devices/links", { body: link });
    setCopied(false);
    setMade({ url: `${location.origin}${location.pathname}?pair=${r.code}`, expiresAt: r.expiresAt });
  });
  const message = (url: string) => `رابط اعتماد جهاز «${link.name}» للمحل. افتحه على جهاز المحل خلال 15 دقيقة واضغط «اعتماد»:\n${url}`;

  return (
    <div className="stack">
      <Requests call={call} list={a.requests} reload={load} />
      <div className="card stack">
        <b>🔑 دخول الكاشير وأنت مش موجود</b>
        <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span>كود المحل</span>
          <b className="num" style={{ fontSize: "1.6rem", letterSpacing: 6 }}>{a.shopCode}</b>
          <span className="spacer" />
          <button onClick={() => void run(() => call("/devices/shop-code", { body: {} }))} title="الكود القديم يبطل">كود جديد</button>
        </div>
        <small className="muted">
          على جهاز جديد، الكاشير يضغط «🧑‍💼 دخول الكاشير» ويكتب هذا الكود ورقمه السري. يوصلك إشعار وتوافق من تلفونك.
          الرقم السري الغلط 5 مرات يقفل ربع ساعة.
        </small>
        <label className="check">
          <input type="checkbox" checked={a.autoApprove} onChange={(e) => void run(() => call("/devices/access", { method: "PATCH", body: { autoApprove: e.target.checked } }))} />
          اعتمد أجهزة الكاشير بالكود والرقم السري من غير موافقتي (يوصلني إشعار بس)
        </label>
      </div>
      <div className="card stack">
        <b>🔗 رابط اعتماد على الواتساب</b>
        <small className="muted">رابط ينفع مرة وحدة ويخلص بعد 15 دقيقة. ابعته للموظف، يفتحه على جهاز المحل، ويتعتمد الجهاز طول.</small>
        <div className="row" style={{ alignItems: "end", flexWrap: "wrap" }}>
          {stores.length > 1 && (
            <label>الفرع
              <select value={link.storeId} onChange={(e) => setLink({ ...link, storeId: e.target.value })}>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          )}
          <label style={{ flex: 1 }}>اسم الجهاز<input value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} maxLength={60} /></label>
          <label>نوعه
            <select value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value })}>
              <option value="pos">كاشير</option>
              <option value="price_checker">قارئ أسعار</option>
              <option value="kitchen">شاشة مطبخ</option>
            </select>
          </label>
          <button className="primary" disabled={!link.name.trim() || !link.storeId} onClick={() => void makeLink()}>اعمل رابط</button>
        </div>
        {made && (
          <div className="stack">
            <input readOnly value={made.url} onFocus={(e) => e.target.select()} dir="ltr" />
            <div className="row">
              <button className="primary" onClick={() => sendText(null, message(made.url))}>📲 ابعته بالواتساب</button>
              <button onClick={() => void navigator.clipboard?.writeText(made.url).then(() => setCopied(true)).catch(() => undefined)}>{copied ? "✓ اتنسخ" : "نسخ"}</button>
              <small className="muted num">يخلص {new Date(made.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</small>
            </div>
          </div>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
