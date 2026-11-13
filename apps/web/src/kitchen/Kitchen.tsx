import { useEffect, useRef, useState } from "react";
import { KITCHEN_LABELS, ORDER_TYPE_ICONS, ORDER_TYPE_LABELS, formatQty, type KitchenLine, type KitchenStatus, type OrderType } from "@pos/shared";
import { api } from "../api";
import { session } from "../session";
import { sound } from "../pos/feel";
import type { Screen } from "../App";

interface Ticket { id: string; label: string; order_type: OrderType; table_name: string | null; lines: KitchenLine[]; status: KitchenStatus; created_at: string; ready_at: string | null }

const NEXT: Partial<Record<KitchenStatus, [KitchenStatus, string]>> = { new: ["preparing", "ابدأ التحضير"], preparing: ["ready", "✓ جاهز"], ready: ["served", "تم التسليم"] };

/**
 * The screen over the kitchen pass: each order the till sent, oldest first, with how long it has
 * been waiting. A tap moves it on: being made, ready, handed over. No one signs in; the screen is a
 * device the owner approved as a kitchen screen.
 */
export function Kitchen({ go }: { go: (s: Screen) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [store, setStore] = useState("");
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);
  const [taps, setTaps] = useState(0);
  const [beep, setBeep] = useState(true);
  const seen = useRef<Set<string> | null>(null);

  const load = async () => {
    try {
      const r = await api<{ device: { storeName: string }; serverTime: string; tickets: Ticket[] }>("/kitchen/screen", { body: { deviceToken: session.deviceToken } });
      setStore(r.device.storeName);
      setSkew(Date.parse(r.serverTime) - Date.now());
      setOffline(false);
      // A new order rings once; the first load is quiet.
      const fresh = r.tickets.filter((t) => t.status === "new" && seen.current && !seen.current.has(t.id));
      if (fresh.length) sound("cash", beep);
      seen.current = new Set(r.tickets.map((t) => t.id));
      setTickets(r.tickets);
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        session.deviceToken = null;
        session.deviceKind = null;
        return go("setup");
      }
      setOffline(true);
    }
  };
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 4000);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(poll); clearInterval(clock); };
  }, [beep]); // eslint-disable-line react-hooks/exhaustive-deps

  async function move(t: Ticket, status: KitchenStatus) {
    setTickets((ts) => ts.map((x) => (x.id === t.id ? { ...x, status } : x)));
    try {
      await api("/kitchen/screen/status", { body: { deviceToken: session.deviceToken, id: t.id, status } });
    } catch {
      setOffline(true);
    }
    void load();
  }

  const open = tickets.filter((t) => t.status !== "served");
  const done = tickets.filter((t) => t.status === "served");
  const mins = (iso: string) => Math.max(0, Math.floor((now + skew - Date.parse(iso)) / 60_000));

  return (
    <div className="kitchen">
      <header>
        <b onClick={() => setTaps((n) => (n >= 4 ? (go("setup"), 0) : n + 1))}>👨‍🍳 المطبخ · {store}</b>
        <span className="spacer" />
        {offline && <span className="badge bad">ما فيش اتصال، نعاودوا نحاولوا</span>}
        <span className="badge">{open.filter((t) => t.status === "new").length} جديد</span>
        <span className="badge warn">{open.filter((t) => t.status === "preparing").length} قيد التحضير</span>
        <span className="badge ok">{open.filter((t) => t.status === "ready").length} جاهز</span>
        <button onClick={() => setBeep(!beep)}>{beep ? "🔔 الصوت شغال" : "🔕 بدون صوت"}</button>
        <span className="num">{new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
      </header>
      {taps > 0 && <div className="muted" style={{ textAlign: "center" }}>اضغط {5 - taps} مرات على الاسم للخروج</div>}
      {open.length === 0 ? (
        <div className="kitchen-empty">ما فيش طلبات توا ☕</div>
      ) : (
        <div className="kitchen-grid">
          {open.map((t) => {
            const m = mins(t.created_at);
            const next = NEXT[t.status];
            return (
              <article key={t.id} className={`ticket ${t.status} ${m >= 20 ? "late" : m >= 10 ? "slow" : ""}`}>
                <div className="ticket-head">
                  <b>{t.label}</b>
                  <span className="num">{m} د</span>
                </div>
                <div className="muted">{ORDER_TYPE_ICONS[t.order_type]} {ORDER_TYPE_LABELS[t.order_type]} · {KITCHEN_LABELS[t.status]}</div>
                <ul>
                  {t.lines.map((l, i) => (
                    <li key={i} className={l.cancelled ? "cancelled" : ""}>
                      <span className="num">{formatQty(l.qtyMilli, l.qtyMilli % 1000 !== 0)}×</span> {l.cancelled && "✖ إلغاء: "}{l.name}
                      {l.note && <div className="note">«{l.note}»</div>}
                    </li>
                  ))}
                </ul>
                {next && <button className={t.status === "preparing" ? "primary" : ""} onClick={() => void move(t, next[0])}>{next[1]}</button>}
              </article>
            );
          })}
        </div>
      )}
      {done.length > 0 && (
        <div className="kitchen-done">
          <span className="muted">آخر المسلّم:</span>
          {done.map((t) => <button key={t.id} className="ghost" onClick={() => void move(t, "ready")} title="رجّعه جاهز">↩ {t.label}</button>)}
        </div>
      )}
    </div>
  );
}
