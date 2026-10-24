import { useState } from "react";
import { DEMO } from "../api";

/** A strip on every screen of the demo with the logins to try, and a way to start over. */
export function DemoBar() {
  const [open, setOpen] = useState(true);
  if (!DEMO) return null;
  async function reset() {
    if (!confirm("نمسحوا كل البيانات ونرجعوا المحل التجريبي من الأول؟")) return;
    const { resetDemo } = await import("./server");
    await resetDemo();
    try {
      localStorage.clear();
      indexedDB.deleteDatabase("pos");
    } catch {
      /* ignore */
    }
    location.reload();
  }
  return (
    <div className="demo-bar">
      <b>نسخة تجريبية</b>
      {open && (
        <span>
          الكاشير: <b>أحمد</b> رقمه <b className="num">1234</b> · المالك رقمه <b className="num">9999</b> · الإدارة:{" "}
          <b className="num">owner@demo.ly</b> / <b className="num">demo12345</b> · باركودات للتجربة: <b className="num">6191234500042</b> (كرتونة بيبسي)،{" "}
          <b className="num">2000101012504</b> (ميزان: طماطم 1.250 كغ)
        </span>
      )}
      <span className="spacer" />
      <button onClick={() => setOpen(!open)}>{open ? "إخفاء" : "عرض"}</button>
      <button onClick={reset}>بيانات جديدة</button>
    </div>
  );
}
