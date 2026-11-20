import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "@pos/shared";
import type { Call } from "./Admin";

type Row = LibraryItem & { have: boolean };

/**
 * «📚 مكتبة الأصناف»: the items shops of this kind usually sell, by department. The owner ticks what the
 * shop sells and adds them in one go; items the shop already has are shown as such.
 */
export function LibraryPicker({ call, action, busy, onPick }: { call: Call; action: string; busy?: boolean; onPick: (items: LibraryItem[]) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => void call<Row[]>("/library/items").then(setRows).catch((e) => setError((e as Error).message)), [call]);
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows ?? []) if (!q.trim() || r.name.includes(q.trim())) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return [...m];
  }, [rows, q]);
  if (error) return <div className="error">{error}</div>;
  if (!rows) return <div className="muted">جاري التحميل…</div>;
  const toggle = (names: string[], on: boolean) => setPicked((p) => { const n = new Set(p); for (const x of names) (on ? n.add(x) : n.delete(x)); return n; });
  const chosen = rows.filter((r) => picked.has(r.name));
  return (
    <div className="stack">
      <div className="row wrap">
        <input placeholder="🔎 دوّر في المكتبة" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <span className="muted">{rows.length} صنف · اخترت {chosen.length}</span>
      </div>
      <div className="library">
        {groups.map(([cat, items]) => {
          const free = items.filter((i) => !i.have).map((i) => i.name);
          const all = free.length > 0 && free.every((n) => picked.has(n));
          const shown = open === cat || !!q.trim();
          const count = items.filter((i) => picked.has(i.name)).length;
          return (
            <div key={cat} className="library-group">
              <div className="row">
                <button className="ghost library-head" onClick={() => setOpen(shown && !q.trim() ? null : cat)} aria-expanded={shown}>
                  {shown ? "▾" : "◂"} <b>{cat}</b> <span className="muted">{items.length}{count ? ` · ✓ ${count}` : ""}</span>
                </button>
                <span className="spacer" />
                {free.length > 0 && <label className="row muted"><input type="checkbox" style={{ width: "auto" }} checked={all} onChange={(e) => toggle(free, e.target.checked)} /> الكل</label>}
              </div>
              {shown && (
                <div className="library-items">
                  {items.map((i) => (
                    <label key={i.name} className={`library-item ${i.have ? "have" : ""}`}>
                      <input type="checkbox" style={{ width: "auto" }} disabled={i.have} checked={i.have || picked.has(i.name)} onChange={(e) => toggle([i.name], e.target.checked)} />
                      <span>{i.name}<small className="muted"> · {i.weighted ? "⚖️ بالكيلو" : i.unit}{i.packUnit ? ` · ${i.packUnit} ${i.packQty}` : ""}{i.have ? " · عندك" : ""}</small></span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && <div className="muted">ما لقيناش «{q}» في المكتبة. تقدر تضيفه بيدك.</div>}
      </div>
      <div className="row">
        <small className="muted">الأسعار والباركودات تحطها انت: الباركود لما تمسح الصنف أول مرة، والسعر في فاتورة التوريد أو في الجدول.</small>
        <span className="spacer" />
        <button className="primary" disabled={busy || !chosen.length} onClick={() => { onPick(chosen); setPicked(new Set()); }}>{action.replace("{n}", String(chosen.length))}</button>
      </div>
    </div>
  );
}
