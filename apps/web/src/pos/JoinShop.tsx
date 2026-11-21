import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { db } from "../localdb";
import { session } from "../session";
import type { Screen } from "../App";

type Kind = "pos" | "price_checker" | "kitchen";
interface Device { id: string; name: string; prefix: string; kind: Kind; storeName: string }
interface Shop { shop: { name: string }; stores: { id: string; name: string }[]; users: { id: string; name: string }[] }

const PENDING_KEY = "pos.joinRequest";

function readPending(): { requestId: string; deviceToken: string; shopName: string } | null {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  } catch {
    return null;
  }
}
export const hasPendingJoin = () => readPending() !== null;

function writePending(v: { requestId: string; deviceToken: string; shopName: string } | null) {
  try {
    if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* private window: the wait just does not survive a reload */
  }
}

/** This browser is now one of the shop's devices: start from a clean local copy and open its screen. */
async function becomeDevice(deviceToken: string, d: Device, go: (s: Screen) => void) {
  await db.delete();
  await db.open();
  session.deviceToken = deviceToken;
  session.device = { id: d.id, name: d.name, prefix: d.prefix, storeName: d.storeName };
  session.staffToken = null;
  session.deviceKind = d.kind;
  writePending(null);
  history.replaceState(null, "", location.pathname);
  go(d.kind === "kitchen" ? "kitchen" : d.kind === "price_checker" ? "price" : "pin");
}

/**
 * A cashier on a device the owner has not approved: the shop code and their own PIN ask for it,
 * then the owner says yes from the phone (or the shop lets such devices in by itself).
 */
