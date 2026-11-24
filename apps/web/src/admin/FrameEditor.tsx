// The cashier screen's frames: a small live picture of each, and the editor where the owner (or
// the platform, for its library) drags the screen's parts between columns and builds their own.
import { useState, type DragEvent } from "react";
import {
  COLUMN_WIDTHS, REQUIRED_BLOCKS, THEME_INFO, TILL_BLOCKS, TILL_BLOCK_LABELS, normalizeStructure,
  type TillBlock, type TillStructure, type TillTheme,
} from "@pos/shared";

const SHORT: Record<TillBlock, string> = { scan: "🔎 بحث", grid: "🟦 مربعات", quick: "🔘 سريعة", tabs: "👥 زبائن", cart: "🛒 السلة", totals: "💰 المجموع", keys: "⌨️ دفع" };
const width = (w: string) => (w.endsWith("px") ? `${Math.round(parseInt(w, 10) / 4.5)}px` : w);

/** A small picture of a frame in the shop's colours, updated as the owner changes it. */
export function FramePreview({ st, theme = "light" }: { st: TillStructure; theme?: TillTheme }) {
  const t = THEME_INFO[theme];
  const block = (b: TillBlock) => (
    <div key={b} className={`fprev-b ${b}`} style={{ background: b === "keys" || b === "totals" ? t.brand : t.panel, color: b === "keys" || b === "totals" ? "#fff" : t.ink, border: `1px solid ${t.brand}33` }}>
      {SHORT[b]}
    </div>
  );
  return (
    <div className="fprev" style={{ background: t.bg, gridTemplateRows: st.bottom.length ? "1fr auto" : "1fr" }} aria-hidden>
      <div className="fprev-main" style={{ gridTemplateColumns: st.cols.map((c) => width(c.w)).join(" ") }}>
        {st.cols.map((c, i) => <div key={i} className="fprev-col">{c.blocks.map(block)}</div>)}
      </div>
      {st.bottom.length > 0 && (
        <div className={`fprev-bottom${st.sheet ? " sheet" : ""}`} style={st.sheet ? { background: t.panel, borderTop: `2px solid ${t.brand}` } : undefined}>
          {st.sheet ? <div className="fprev-b" style={{ background: t.brand, color: "#fff", textAlign: "center" }}>▲ 🛒 السلة والدفع</div> : st.bottom.map(block)}
        </div>
      )}
    </div>
  );
}

type Place = { zone: number | "bottom"; index: number };

