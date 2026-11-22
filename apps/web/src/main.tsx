import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { matchLocalShop } from "./localGuard";
import "./styles.css";

// A device opening the app from the shop's main computer (http://192.168.1.10:7400) is not a
// "secure" page to the browser, which then leaves out crypto.randomUUID. The till makes its sale
// IDs with it, so give it the same thing from getRandomValues (available everywhere).
if (typeof crypto !== "undefined" && !crypto.randomUUID) {
  Object.defineProperty(crypto, "randomUUID", {
    value: () => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}

if (import.meta.env.VITE_DEMO !== "1" && import.meta.env.VITE_LOCAL !== "1") registerSW({ immediate: true });
const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
// The local edition first checks that what this browser remembers belongs to the shop on this computer.
if (import.meta.env.VITE_LOCAL === "1") {
  // The first run builds the database, which takes a few seconds: say so meanwhile.
  document.getElementById("root")!.innerHTML = '<div class="center"><div class="card">جاري تشغيل النظام على الجهاز…</div></div>';
  void matchLocalShop().finally(render);
}
else render();
