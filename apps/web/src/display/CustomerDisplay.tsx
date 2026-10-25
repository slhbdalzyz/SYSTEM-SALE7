import { useEffect, useState } from "react";
import { displayReceiver, type DisplayState } from "./channel";

/** Opened on a second screen facing the customer: what is being rung up, and the total. */
export function CustomerDisplay() {
  const [s, setS] = useState<DisplayState>({ kind: "idle", storeName: "" });
  useEffect(() => displayReceiver(setS), []);
  return (
    <div className="cdisplay">
      <header>{s.storeName || "أهلاً وسهلاً"}</header>
      {s.kind === "idle" && <div className="cdisplay-center">أهلاً وسهلاً 👋</div>}
      {s.kind === "paid" && (
        <div className="cdisplay-center">
          <div>شكراً لزيارتكم</div>
          <div className="num cdisplay-total">{s.total}</div>
          {s.change && <div>الباقي <span className="num">{s.change}</span></div>}
        </div>
      )}
      {s.kind === "cart" && (
        <>
          <div className="cdisplay-lines">
            {s.lines.map((l, i) => (
              <div key={i} className={i === s.lines.length - 1 ? "last" : ""}>
                <span>{l.name}</span>
                <span className="num">{l.qty}</span>
                <b className="num">{l.amount}</b>
              </div>
            ))}
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
