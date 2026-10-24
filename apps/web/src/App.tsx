import { useState } from "react";
import { session, tokenValid } from "./session";
import { Setup } from "./Setup";
import { PinScreen } from "./pos/PinScreen";
import { Cashier } from "./pos/Cashier";
import { Admin } from "./admin/Admin";
import { DemoBar } from "./demo/DemoBar";
import { DEMO } from "./api";

export type Screen = "setup" | "pin" | "pos" | "admin";

// The demo shop has a ready-made cashier device, so the demo opens on the PIN screen.
if (DEMO && !session.deviceToken) session.deviceToken = "d".repeat(64);

function initial(): Screen {
  if (session.deviceToken) return tokenValid(session.staffToken) ? "pos" : "pin";
  return tokenValid(session.adminToken) ? "admin" : "setup";
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initial);
  const page =
    screen === "admin" ? <Admin go={setScreen} /> : screen === "pin" ? <PinScreen go={setScreen} /> : screen === "pos" ? <Cashier go={setScreen} /> : <Setup go={setScreen} />;
  return (
    <>
      <DemoBar />
      {page}
    </>
  );
}