export function JoinShop({ go, onBack }: { go: (s: Screen) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [shop, setShop] = useState<Shop | null>(null);
  const [f, setF] = useState({ storeId: "", userId: "", pin: "", name: "كاشير" });
  const [pending, setPending] = useState(readPending);
  const [status, setStatus] = useState<"pending" | "rejected" | "gone">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<Shop>("/auth/shop-lookup", { body: { shopCode: code } });
      if (!s.users.length) throw new Error("ما فيش حد عنده رقم سري في هذا المحل. صاحب المحل يضيفه من «الموظفين والصلاحيات»");
      setShop(s);
      setF((x) => ({ ...x, storeId: s.stores[0]?.id ?? "", userId: s.users.length === 1 ? s.users[0].id : "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: "approved" | "pending"; deviceToken: string; requestId?: string; device?: Device }>("/auth/device-request", { body: { shopCode: code, ...f } });
      if (r.status === "approved" && r.device) return await becomeDevice(r.deviceToken, r.device, go);
      const p = { requestId: r.requestId!, deviceToken: r.deviceToken, shopName: shop!.shop.name };
      writePending(p);
      setStatus("pending");
      setPending(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Waiting for the owner: ask every few seconds, and stop once there is an answer.
  const stop = useRef(false);
  useEffect(() => {
    if (!pending) return;
    stop.current = false;
    const tick = async () => {
      try {
        const r = await api<{ status: "pending" | "approved" | "rejected" | "gone"; device?: Device }>("/auth/device-request/status", { body: { requestId: pending.requestId, deviceToken: pending.deviceToken } });
        if (r.status === "approved" && r.device) {
          stop.current = true;
          await becomeDevice(pending.deviceToken, r.device, go);
        } else if (r.status !== "pending") {
          stop.current = true;
          writePending(null);
          setStatus(r.status === "approved" ? "gone" : r.status);
        }
      } catch {
        /* no internet for a moment: try again on the next tick */
      }
    };
    void tick();
    const t = setInterval(() => !stop.current && void tick(), 4000);
    return () => clearInterval(t);
  }, [pending, go]);

  if (pending || status !== "pending") {
    return (
      <div className="center">
        <div className="card stack" style={{ width: "min(440px, 100%)", textAlign: "center" }}>
          {status === "pending" ? (
            <>
              <div style={{ fontSize: "2.5rem" }}>⏳</div>
              <h2 style={{ margin: 0 }}>ننتظروا موافقة صاحب المحل</h2>
              <p className="muted" style={{ margin: 0 }}>وصله إشعار على تلفونه. أول ما يضغط «موافق» تفتح شاشة البيع هني وحدها.</p>
              <small className="muted">{pending?.shopName}</small>
            </>
          ) : (
            <>
              <div style={{ fontSize: "2.5rem" }}>✋</div>
              <h2 style={{ margin: 0 }}>{status === "rejected" ? "صاحب المحل رفض هذا الجهاز" : "الطلب انتهى"}</h2>
              <p className="muted" style={{ margin: 0 }}>كلّمه، أو اطلب منه رابط اعتماد على الواتساب.</p>
            </>
          )}
          <button onClick={() => { stop.current = true; writePending(null); setPending(null); setStatus("pending"); setShop(null); }}>
            {status === "pending" ? "إلغاء الطلب" : "رجوع"}
          </button>
        </div>
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="center">
        <form className="card stack" style={{ width: "min(420px, 100%)" }} onSubmit={lookup}>
          <button type="button" className="ghost back" onClick={onBack}>→ رجوع</button>
          <h1 style={{ margin: 0 }}>🧑‍💼 دخول الكاشير</h1>
          <p className="muted" style={{ margin: 0 }}>جهاز جديد وصاحب المحل مش موجود؟ اكتب كود المحل وبعدين رقمك السري.</p>
          <label>كود المحل
            <input className="num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus required placeholder="6 أرقام" style={{ letterSpacing: 6, fontSize: "1.3rem", textAlign: "center" }} />
          </label>
          <small className="muted">صاحب المحل يلقاه في «🖥️ الأجهزة».</small>
          {error && <div className="error">{error}</div>}
          <button className="primary big" disabled={busy || code.length !== 6}>التالي</button>
        </form>
      </div>
    );
  }

  return (
    <div className="center">
      <form className="card stack" style={{ width: "min(420px, 100%)" }} onSubmit={ask}>
        <button type="button" className="ghost back" onClick={() => setShop(null)}>→ رجوع</button>
        <h1 style={{ margin: 0 }}>{shop.shop.name}</h1>
        {shop.stores.length > 1 && (
          <label>الفرع
            <select value={f.storeId} onChange={(e) => setF({ ...f, storeId: e.target.value })}>
              {shop.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label>اسمك
          <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} required>
            <option value="">اختار اسمك</option>
            {shop.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label>رقمك السري
          <input type="password" className="num" inputMode="numeric" maxLength={8} value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} required style={{ letterSpacing: 6, fontSize: "1.3rem", textAlign: "center" }} />
        </label>
        <label>اسم هذا الجهاز<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy || !f.userId || f.pin.length < 4 || !f.name.trim()}>اطلب الدخول</button>
      </form>
    </div>
  );
}

/** Opened from the owner's WhatsApp link (?pair=…): this device is approved at once. */
export function PairDevice({ code, go, onBack }: { code: string; go: (s: Screen) => void; onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function pair() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ deviceToken: string; device: Device }>("/auth/pair", { body: { code } });
      await becomeDevice(r.deviceToken, r.device, go);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="center">
      <div className="card stack" style={{ width: "min(420px, 100%)", textAlign: "center" }}>
        <div style={{ fontSize: "2.5rem" }}>🔗</div>
        <h2 style={{ margin: 0 }}>اعتماد هذا الجهاز للمحل</h2>
        <p className="muted" style={{ margin: 0 }}>صاحب المحل بعتلك هذا الرابط. اضغط «اعتماد» على الجهاز اللي بتشتغل عليه في المحل.</p>
        {session.deviceToken && <div className="error">هذا الجهاز معتمد قبل. الاعتماد الجديد يبدّله.</div>}
        {error && <div className="error">{error}</div>}
        <button className="primary big" disabled={busy} onClick={() => void pair()}>اعتماد</button>
        <button className="ghost" onClick={() => { history.replaceState(null, "", location.pathname); onBack(); }}>مش الآن</button>
      </div>
    </div>
  );
}
