// «🧱 هياكل الكاشير»: frames the platform offers every shop. A shop copies one into its own
// (so its tills keep it offline), and a later change here doesn't move the shops already using it.
import { useEffect, useState } from "react";
import { STRUCTURES, structureCode, readStructureCode, type TillStructure } from "@pos/shared";
import { FrameEditor, FramePreview, newFrameId } from "../admin/FrameEditor";

type Call = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export function FramesTab({ call }: { call: Call }) {
  const [list, setList] = useState<TillStructure[] | null>(null);
  const [editing, setEditing] = useState<TillStructure | null>(null);
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    call<{ structures: TillStructure[] }>("/platform/till-structures").then((r) => setList(r.structures)).catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  }, [call]);

  async function publish(next: TillStructure[]) {
    setMsg(null);
    try {
      const r = await call<{ structures: TillStructure[] }>("/platform/till-structures", { method: "PUT", body: { structures: next } });
      setList(r.structures);
      setEditing(null);
      setMsg({ text: "تم النشر ✓ المحلات تشوفها في «🖥 واجهة الكاشير ← 📚 هياكل جاهزة من المنصة»." });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  }

  if (!list) return msg ? <div className="error">{msg.text}</div> : <div className="muted">جاري التحميل…</div>;
  if (editing) {
    return (
      <section className="card stack">
        <b>{list.some((x) => x.id === editing.id) ? "✏️ تعديل هيكل" : "🧩 هيكل جديد للمكتبة"}</b>
        <FrameEditor value={editing} onCancel={() => setEditing(null)}
          onSave={(st) => void publish(list.some((x) => x.id === st.id) ? list.map((x) => (x.id === st.id ? st : x)) : [...list, st])} />
      </section>
    );
  }
  const start = (st: TillStructure) => setEditing({ ...st, id: newFrameId("p"), name: `${st.name} (جديد)`.slice(0, 40) });
  return (
    <section className="card stack">
      <b>🧱 مكتبة هياكل شاشة الكاشير</b>
      <small className="muted">الهياكل اللي تنشرها هنا تبان لكل المحلات تحت الهياكل الجاهزة. المحل ياخذ نسخة لنفسه، فتعديلك بعدين ما يغيّرش محل اختارها قبل.</small>
      <div className="frames">
        {list.map((st, i) => (
          <div key={st.id} className="frame-card">
            <FramePreview st={st} />
            <b>{st.icon} {st.name}</b>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              <button className="ghost small" onClick={() => setEditing(st)}>✏️ تعديل</button>
              <button className="ghost small" disabled={i === 0} onClick={() => { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; void publish(l); }}>▲</button>
              <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(structureCode(st))}>📤 كود</button>
              <button className="ghost small danger" onClick={() => void publish(list.filter((x) => x.id !== st.id))}>🗑</button>
            </div>
          </div>
        ))}
        {!list.length && <span className="muted">ما فيش هياكل منشورة بعد.</span>}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span>ابدأ من:</span>
        {STRUCTURES.map((st) => <button key={st.id} className="small" onClick={() => start(st)}>{st.icon} {st.name}</button>)}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="أو الصق كود هيكل من محل: SALE7-FRAME:…" />
        <button onClick={() => { const st = readStructureCode(paste); if (!st) return setMsg({ text: "الكود هذا مش كود هيكل صحيح.", bad: true }); setPaste(""); start({ ...st, name: st.name.replace(/ \(جديد\)$/, "") }); }}>📥 لصق</button>
      </div>
      {msg && <div className={msg.bad ? "error" : "badge ok"}>{msg.text}</div>}
    </section>
  );
}
