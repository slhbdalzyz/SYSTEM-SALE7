import { useEffect, useState } from "react";
import { displayAdsSchema, type DisplayAds } from "@pos/shared";
import type { Call } from "./Admin";
import { newFrameId } from "./FrameEditor";

type Slide = DisplayAds["slides"][number];
const COLORS = ["#0f766e", "#1d4ed8", "#15803d", "#6d28d9", "#b45309", "#be123c", "#0f172a"];

/** Shrinks a picture on this computer so the tills and the customer screen get it quickly. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("الصورة هذي ما تنفتحش"));
      i.src = url;
    });
    const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const d = c.toDataURL("image/jpeg", q);
      if (d.length < 380_000) return d;
    }
    throw new Error("الصورة كبيرة، جرّب وحدة أصغر");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** «📺 شاشة الزبون»: the shop's offers and pictures on the screen facing the customer. */
export function DisplayAdsCard({ call }: { call: Call }) {
  const [a, setA] = useState<DisplayAds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<DisplayAds>("/settings/display-ads").then(setA).catch((e) => setError((e as Error).message));
  }, [call]);

  if (!a) return error ? <div className="error">{error}</div> : null;
  const edit = (id: string, p: Partial<Slide>) => { setSaved(false); setA({ ...a, slides: a.slides.map((x) => (x.id === id ? { ...x, ...p } : x)) }); };

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const body = displayAdsSchema.parse(a);
      setA(await call<DisplayAds>("/settings/display-ads", { method: "PUT", body }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <b>📺 شاشة الزبون</b>
      <small className="muted">صور وعروض تبان للزبون على الشاشة الثانية بين الفواتير. افتح الشاشة من زر «شاشة الزبون» في الكاشير.</small>
      {a.slides.map((sl, i) => (
        <div key={sl.id} className="card stack" style={{ padding: 10, borderInlineStart: `6px solid ${sl.bg}` }}>
          <div className="row" style={{ gap: 6 }}>
            <b style={{ flex: 1 }}>الشريحة {i + 1}</b>
            <button className="ghost small" disabled={i === 0} onClick={() => { const l = [...a.slides]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; setA({ ...a, slides: l }); }} aria-label="فوق">▲</button>
            <button className="ghost small" disabled={i === a.slides.length - 1} onClick={() => { const l = [...a.slides]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; setA({ ...a, slides: l }); }} aria-label="تحت">▼</button>
            <button className="ghost small danger" onClick={() => setA({ ...a, slides: a.slides.filter((x) => x.id !== sl.id) })} aria-label="شيل">🗑</button>
          </div>
          <label>العنوان<input value={sl.title} maxLength={80} onChange={(e) => edit(sl.id, { title: e.target.value })} placeholder="مثلاً: عرض الأسبوع" /></label>
          <label>النص<input value={sl.text} maxLength={200} onChange={(e) => edit(sl.id, { text: e.target.value })} placeholder="مثلاً: الأرز 5 كيلو بـ 25 د.ل بس" /></label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span>اللون</span>
            {COLORS.map((c) => (
              <button key={c} className="ghost small" onClick={() => edit(sl.id, { bg: c })} aria-label={c}
                style={{ width: 28, height: 28, padding: 0, borderRadius: "50%", background: c, outline: sl.bg === c ? "3px solid var(--brand)" : "none" }} />
            ))}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {sl.image && <img src={sl.image} alt="" style={{ height: 64, borderRadius: 8 }} />}
            <label className="btn">🖼 {sl.image ? "بدّل الصورة" : "حط صورة"}
              <input type="file" accept="image/*" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try { edit(sl.id, { image: await shrink(f) }); } catch (err) { setError((err as Error).message); }
              }} />
            </label>
            {sl.image && <button className="ghost small" onClick={() => edit(sl.id, { image: null })}>شيل الصورة</button>}
          </div>
        </div>
      ))}
      {a.slides.length < 8 && (
        <button onClick={() => setA({ ...a, slides: [...a.slides, { id: newFrameId("c"), title: "", text: "", image: null, bg: COLORS[a.slides.length % COLORS.length] }] })}>+ شريحة</button>
      )}
      <label className="row" style={{ gap: 8 }}>كل شريحة تبان
        <input className="num" type="number" min={3} max={60} value={a.seconds} style={{ width: 80 }} onChange={(e) => setA({ ...a, seconds: Math.max(3, Math.min(60, Number(e.target.value) || 8)) })} /> ثانية
      </label>
      <label className="check"><input type="checkbox" checked={a.duringSale} onChange={(e) => setA({ ...a, duringSale: e.target.checked })} /> تبان كمان على جنب الفاتورة وقت البيع</label>
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? "…" : "حفظ"}</button>
        {saved && <span className="badge ok">تم الحفظ ✓ (توصل للكاشير لما يفتح من جديد)</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
