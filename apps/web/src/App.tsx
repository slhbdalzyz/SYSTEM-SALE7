import { lazy, Suspense, useState } from "react";
import { endSupport, session, startSupport, supportMode, tokenValid } from "./session";
import { Setup } from "./Setup";
import { PinScreen } from "./pos/PinScreen";
import { Cashier } from "./pos/Cashier";
import { Admin } from "./admin/Admin";
import { DEMO } from "./api";

// Loaded only in the demo build, so the real one carries none of the demo's code.
const DemoBarLazy = import.meta.env.VITE_DEMO === "1" ? lazy(() => import("./demo/DemoBar").then((m) => ({ default: m.DemoBar }))) : null;
const DemoBar = () => (DemoBarLazy ? <Suspense fallback={null}><DemoBarLazy /></Suspense> : null);
import { CustomerDisplay } from "./display/CustomerDisplay";
import { PriceChecker } from "./pricecheck/PriceChecker";
import { Platform } from "./platform/Platform";
import { Owner, prefersOwnerView } from "./owner/Owner";
import { PublicReceipt } from "./public/PublicReceipt";

export type Screen = "setup" | "pin" | "pos" | "admin" | "price" | "owner";

// Opened from the platform's support desk: this tab looks at the shop, read only.
{
  const q = new URLSearchParams(location.search);
  const t = q.get("support");
  if (t) {
    startSupport(t);
    q.delete("support");
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
  }
}

// The demo shop has a ready-made cashier device, so the demo opens on the PIN screen.
if (DEMO && !session.deviceToken) session.deviceToken = "d".repeat(64);

function initial(): Screen {
  if (supportMode()) return "admin";
  // ?welcome shows the landing page even on a till (the demo's way to see it).
  if (new URLSearchParams(location.search).has("welcome")) return "setup";
  // Coming back from the card payment page: straight to the owner's subscription screen.
  if (new URLSearchParams(location.search).has("payment") && tokenValid(session.adminToken)) return "admin";
  // A notification tapped on the phone opens the owner's view, even on a till.
  if (new URLSearchParams(location.search).get("view") === "owner" && tokenValid(session.adminToken)) return "owner";
  if (session.deviceToken && session.deviceKind === "price_checker") return "price";
  if (session.deviceToken) return tokenValid(session.staffToken) ? "pos" : "pin";
  if (!tokenValid(session.adminToken)) return "setup";
  return prefersOwnerView() ? "owner" : "admin";
}

export function App() {
  // The customer display is a second window of the till, with no session of its own.
  const q = new URLSearchParams(location.search);
  if (q.get("screen") === "display") return <CustomerDisplay />;
  // A customer opening the invoice link from WhatsApp: no sign-in, just the receipt.
  const receiptId = q.get("r");
  if (receiptId && /^[0-9a-f-]{36}$/i.test(receiptId)) return <PublicReceipt id={receiptId} />;
  if (q.get("app") === "platform")
    return (
      <>
        <DemoBar />
        <Platform />
      </>
    );
  return <Main />;
}

function Main() {
  const [screen, setScreen] = useState<Screen>(initial);
  const page =
    screen === "price" ? <PriceChecker go={setScreen} /> : screen === "owner" ? <Owner go={setScreen} /> : screen === "admin" ? <Admin go={setScreen} /> : screen === "pin" ? <PinScreen go={setScreen} /> : screen === "pos" ? <Cashier go={setScreen} /> : <Setup go={setScreen} />;
  return (
    <>
      {supportMode() ? <SupportBanner /> : <DemoBar />}
      {page}
    </>
  );
}

function SupportBanner() {
  const valid = tokenValid(session.adminToken);
  return (
    <div className="support-banner">
      {valid ? "👁 وضع الدعم الفني: تشوف حساب المحل بإذن صاحبه، قراءة بس. أي تعديل مقفول." : "انتهت مدة دخول الدعم."}{" "}
      <button onClick={() => { endSupport(); window.close(); location.href = `${location.pathname}?app=platform`; }}>إنهاء</button>
    </div>
  );
}
