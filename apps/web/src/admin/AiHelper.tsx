import { useCallback, useEffect, useRef, useState } from "react";
import type { AiKind, AiRow, AiStatus } from "@pos/shared";
import type { Call } from "./Admin";

/**
 * Whether the helper answers for this shop. `null` while asking, and when the platform has no key
 * (the demo, the offline edition): then nothing about it is shown at all.
 */
export function useAiStatus(call: Call) {
  const [s, setS] = useState<AiStatus | null>(null);
  const refresh = useCallback(() => call<AiStatus>("/ai/status").then(setS).catch(() => setS(null)), [call]);
  useEffect(() => void refresh(), [refresh]);
  const used = useCallback((u: { usedToday: number; dailyLimit: number }) =>
    setS((o) => (o ? { ...o, usedToday: u.usedToday, dailyLimit: u.dailyLimit, ready: u.usedToday < u.dailyLimit, reason: u.usedToday < u.dailyLimit ? null : `خلصت محاولات المساعد لليوم (${u.dailyLimit}). ترجع بكرة.` } : o)), []);
  const shown = !!s && (s.ready || !!s.reason);
  return { status: s, shown, used, refresh };
}

export const AI_PRIVACY = "اللي تبعته للمساعد (الكلام والقوائم والصور) يمشي لشركة الذكاء الاصطناعي اللي يستعملها النظام (Google أو Anthropic) باش يتقرا. ما تبعتش أرقام بطاقات أو كلمات سر.";

const left = (s: AiStatus) => Math.max(0, s.dailyLimit - s.usedToday);

interface Msg { role: "user" | "assistant"; text: string }

