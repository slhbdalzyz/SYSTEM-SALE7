import { useState } from "react";
import { session, tokenValid } from "./session";
import { Setup } from "./Setup";
import { PinScreen } from "./pos/PinScreen";
import { Cashier } from "./pos/Cashier";
import { Admin } from "./admin/Admin";

export type Screen = "setup" | "pin" | "pos" | "admin";

function initial(): Screen {
  if (session.deviceToken) return tokenValid(session.staffToken) ? "pos" : "pin";
  return tokenValid(session.adminToken) ? "admin" : "setup";
}

export function App() {
  const [screen, setScreen] = useState<Screen>(initial);
  if (screen === "admin") return <Admin go={setScreen} />;
  if (screen === "pin") return <PinScreen go={setScreen} />;
  if (screen === "pos") return <Cashier go={setScreen} />;
  return <Setup go={setScreen} />;
}
