import { useEffect, useState } from "react";
import { DEFAULT_LOYALTY, formatMoney, fromMinor, toMinor, type LoyaltySettings } from "@pos/shared";
import type { Call } from "./Admin";

/**
 * The shop's points rules, in the settings. Off until the owner switches them on; while off the
 * till and the customers page show no points at all. Everyone else sees the rules, read only.
 */
export function LoyaltyCard({ call, isOwner }: { call: Call; isOwner: boolean }) {
  const [s, setS] = useState<LoyaltySettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void call<LoyaltySettings>("/loyalty/settings").then(setS).catch(() => setS(DEFAULT_LOYALTY)), [call]);
  if (!s) return null;
  async function save() {
    setError(null);
    try {
      setS(await call<LoyaltySettings>("/loyalty/settings", { method: "PUT", body: s }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const pct = ((s.pointValueMinor / s.earnMinorPerPoint) * 100).toFixed(1).replace(/\.0$/, "");
  return (
    <div className="card stack" id="loyalty">
      <div className="row">
        <b>⭐ نقاط الولاء</b>
        <span className="spacer" />
        <label className="check"><input type="checkbox" checked={s.enabled} disabled={!isOwner} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> مفعّلة</label>
      </div>
      {!s.enabled && <span className="muted">الزبون يجمع نقاط على مشترياته ويدفع بيها بعدين. فعّلها وحدد قيمتها، والكاشير يبدا يحسبها على الفواتير اللي عليها اسم زبون.</span>}
      {s.enabled && (
        <>
          <div className="form-grid">
            <label>كل كم دينار = نقطة وحدة
              <input className="num" inputMode="decimal" disabled={!isOwner} defaultValue={fromMinor(s.earnMinorPerPoint)} onChange={(e) => setS({ ...s, earnMinorPerPoint: Math.max(toMinor(Number(e.target.value) || 0), 1) })} />
            </label>
            <label>قيمة النقطة لما تنصرف (بالدرهم)
              <input className="num" inputMode="numeric" disabled={!isOwner} defaultValue={s.pointValueMinor} onChange={(e) => setS({ ...s, pointValueMinor: Math.max(Math.round(Number(e.target.value) || 0), 1) })} />
            </label>
            <label>أقل رصيد نقاط يقدر يصرفه
              <input className="num" inputMode="numeric" disabled={!isOwner} defaultValue={s.minRedeemPoints} onChange={(e) => setS({ ...s, minRedeemPoints: Math.max(Math.round(Number(e.target.value) || 0), 0) })} />
            </label>
          </div>
          <div className="points-box">
            يعني الزبون ياخذ نقطة على كل <b className="num">{formatMoney(s.earnMinorPerPoint)}</b>، و<b className="num">{Math.ceil(1000 / s.pointValueMinor)}</b> نقطة تسوى دينار.
            يرجعله تقريباً <b className="num">{pct}%</b> من مشترياته، ويقدر يصرف من <b className="num">{s.minRedeemPoints}</b> نقطة وفوق.
          </div>
          <span className="muted small">اللي يدفعه بالنقاط ما يكسبش عليه نقاط. في المرتجع النقاط ترجع بنفس النسبة. رصيد كل زبون وكشف نقاطه في صفحة العملاء.</span>
        </>
      )}
      {isOwner ? <div className="row"><span className="spacer" /><button className="primary" onClick={save}>{saved ? "تم الحفظ ✓" : "حفظ"}</button></div> : <span className="muted small">صاحب المحل بس يقدر يغيّرها</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