/** Builds a frame by dragging its parts (or with the arrows, on a touch screen). */
export function FrameEditor({ value, theme, onSave, onCancel }: { value: TillStructure; theme?: TillTheme; onSave: (st: TillStructure) => void; onCancel: () => void }) {
  const [st, setSt] = useState<TillStructure>(value);
  const [drag, setDrag] = useState<TillBlock | null>(null);
  const [over, setOver] = useState<number | "bottom" | null>(null);
  const used = new Set<TillBlock>([...st.cols.flatMap((c) => c.blocks), ...st.bottom]);
  const unused = TILL_BLOCKS.filter((b) => !used.has(b));
  const missing = REQUIRED_BLOCKS.filter((b) => !used.has(b));

  const listOf = (s: TillStructure, z: number | "bottom") => (z === "bottom" ? s.bottom : s.cols[z].blocks);
  const without = (s: TillStructure, b: TillBlock): TillStructure => ({
    ...s,
    cols: s.cols.map((c) => ({ ...c, blocks: c.blocks.filter((x) => x !== b) })),
    bottom: s.bottom.filter((x) => x !== b),
  });
  const put = (b: TillBlock, to: Place) => {
    setSt((s) => {
      const n = without(s, b);
      const list = [...listOf(n, to.zone)];
      list.splice(Math.min(to.index, list.length), 0, b);
      return to.zone === "bottom" ? { ...n, bottom: list } : { ...n, cols: n.cols.map((c, i) => (i === to.zone ? { ...c, blocks: list } : c)) };
    });
  };
  const where = (b: TillBlock): Place | null => {
    for (let i = 0; i < st.cols.length; i++) if (st.cols[i].blocks.includes(b)) return { zone: i, index: st.cols[i].blocks.indexOf(b) };
    return st.bottom.includes(b) ? { zone: "bottom", index: st.bottom.indexOf(b) } : null;
  };
  const zones: (number | "bottom")[] = [...st.cols.map((_, i) => i), "bottom"];
  const step = (b: TillBlock, dz: number, di: number) => {
    const p = where(b);
    if (!p) return;
    const zi = zones.indexOf(p.zone) + dz;
    if (zi < 0 || zi >= zones.length) return;
    put(b, { zone: zones[zi], index: dz ? 99 : Math.max(0, p.index + di) });
  };

  const drop = (z: number | "bottom", index: number) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const b = (e.dataTransfer.getData("text/plain") || drag) as TillBlock;
    if (TILL_BLOCKS.includes(b)) put(b, { zone: z, index });
    setDrag(null);
    setOver(null);
  };
  const chip = (b: TillBlock, z: number | "bottom", i: number) => (
    <div key={b} className="fedit-chip" draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", b); setDrag(b); }}
      onDragEnd={() => { setDrag(null); setOver(null); }}
      onDragOver={(e) => e.preventDefault()} onDrop={drop(z, i)}>
      <span>{TILL_BLOCK_LABELS[b]}</span>
      <button className="ghost small" onClick={() => step(b, -1, 0)} aria-label="للعمود اللي قبله" title="للعمود اللي قبله">→</button>
      <button className="ghost small" onClick={() => step(b, 0, -1)} aria-label="فوق">▲</button>
      <button className="ghost small" onClick={() => step(b, 0, 1)} aria-label="تحت">▼</button>
      <button className="ghost small" onClick={() => step(b, 1, 0)} aria-label="للعمود اللي بعده" title="للعمود اللي بعده">←</button>
      {!REQUIRED_BLOCKS.includes(b) && <button className="ghost small" onClick={() => setSt((s) => without(s, b))} aria-label="شيل">✕</button>}
    </div>
  );
  const zone = (z: number | "bottom", list: TillBlock[], head: React.ReactNode) => (
    <div className={`fedit-col${over === z ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(z); }} onDragLeave={() => setOver((o) => (o === z ? null : o))} onDrop={drop(z, list.length)}>
      {head}
      {list.map((b, i) => chip(b, z, i))}
      {!list.length && <small className="muted">اسحب جزء لهنا</small>}
    </div>
  );

  return (
    <div className="fedit">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label style={{ width: 80 }}>رمز<input value={st.icon} maxLength={4} onChange={(e) => setSt({ ...st, icon: e.target.value })} /></label>
        <label style={{ flex: 1, minWidth: 160 }}>اسم الهيكل<input value={st.name} maxLength={40} onChange={(e) => setSt({ ...st, name: e.target.value })} /></label>
      </div>
      <FramePreview st={normalizeStructure(st)} theme={theme} />
      <div className="fedit-cols" style={{ gridTemplateColumns: `repeat(${st.cols.length}, minmax(0, 1fr))` }}>
        {st.cols.map((c, i) => zone(i, c.blocks, (
          <div className="row" style={{ gap: 4 }}>
            <b style={{ flex: 1 }}>العمود {i + 1}{i === 0 ? " (يمين)" : i === st.cols.length - 1 ? " (يسار)" : ""}</b>
            <select value={c.w} style={{ width: "auto" }} aria-label="العرض"
              onChange={(e) => setSt({ ...st, cols: st.cols.map((x, j) => (j === i ? { ...x, w: e.target.value as TillStructure["cols"][number]["w"] } : x)) })}>
              {COLUMN_WIDTHS.map((w) => <option key={w} value={w}>{w.endsWith("fr") ? `مرن ×${w.replace("fr", "")}` : `ثابت ${w.replace("px", "")}`}</option>)}
            </select>
            {st.cols.length > 1 && (
              <button className="ghost small" aria-label="شيل العمود" onClick={() => {
                const rest = st.cols.filter((_, j) => j !== i);
                rest[Math.max(0, i - 1)] = { ...rest[Math.max(0, i - 1)], blocks: [...rest[Math.max(0, i - 1)].blocks, ...c.blocks] };
                setSt({ ...st, cols: rest });
              }}>✕</button>
            )}
          </div>
        )))}
      </div>
      {zone("bottom", st.bottom, <b>الشريط اللي تحت {st.sheet && <small className="muted">(يطلع بالسحب من تحت)</small>}</b>)}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {st.cols.length < 3 && <button onClick={() => setSt({ ...st, cols: [...st.cols, { w: "340px", blocks: [] }] })}>+ عمود</button>}
        {unused.length > 0 && (
          <div className="fedit-palette">
            <small className="muted">أجزاء مش في الشاشة:</small>
            {unused.map((b) => <button key={b} className="small" draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", b); setDrag(b); }} onClick={() => put(b, { zone: st.cols.length - 1, index: 99 })}>+ {TILL_BLOCK_LABELS[b]}</button>)}
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 4 }}>
        <label className="check"><input type="checkbox" checked={st.sheet} onChange={(e) => setSt({ ...st, sheet: e.target.checked })} /> الشريط اللي تحت يطلع بالسحب (تابلت)</label>
        <label className="check"><input type="checkbox" checked={st.collapseKeys} onChange={(e) => setSt({ ...st, collapseKeys: e.target.checked })} /> أول 4 أزرار بس، والباقي في «⋯ المزيد»</label>
        <label className="check"><input type="checkbox" checked={st.showGrid} onChange={(e) => setSt({ ...st, showGrid: e.target.checked })} /> مربعات الأصناف تبان في أي نشاط</label>
        <label className="check"><input type="checkbox" checked={st.sideCats} onChange={(e) => setSt({ ...st, sideCats: e.target.checked })} /> الأقسام عمود على جنب المربعات</label>
      </div>
      {missing.length > 0 && <small className="muted">ناقص: {missing.map((b) => TILL_BLOCK_LABELS[b]).join("، ")}. ينحطّوا في آخر عمود بروحهم.</small>}
      <div className="row">
        <span className="spacer" />
        <button onClick={onCancel}>إلغاء</button>
        <button className="primary" disabled={!st.name.trim()} onClick={() => onSave(normalizeStructure({ ...st, name: st.name.trim() }))}>حفظ الهيكل</button>
      </div>
    </div>
  );
}

/** A fresh id for a frame of the shop's own or the platform's. */
export const newFrameId = (prefix: "c" | "p") => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
