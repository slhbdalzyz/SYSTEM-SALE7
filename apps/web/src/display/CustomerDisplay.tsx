import { useEffect, useState } from "react";
import { displayReceiver, type DisplayAdsMsg, type DisplayState } from "./channel";

/** Opened on a second screen facing the customer: what is being rung up, the total, and the shop's slides between sales. */
export function CustomerDisplay() {
  const [s, setS] = useState<DisplayState>({ kind: "idle", storeName: "" });
  const [ads, setAds] = useState<DisplayAdsMsg | null>(null);
  const [slide, setSlide] = useState(0);
  // The thanks stays a little, then the slides come back.
  const [thanked, setThanked] = useState(false);
  useEffect(() => displayReceiver((x) => { setS(x); setThanked(false); }, setAds), []);
  useEffect(() => {
    if (s.kind !== "paid") return;
    const t = setTimeout(() => setThanked(true), 10_000);
    return () => clearTimeout(t);
  }, [s]);
  const slides = ads?.slides ?? [];
  useEffect(() => {
    if (slides.length < 2) return;
    const t = setInterval(() => setSlide((i) => (i + 1) % slides.length), (ads?.seconds ?? 8) * 1000);
    return () => clearInterval(t);
  }, [slides.length, ads?.seconds]);
  const ad = slides.length ? slides[slide % slides.length] : null;
  const adView = ad && (
    <div key={ad.id + slide} className="cdisplay-ad fade" style={{ background: ad.bg }}>
      <div>
        {ad.image && <img src={ad.image} alt="" />}
        {ad.title && <h2>{ad.title}</h2>}
        {ad.text && <p>{ad.text}</p>}
      </div>
    </div>
  );
  const idle = s.kind === "idle" || (s.kind === "paid" && thanked);

  return (
    <div className="cdisplay">
      <header>{s.storeName || "أهلاً وسهلاً"}</header>
      {idle && (adView ?? <div className="cdisplay-center">أهلاً وسهلاً 👋</div>)}
      {s.kind === "paid" && !thanked && (
        <div className="cdisplay-center">
          <div>شكراً لزيارتكم</div>
          <div className="num cdisplay-total">{s.total}</div>
          {s.change && <div>الباقي <span className="num">{s.change}</span></div>}
        </div>
      )}
      {s.kind === "cart" && (
        <>
          <div className={`cdisplay-body${ads?.duringSale && adView ? " cdisplay-split" : ""}`}>
            <div className="cdisplay-lines">
              {s.lines.map((l, i) => (
                <div key={i} className={i === s.lines.length - 1 ? "last" : ""}>
                  <span>{l.name}</span>
                  <span className="num">{l.qty}</span>
                  <b className="num">{l.amount}</b>
                </div>
              ))}
            </div>
            {ads?.duringSale && adView}
          </div>
          <footer>
            {s.customer && <span>👤 {s.customer}</span>}
            {s.discount && <span>خصم <span className="num">{s.discount}</span></span>}
            <span className="spacer" />
            <span>الإجمالي</span>
            <b className="num cdisplay-total">{s.total}</b>
          </footer>
        </>
      )}
    </div>
  );
}
