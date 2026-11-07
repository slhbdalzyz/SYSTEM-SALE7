import { useCallback, useEffect, useState } from "react";
import type { Call } from "./Admin";
import { Conversation, TICKET_BADGE, TICKET_LABEL, type TicketView } from "../platform/Pro";

const when = (s: string) => new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

interface Ann { id: string; title: string; body: string; level: "info" | "warn" | "promo" }

/** Messages from the service to the shop, shown on top until each user closes them. */
export function Announcements({ call }: { call: Call }) {
  const [rows, setRows] = useState<Ann[]>([]);
  useEffect(() => void call<Ann[]>("/announcements").then(setRows).catch(() => undefined), [call]);
  if (!rows.length) return null;
  const icon = { info: "📢", warn: "⚠️", promo: "🎁" };
  return (
    <div>
      {rows.map((a) => (
        <div key={a.id} className={`announce ${a.level}`}>
          <span style={{ fontSize: "1.3rem" }}>{icon[a.level]}</span>
          <div className="body"><b>{a.title}</b>{a.body && <div>{a.body}</div>}</div>
          <button className="ghost" aria-label="إغلاق" onClick={() => { setRows((r) => r.filter((x) => x.id !== a.id)); void call(`/announcements/${a.id}/dismiss`, { body: {} }).catch(() => undefined); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

interface TicketRow { id: string; number: number; subject: string; status: "open" | "answered" | "closed"; created_at: string; updated_at: string; last_author: "shop" | "platform" | null }

/** Support: ask the service a question, follow the answer, and let the support team look at the shop. */
export function Support({ call, isOwner }: { call: Call; isOwner: boolean }) {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ subject: "", body: "" });
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => call<TicketRow[]>("/support/tickets").then(setRows), [call]);
  useEffect(() => void load(), [load]);
  if (sel) return <Ticket call={call} id={sel} back={() => { setSel(null); void load(); }} />;
  async function send() {
    setMsg(null);
    try {
      const r = await call<{ number: number }>("/support/tickets", { body: f });
      setF({ subject: "", body: "" });
      setMsg({ text: `تم إرسال طلبك رقم ${r.number}. بنرد عليك هنا، ويوصلك تنبيه.` });
      await load();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }
  return (
    <div className="stack">
      {isOwner && <SupportAccess call={call} />}
      <div className="card stack">
        <h3 style={{ margin: 0 }}>طلب دعم جديد</h3>
        <label>الموضوع<input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="مثلاً: الطابعة ما تطبعش الإيصال" /></label>
        <label>اشرح المشكلة<textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
        <div><button className="primary" disabled={f.subject.trim().length < 3 || !f.body.trim()} onClick={() => void send()}>إرسال</button></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>طلباتك</h3>
        {rows.length === 0 ? <p className="muted">ما عندكش طلبات دعم.</p> : (
          <table>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => setSel(t.id)} style={{ cursor: "pointer" }}>
                  <td className="num">#{t.number}</td>
                  <td><b>{t.subject}</b>{t.status === "answered" && <div className="muted">وصلك رد 💬</div>}</td>
                  <td className="num">{when(t.updated_at)}</td>
                  <td><span className={`badge ${TICKET_BADGE[t.status]}`}>{TICKET_LABEL[t.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Ticket({ call, id, back }: { call: Call; id: string; back: () => void }) {
  const [t, setT] = useState<TicketView | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call<TicketView>(`/support/tickets/${id}`).then(setT), [call, id]);
  useEffect(() => void load(), [load]);
  async function send(close: boolean) {
    setError(null);
    try {
      await call(`/support/tickets/${id}/reply`, { body: { body: reply, close } });
      setReply("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!t) return <div className="muted">جاري التحميل…</div>;
  return (
    <div className="stack">
      <div className="row">
        <button onClick={back}>→ رجوع</button>
        <h2 style={{ margin: 0 }}>#{t.number} {t.subject}</h2>
        <span className={`badge ${TICKET_BADGE[t.status]}`}>{TICKET_LABEL[t.status]}</span>
      </div>
      <Conversation t={t} />
      <div className="card stack">
        <textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t.status === "closed" ? "اكتب لو تبي تفتحه من جديد…" : "ردّك…"} />
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="primary" disabled={!reply.trim()} onClick={() => void send(false)}>إرسال</button>
          <span className="spacer" />
          {t.status !== "closed" && <button onClick={() => void send(true)}>المشكلة انحلت، اقفل الطلب</button>}
        </div>
      </div>
    </div>
  );
}

/** The owner's switch: let the support team open the shop, read only, for a few hours. */
function SupportAccess({ call }: { call: Call }) {
  const [s, setS] = useState<{ until: string | null; logins: { created_at: string; data: { by?: string } | null }[] } | null>(null);
  const [hours, setHours] = useState(2);
  const load = useCallback(() => call<typeof s>("/support/access").then(setS), [call]);
  useEffect(() => void load(), [load]);
  if (!s) return null;
  const set = (h: number) => call("/support/access", { body: { hours: h } }).then(load);
  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>السماح للدعم الفني يشوف حسابك</h3>
        <span className="spacer" />
        {s.until ? <span className="badge ok">مسموح لين {new Date(s.until).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</span> : <span className="badge off">مقفول</span>}
      </div>
      <p className="muted" style={{ margin: 0 }}>لو المشكلة صعبة تتشرح، اسمح لفريق الدعم يفتح حسابك ويشوف بنفسه. يقدر يشوف بس، ما يقدرش يغيّر أي شي ولا ياخذ نسخة من بياناتك، والإذن يتقفل وحده بعد المدة. كل دخول يتسجل هنا وفي «سجل العمليات».</p>
      <div className="row">
        {s.until ? (
          <button className="danger" onClick={() => void set(0)}>اقفل الإذن الآن</button>
        ) : (
          <>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ width: "auto" }}>
              {[1, 2, 4, 8, 24, 72].map((h) => <option key={h} value={h}>{h < 24 ? `${h} ساعة` : `${h / 24} يوم`}</option>)}
            </select>
            <button className="primary" onClick={() => void set(hours)}>اسمح</button>
          </>
        )}
      </div>
      {s.logins.length > 0 && (
        <div className="muted">آخر دخول للدعم: {s.logins.map((l) => `${l.data?.by ?? ""} (${when(l.created_at)})`).join("، ")}</div>
      )}
    </div>
  );
}