/** A chat that answers questions about moving from the notebook, in the shop's own words. */
export function AiChat({ call, step, ai }: { call: Call; step: string | null; ai: ReturnType<typeof useAiStatus> }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [msgs, busy]);
  if (!ai.shown || !ai.status) return null;
  const s = ai.status;

  async function ask(q: string) {
    q = q.trim();
    if (!q || busy) return;
    const next = [...msgs, { role: "user" as const, text: q }];
    setMsgs(next); setText(""); setBusy(true); setError(null);
    try {
      const r = await call<{ reply: string; usedToday: number; dailyLimit: number }>("/ai/chat", { body: { step: step ?? undefined, messages: next.slice(-16) } });
      setMsgs([...next, { role: "assistant", text: r.reply }]);
      ai.used(r);
    } catch (e) {
      setError((e as Error).message);
      setMsgs(msgs);
      setText(q);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="card row wrap ai-bar">
        <span>🤖 <b>عندك سؤال؟</b> <span className="muted">المساعد الذكي يجاوبك باللهجة الليبية على أي حاجة في نقل الدفتر.</span></span>
        <span className="spacer" />
        <button className="primary" onClick={() => setOpen(true)}>🤖 اسأل المساعد</button>
      </div>
    );
  }
  const ideas = ["كيف ندخل صنف يتباع بالحبة وبالصندوق؟", "عندي الأصناف في الواتساب، كيف ندخلهم؟", "شنو نديرو بعد ما نكملو الخطوات؟"];
  return (
    <div className="card stack ai-chat">
      <div className="row">
        <b>🤖 المساعد الذكي</b>
        <span className="spacer" />
        <small className="muted">باقي اليوم {left(s)} من {s.dailyLimit}</small>
        <button className="ghost" aria-label="قفل المساعد" onClick={() => setOpen(false)}>✕</button>
      </div>
      <div className="ai-msgs" aria-live="polite">
        {msgs.length === 0 && (
          <div className="stack">
            <span className="muted">مرحبا 👋 اسألني أي حاجة على نقل شغلك من الدفتر للنظام. مثلاً:</span>
            <div className="row wrap">{ideas.map((q) => <button key={q} className="ghost chip" disabled={!s.ready} onClick={() => void ask(q)}>{q}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`ai-msg ${m.role}`}>{m.text}</div>)}
        {busy && <div className="ai-msg assistant muted">يكتب…</div>}
        <div ref={end} />
      </div>
      {s.reason && <div className="notice">{s.reason}</div>}
      {error && <div className="error">{error}</div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="اكتب سؤالك…" maxLength={2000} disabled={!s.ready} aria-label="سؤالك للمساعد" style={{ flex: 1 }} />
        <button className="primary" disabled={busy || !text.trim() || !s.ready}>إرسال</button>
      </form>
      <small className="muted">{AI_PRIVACY} المساعد ممكن يغلط، راجع اللي يقوله.</small>
    </div>
  );
}

/** Makes a phone photo small enough to send (and plenty for reading handwriting). */
export async function shrinkPhoto(f: File, max = 1600): Promise<{ data: string; mediaType: "image/jpeg" }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("ما قدرناش نفتحو الصورة. جرّب صورة ثانية (JPG أو PNG)."));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { data: c.toDataURL("image/jpeg", 0.85).split(",")[1], mediaType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface AiIssue { row: number; message: string }

/**
 * The helper's buttons over the hand-typed grid: sort a pasted list or a notebook photo into lines,
 * and look over the lines before they go in. `rows` are the filled lines; `onRows` adds new ones.
 */
export function AiTools({ call, kind, ai, rows, onRows, onIssues }: {
  call: Call; kind: AiKind; ai: ReturnType<typeof useAiStatus>;
  rows: AiRow[]; onRows: (rows: AiRow[]) => void; onIssues: (issues: AiIssue[] | null) => void;
}) {
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState<"paste" | "photo" | "check" | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  if (!ai.shown || !ai.status) return null;
  const s = ai.status;

  async function run<T extends { usedToday: number; dailyLimit: number }>(what: "paste" | "photo" | "check", path: string, body: unknown, done: (r: T) => void) {
    setBusy(what); setNote(null);
    try {
      const r = await call<T>(path, { body });
      ai.used(r);
      done(r);
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }
  const got = (r: { rows: AiRow[]; note: string }) => {
    if (!r.rows.length) { setNote({ text: r.note || "ما لقيناش سطور واضحة. جرّب تكتب كل حاجة في سطر.", bad: true }); return; }
    onRows(r.rows);
    onIssues(null);
    setNote({ text: `✓ زدنا ${r.rows.length} سطر للجدول. راجعهم قبل ما تدخلهم.${r.note ? ` ملاحظة: ${r.note}` : ""}` });
  };
  async function photo(f: File | undefined) {
    if (!f) return;
    let img;
    try {
      img = await shrinkPhoto(f);
    } catch (e) {
      setNote({ text: (e as Error).message, bad: true });
      return;
    }
    await run<{ rows: AiRow[]; note: string; usedToday: number; dailyLimit: number }>("photo", "/ai/photo", { kind, ...img }, got);
  }

  return (
    <div className="stack ai-tools">
      <div className="row wrap">
        <span>🤖</span>
        <button disabled={!s.ready || !!busy} onClick={() => setPaste(paste === null ? "" : null)}>📋 الصق قائمة</button>
        <label className={`file-pick ${!s.ready || busy ? "disabled" : ""}`}>
          <input type="file" accept="image/*" capture="environment" disabled={!s.ready || !!busy} onChange={(e) => { void photo(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="btn-like">{busy === "photo" ? "يقرا في الصورة…" : "📷 صورة الدفتر"}</span>
        </label>
        <button disabled={!s.ready || !!busy || !rows.length} onClick={() => void run<{ issues: AiIssue[]; usedToday: number; dailyLimit: number }>("check", "/ai/check", { kind, rows }, (r) => {
          onIssues(r.issues);
          setNote(r.issues.length ? { text: `لقينا ${r.issues.length} حاجة تستاهل تشوفها، معلّمين في الجدول.`, bad: true } : { text: "✓ راجعنا الجدول وما لقيناش مشاكل واضحة." });
        })}>{busy === "check" ? "يراجع…" : "🔍 راجع قبل الإدخال"}</button>
        <span className="spacer" />
        <small className="muted">باقي اليوم {left(s)} من {s.dailyLimit}</small>
      </div>
      {s.reason && <div className="notice">{s.reason}</div>}
      {paste !== null && (
        <div className="stack">
          <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} maxLength={20000} autoFocus aria-label="القائمة الملصوقة"
            placeholder={kind === "products" ? "الصق أي قائمة: من الواتساب، من Excel، أو اكتبها كلام…\nمثلاً:\nبيبسي علبة 1.5 دينار عندي 48\nحليب نيدو كبير 18 والصندوق فيه 6\nطماطم بالكيلو 4 دينار" : "الصق الأسماء والأرقام والمبالغ، كل واحد في سطر أو كيف ما هي…"} />
          <div className="row">
            <button className="primary" disabled={!!busy || (paste ?? "").trim().length < 2}
              onClick={() => void run<{ rows: AiRow[]; note: string; usedToday: number; dailyLimit: number }>("paste", "/ai/structure", { kind, text: paste }, (r) => { got(r); if (r.rows.length) setPaste(null); })}>
              {busy === "paste" ? "يرتب…" : "رتّبها في الجدول"}
            </button>
            <button className="ghost" onClick={() => setPaste(null)}>إلغاء</button>
          </div>
        </div>
      )}
      {note && <div className={note.bad ? "notice" : "badge ok"}>{note.text}</div>}
      <small className="muted">{AI_PRIVACY}</small>
    </div>
  );
}
