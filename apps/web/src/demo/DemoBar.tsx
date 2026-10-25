import { useState } from "react";
import { DEMO } from "../api";
import { session } from "../session";
import { DEMO_CHECKER_TOKEN, DEMO_DEVICE_TOKEN, DEMO_PLATFORM } from "./seed";

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
  const checker = session.deviceKind === "price_checker";
  function switchDevice() {
    session.deviceToken = checker ? DEMO_DEVICE_TOKEN : DEMO_CHECKER_TOKEN;
    session.deviceKind = checker ? "pos" : "price_checker";
    session.staffToken = null;
    location.reload();
  }
  const q = new URLSearchParams(location.search);
  if (q.get("screen") === "display") return null;
  const platform = q.get("app") === "platform";
  return (
    <div className="demo-bar">
      <b>نسخة تجريبية</b>
      {open && platform && (
        <span>
          لوحة المنصة (لصاحب الخدمة): <b className="num">{DEMO_PLATFORM.email}</b> / <b className="num">{DEMO_PLATFORM.password}</b>
        </span>
      )}
      {open && !platform && (
        <span>
          الكاشير: <b>أحمد</b> رقمه <b className="num">1234</b> · المالك رقمه <b className="num">9999</b> · الإدارة:{" "}
          <b className="num">owner@demo.ly</b> / <b className="num">demo12345</b> · باركودات للتجربة: <b className="num">6191234500042</b> (كرتونة بيبسي)،{" "}
          <b className="num">2000101012504</b> (ميزان: طماطم 1.250 كغ)
        </span>
      )}
      <span className="spacer" />
      <a href={platform ? location.pathname : "?app=platform"}><button type="button">{platform ? "شاشة المحل" : "لوحة المنصة"}</button></a>
      {!platform && <button onClick={switchDevice}>{checker ? "رجوع للكاشير" : "جرّب قارئ الأسعار"}</button>}
      <button onClick={() => setOpen(!open)}>{open ? "إخفاء" : "عرض"}</button>
      <button onClick={reset}>بيانات جديدة</button>
    </div>
  );
}
