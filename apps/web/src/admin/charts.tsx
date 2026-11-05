import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Small SVG charts for the reports, with no chart library. Categorical colours follow a fixed
 * order (never cycled) and every chart has a hover tooltip; values and labels use text colours.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6"] as const;

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round numbers for the value axis: 0 and 3–4 steps up to just above the max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const short = (minor: number) => {
  const d = minor / 1000;
  if (Math.abs(d) >= 1e6) return `${(d / 1e6).toFixed(1)}م`;
  if (Math.abs(d) >= 1e3) return `${(d / 1e3).toFixed(d >= 1e4 ? 0 : 1)}أ`;
  return String(Math.round(d));
};

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  // Kept inside the chart: flips to the other side of the pointer near the edge.
  const left = x > w * 0.6 ? undefined : x + 12;
  const right = x > w * 0.6 ? w - x + 12 : undefined;
  return <div className="chart-tip" style={{ top: Math.max(0, y - 10), left, right }}>{children}</div>;
}

export interface LinePoint { label: string; values: number[] }

/**
 * One value axis, one or two series over time (sales and profit share the same dinar scale).
 * The first series is an area, the second a line. Hover shows the day's numbers.
 */
export function TimeChart({ data, names, fmt, height = 220 }: { data: LinePoint[]; names: string[]; fmt: (n: number) => string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const max = Math.max(0, ...data.flatMap((d) => d.values));
  const ys = ticks(max);
  const top = ys[ys.length - 1] || 1;
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i * iw) / (data.length - 1));
  const y = (v: number) => pad.t + ih - (Math.max(v, 0) / top) * ih;
  const path = (k: number) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.values[k] ?? 0).toFixed(1)}`).join("");
  const every = Math.max(1, Math.ceil(data.length / Math.floor(iw / 56)));
  return (
    <div className="chart" ref={ref} dir="ltr" onMouseLeave={() => setHover(null)}>
      {names.length > 1 && <Legend names={names} />}
      <svg width={w} height={height} role="img" aria-label={names.join(" و ")}>
        {ys.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{short(v)}</text>
          </g>
        ))}
        {data.map((d, i) => (i % every === 0 || i === data.length - 1) && (
          <text key={d.label} x={x(i)} y={height - 8} textAnchor="middle" className="axis">{d.label}</text>
        ))}
        {data.length > 0 && <path d={`${path(0)}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={SERIES[0]} opacity={0.12} />}
        {names.map((_, k) => <path key={k} d={path(k)} fill="none" stroke={SERIES[k]} strokeWidth={2} strokeLinejoin="round" />)}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="cross" />
            {names.map((_, k) => <circle key={k} cx={x(hover)} cy={y(data[hover].values[k] ?? 0)} r={4.5} fill={SERIES[k]} stroke="var(--panel)" strokeWidth={2} />)}
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent"
          onMouseMove={(e) => {
            const bx = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - bx.left) / bx.width) * (data.length - 1));
            setHover(Math.min(data.length - 1, Math.max(0, i)));
          }} />
      </svg>
      {hover !== null && data[hover] && (
        <Tip x={x(hover)} y={pad.t} w={w}>
          <b>{data[hover].label}</b>
          {names.map((n, k) => <div key={n} className="tip-row"><i style={{ background: SERIES[k] }} />{n}<span className="num">{fmt(data[hover].values[k] ?? 0)}</span></div>)}
        </Tip>
      )}
    </div>
  );
}

