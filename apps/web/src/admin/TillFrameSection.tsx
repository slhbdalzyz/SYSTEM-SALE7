// «🖥 واجهة الكاشير» part two: the screen's frame (where the cart, the total and the buttons
// sit), its colours, spacing and type, a frame for each till or cashier or for a whole branch,
// frames of the shop's own, codes to pass a frame to another shop, and the platform's library.
import { useEffect, useState } from "react";
import {
  FONT_LABELS, STRUCTURES, STRUCTURE_TEXT, THEME_INFO, TILL_FONTS, TILL_THEMES, readStructureCode, structureById, structureCode,
  type TillLayoutSettings, type TillStructure,
} from "@pos/shared";
import type { Call } from "./Admin";
import { FrameEditor, FramePreview, newFrameId } from "./FrameEditor";

interface Device { id: string; name: string; kind?: string; store_id?: string }
interface User { id: string; name: string; role: string }
interface Store { id: string; name: string }

export function TillFrameSection({ call, s, save, devices, users }: {
  call: Call;
  s: TillLayoutSettings;
  save: (next: TillLayoutSettings) => void;
  devices: Device[];
  users: User[];
}) {
  const [library, setLibrary] = useState<TillStructure[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [editing, setEditing] = useState<TillStructure | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [code, setCode] = useState<{ name: string; code: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const theme = s.theme.name;

  useEffect(() => {
    call<{ structures: TillStructure[] }>("/till-structures/library").then((r) => setLibrary(r.structures)).catch(() => setLibrary([]));
    call<Store[]>("/stores").then(setStores).catch(() => setStores([]));
  }, [call]);

  const all = [...STRUCTURES, ...s.structures];
  const options = all.map((st) => <option key={st.id} value={st.id}>{st.icon} {st.name}</option>);

  function keep(st: TillStructure) {
    const exists = s.structures.some((x) => x.id === st.id);
    save({ ...s, structures: exists ? s.structures.map((x) => (x.id === st.id ? st : x)) : [...s.structures, st] });
    setEditing(null);
  }
  function remove(id: string) {
    const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== id));
    save({
      ...s,
      structures: s.structures.filter((x) => x.id !== id),
      frame: { shop: s.frame.shop === id ? "classic" : s.frame.shop, devices: clean(s.frame.devices), users: clean(s.frame.users) },
    });
  }
  const copyOf = (st: TillStructure, name = st.name): TillStructure => ({ ...st, id: newFrameId("c"), name: name.slice(0, 40) });
  const pickFor = (kind: "devices" | "users", id: string, v: string) => {
    const map = { ...s.frame[kind] };
    if (v) map[id] = v;
    else delete map[id];
    save({ ...s, frame: { ...s.frame, [kind]: map } });
  };
  const forBranch = (storeId: string, v: string) => {
    const map = { ...s.frame.devices };
    for (const d of devices.filter((x) => x.store_id === storeId)) {
      if (v) map[d.id] = v;
      else delete map[d.id];
    }
    save({ ...s, frame: { ...s.frame, devices: map } });
    setNote(`تم: كل أجهزة «${stores.find((x) => x.id === storeId)?.name ?? "الفرع"}» ${v ? `على «${structureById(s, v).name}»` : "رجعت زي المحل"}.`);
  };

  if (editing) {
    return (
      <div className="card stack" style={{ padding: 12 }}>
        <b>{s.structures.some((x) => x.id === editing.id) ? "✏️ تعديل الهيكل" : "🧩 هيكل جديد"}</b>
        <small className="muted">اسحب الأجزاء بين الأعمدة وغيّر ترتيبها، أو استعمل الأسهم. المعاينة تتبدّل معاك.</small>
        <FrameEditor value={editing} theme={theme} onSave={keep} onCancel={() => setEditing(null)} />
      </div>
    );
  }

  const card = (st: TillStructure, own: boolean) => (
    <div key={st.id} className={`frame-card${s.frame.shop === st.id ? " active" : ""}`} role="button" tabIndex={0}
      onClick={() => save({ ...s, frame: { ...s.frame, shop: st.id } })}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && save({ ...s, frame: { ...s.frame, shop: st.id } })}>
      <FramePreview st={structureById({ structures: s.structures }, st.id)} theme={theme} />
      <b>{st.icon} {st.name}{s.frame.shop === st.id ? " ✓" : ""}</b>
      {STRUCTURE_TEXT[st.id] && <small>{STRUCTURE_TEXT[st.id]}</small>}
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
        {own && <button className="ghost small" onClick={() => setEditing(st)}>✏️ تعديل</button>}
        <button className="ghost small" onClick={() => setEditing(copyOf(st, `${st.name} (نسخة)`))}>📋 نسخة</button>
        <button className="ghost small" onClick={() => setCode({ name: st.name, code: structureCode(st) })}>📤 كود</button>
        {own && <button className="ghost small danger" onClick={() => remove(st.id)}>🗑</button>}
      </div>
    </div>
  );

  return (
    <div className="stack">
      <b>🧱 هيكل الشاشة</b>
      <small className="muted">وين تجي السلة والمجموع والأزرار. اختار هيكل للمحل كامل، أو ابني هيكلك بالسحب.</small>
      <div className="frames">
        {STRUCTURES.map((st) => card(st, false))}
        {s.structures.map((st) => card(st, true))}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setEditing(copyOf(structureById(s, s.frame.shop), "هيكلي"))}>🧩 ابني هيكل بالسحب</button>
        <button onClick={() => setPaste("")}>📥 لصق كود هيكل</button>
      </div>
      {paste !== null && (
        <div className="stack" style={{ gap: 6 }}>
          <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="SALE7-FRAME:…" />
          <div className="row" style={{ gap: 6 }}>
            <button className="primary" onClick={() => {
              const st = readStructureCode(paste);
              if (!st) return setNote("الكود هذا مش كود هيكل صحيح.");
              keep(copyOf(st));
              setPaste(null);
              setNote(`تمت إضافة «${st.name}» لهياكلك.`);
            }}>إضافة</button>
            <button onClick={() => setPaste(null)}>إلغاء</button>
          </div>
        </div>
      )}
      {code && (
        <div className="stack" style={{ gap: 6 }}>
          <small className="muted">انسخ الكود هذا وحطه في «📥 لصق كود هيكل» في محل ثاني، وياخذ «{code.name}» زي ما هو.</small>
          <textarea rows={3} readOnly value={code.code} onFocus={(e) => e.target.select()} />
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => void navigator.clipboard?.writeText(code.code).then(() => setNote("تم نسخ الكود ✓"), () => undefined)}>📋 انسخ</button>
            <button onClick={() => setCode(null)}>تم</button>
          </div>
        </div>
      )}

      {library.length > 0 && (
        <details open>
          <summary>📚 هياكل جاهزة من المنصة ({library.length})</summary>
          <div className="frames" style={{ marginTop: 8 }}>
            {library.map((st) => (
              <div key={st.id} className="frame-card">
                <FramePreview st={st} theme={theme} />
                <b>{st.icon} {st.name}</b>
                <button className="small" onClick={() => {
                  const mine = copyOf(st);
                  save({ ...s, structures: [...s.structures, mine], frame: { ...s.frame, shop: mine.id } });
                  setNote(`«${st.name}» انضاف لهياكلك وصار هيكل المحل.`);
                }}>➕ خذه لمحلي</button>
              </div>
            ))}
          </div>
        </details>
      )}

      {(devices.length > 0 || users.length > 0) && (
        <details>
          <summary>هيكل خاص لجهاز أو لكاشير أو لفرع</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {stores.length > 1 && stores.map((st) => (
              <label key={st.id} className="row" style={{ gap: 8 }}>🏬 كل أجهزة {st.name}
                <select defaultValue="__" onChange={(e) => { forBranch(st.id, e.target.value); e.target.value = "__"; }} style={{ width: "auto" }}>
                  <option value="__" disabled>اختار…</option>
                  <option value="">رجّعهم زي المحل</option>
                  {options}
                </select>
              </label>
            ))}
            {devices.map((d) => (
              <label key={d.id} className="row" style={{ gap: 8 }}>🖥 {d.name}
                <select value={s.frame.devices[d.id] ?? ""} onChange={(e) => pickFor("devices", d.id, e.target.value)} style={{ width: "auto" }}>
                  <option value="">زي المحل</option>
                  {options}
                </select>
              </label>
            ))}
            {users.filter((u) => u.role !== "owner").map((u) => (
              <label key={u.id} className="row" style={{ gap: 8 }}>👤 {u.name}
                <select value={s.frame.users[u.id] ?? ""} onChange={(e) => pickFor("users", u.id, e.target.value)} style={{ width: "auto" }}>
                  <option value="">زي الجهاز</option>
                  {options}
                </select>
              </label>
            ))}
            <small className="muted">الترتيب: هيكل الكاشير، وبعده هيكل الجهاز، وبعده هيكل المحل.</small>
          </div>
        </details>
      )}

      <b>🎨 الألوان والخط</b>
      <div className="theme-picks">
        {TILL_THEMES.map((t) => (
          <button key={t} className={`theme-pick${theme === t ? " active" : ""}`} onClick={() => save({ ...s, theme: { ...s.theme, name: t } })}>
            <i style={{ background: `linear-gradient(135deg, ${THEME_INFO[t].brand} 50%, ${THEME_INFO[t].bg} 50%)` }} />{THEME_INFO[t].label}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label>المسافات
          <div className="seg">
            <button className={s.theme.density === "comfortable" ? "active" : ""} onClick={() => save({ ...s, theme: { ...s.theme, density: "comfortable" } })}>مريحة</button>
            <button className={s.theme.density === "compact" ? "active" : ""} onClick={() => save({ ...s, theme: { ...s.theme, density: "compact" } })}>مضغوطة</button>
          </div>
        </label>
        <label>الخط
          <select value={s.theme.font} onChange={(e) => save({ ...s, theme: { ...s.theme, font: e.target.value as (typeof TILL_FONTS)[number] } })} style={{ width: "auto" }}>
            {TILL_FONTS.map((f) => <option key={f} value={f}>{FONT_LABELS[f]}</option>)}
          </select>
        </label>
      </div>
      <small className="muted">الكاشير يقدر يختار ألوان ثانية لنفسه من «🎨 العرض». الخطوط من الجهاز نفسه، فتمشي من غير إنترنت.</small>
      {note && <span className="badge ok" onClick={() => setNote(null)}>{note}</span>}
    </div>
  );
}
