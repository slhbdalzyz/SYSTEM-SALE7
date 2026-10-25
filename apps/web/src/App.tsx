import { useState } from "react";
import { session, tokenValid } from "./session";
import { Setup } from "./Setup";
import { PinScreen } from "./pos/PinScreen";
import { Cashier } from "./pos/Cashier";
import { Admin } from "./admin/Admin";
import { DemoBar } from "./demo/DemoBar";
import { DEMO } from "./api";
import { CustomerDisplay } from "./display/CustomerDisplay";
import { PriceChecker } from "./pricecheck/PriceChecker";
import { Platform } from "./platform/Platform";

export type Screen = "setup" | "pin" | "pos" | "admin" | "price";

// The demo shop has a ready-made cashier device, so the demo opens on the PIN screen.
if (DEMO && !session.deviceToken) session.deviceToken = "d".repeat(64);

function initial(): Screen {
  if (session.deviceToken && session.deviceKind === "price_checker") return "price";
  if (session.deviceToken) return tokenValid(session.staffToken) ? "pos" : "pin";
  return tokenValid(session.adminToken) ? "admin" : "setup";
}

export function App() {
  // The customer display is a second window of the till, with no session of its own.
  const q = new URLSearchParams(location.search);
  if (q.get("screen") === "display") return <CustomerDisplay />;
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
    screen === "price" ? <PriceChecker go={setScreen} /> : screen === "admin" ? <Admin go={setScreen} /> : screen === "pin" ? <PinScreen go={setScreen} /> : screen === "pos" ? <Cashier go={setScreen} /> : <Setup go={setScreen} />;
  return (
    <>
      <DemoBar />
      {page}
    </>
  );
}