/** Vertical bars for one measure over a few buckets (hours, weekdays). */
export function BarChart({ data, fmt, height = 200, name }: { data: { label: string; value: number; sub?: string }[]; fmt: (n: number) => string; height?: number; name: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const ys = ticks(Math.max(0, ...data.map((d) => d.value)));
  const top = ys[ys.length - 1] || 1;
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.max(4, Math.min(36, slot - 2)); // a 2px gap between neighbours at least
  const y = (v: number) => pad.t + ih - (Math.max(v, 0) / top) * ih;
  const every = Math.max(1, Math.ceil(data.length / Math.floor(iw / 34)));
  return (
    <div className="chart" ref={ref} dir="ltr" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={name}>
        {ys.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{short(v)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + slot * i + slot / 2;
          const h = pad.t + ih - y(d.value);
          const r = Math.min(4, bw / 2, h);
          // Rounded at the top only, flat on the baseline.
          const top = y(d.value);
          const p = `M${cx - bw / 2},${pad.t + ih}V${top + r}Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top}H${cx + bw / 2 - r}Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r}V${pad.t + ih}Z`;
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {h > 0 && <path d={p} fill={SERIES[0]} opacity={hover === null || hover === i ? 1 : 0.45} />}
              {(i % every === 0) && <text x={cx} y={height - 8} textAnchor="middle" className="axis">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <Tip x={pad.l + slot * hover + slot / 2} y={y(data[hover].value)} w={w}>
          <b>{data[hover].label}</b>
          <div className="tip-row">{name}<span className="num">{fmt(data[hover].value)}</span></div>
          {data[hover].sub && <div className="muted">{data[hover].sub}</div>}
        </Tip>
      )}
    </div>
  );
}

/** A ranked list with a bar per row: departments, items, suppliers. Reads well right to left. */
export function RankBars({ rows, fmt }: { rows: { key: string; label: ReactNode; value: number; note?: ReactNode }[]; fmt: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="rank">
      {rows.map((r) => (
        <div key={r.key} className="rank-row" title={`${fmt(r.value)}`}>
          <div className="rank-head"><span>{r.label}</span><span className="num">{fmt(r.value)}</span></div>
          <div className="rank-track"><div style={{ width: `${(Math.max(r.value, 0) / max) * 100}%` }} /></div>
          {r.note && <div className="muted rank-note">{r.note}</div>}
        </div>
      ))}
      {rows.length === 0 && <div className="muted">ما فيش بيانات في الفترة هذي</div>}
    </div>
  );
}

/** Parts of a whole, at most five slices (payment methods): legend with values beside it. */
export function Donut({ items, fmt }: { items: { label: string; value: number }[]; fmt: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = items.filter((i) => i.value > 0);
  const total = shown.reduce((a, i) => a + i.value, 0);
  const R = 70;
  const r = 46;
  let a0 = -Math.PI / 2;
  const arcs = shown.map((it, i) => {
    const a1 = a0 + (it.value / total) * Math.PI * 2;
    // A small gap between slices.
    const g = shown.length > 1 ? 0.02 : 0;
    const [s, e] = [a0 + g, Math.max(a0 + g, a1 - g)];
    const big = e - s > Math.PI ? 1 : 0;
    const pt = (rad: number, a: number) => `${80 + rad * Math.cos(a)},${80 + rad * Math.sin(a)}`;
    const d = shown.length === 1
      ? `M80,${80 - R}A${R},${R} 0 1 1 79.99,${80 - R}L79.99,${80 - r}A${r},${r} 0 1 0 80,${80 - r}Z`
      : `M${pt(R, s)}A${R},${R} 0 ${big} 1 ${pt(R, e)}L${pt(r, e)}A${r},${r} 0 ${big} 0 ${pt(r, s)}Z`;
    a0 = a1;
    return <path key={it.label} d={d} fill={SERIES[i]} opacity={hover === null || hover === i ? 1 : 0.4} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />;
  });
  if (!total) return <div className="muted">ما فيش بيانات في الفترة هذي</div>;
  return (
    <div className="donut">
      <svg viewBox="0 0 160 160" width={150} height={150} role="img" aria-label="التوزيع">
        {arcs}
        <text x={80} y={76} textAnchor="middle" className="donut-total">{hover === null ? "الإجمالي" : shown[hover].label}</text>
        <text x={80} y={96} textAnchor="middle" className="donut-value">{fmt(hover === null ? total : shown[hover].value)}</text>
      </svg>
      <div className="legend-list">
        {shown.map((it, i) => (
          <div key={it.label} className="tip-row" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: SERIES[i] }} />{it.label}
            <span className="num">{fmt(it.value)} <span className="muted">{Math.round((it.value / total) * 100)}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ names }: { names: string[] }) {
  return <div className="legend" dir="rtl">{names.map((n, k) => <span key={n}><i style={{ background: SERIES[k] }} />{n}</span>)}</div>;
}

/** A spreadsheet of the rows on screen, as CSV that Excel opens in Arabic. */
export function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
