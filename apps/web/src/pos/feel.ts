import type { TillTheme } from "@pos/shared";
import { tokenClaims, session } from "../session";

/**
 * How the till looks and sounds for the cashier signed in: text size, a dark screen for long
 * evening shifts, and the scan beep. Kept on this device, per cashier.
 */
export interface TillPrefs { size: "md" | "lg" | "xl"; dark: boolean; sound: boolean; quickSize: "sm" | "md" | "lg"; quickPlace: "top" | "bottom"; kitchenSlip: boolean; /** Colours of their own; "" = the shop's. */ theme: TillTheme | "" }
export const DEFAULT_PREFS: TillPrefs = { size: "md", dark: false, sound: true, quickSize: "md", quickPlace: "top", kitchenSlip: true, theme: "" };

const key = () => `pos.prefs.${tokenClaims(session.staffToken)?.sub ?? "anon"}`;

export function loadPrefs(): TillPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(key()) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: TillPrefs) {
  try {
    localStorage.setItem(key(), JSON.stringify(p));
  } catch {
    /* private window: the choice lasts until the page closes */
  }
}

/**
 * Puts the look on the whole page (dialogs included): the shop's colours, spacing and type, and
 * over them the cashier's own colours, night screen and text size. Returns the undo.
 */
export function applyPrefs(p: TillPrefs, shop: { name: TillTheme; density: string; font: string } = { name: "light", density: "comfortable", font: "system" }) {
  const html = document.documentElement;
  const theme = p.theme || shop.name;
  const added = [
    theme === "dark" || p.dark ? "till-dark" : "",
    theme !== "dark" && !p.dark ? `till-theme-${theme}` : "",
    p.size !== "md" ? `till-${p.size}` : "",
    shop.density === "compact" ? "till-compact" : "",
    shop.font !== "system" ? `till-font-${shop.font}` : "",
  ].filter(Boolean);
  html.classList.add(...added);
  return () => html.classList.remove(...added);
}

let ctx: AudioContext | null = null;

/** A short beep for an item in the cart, a low buzz for a code the till doesn't know. */
export function sound(kind: "ok" | "bad" | "cash", on = true) {
  if (!on) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const tones: [number, number, OscillatorType][] =
      kind === "ok" ? [[1550, 0.07, "sine"]] : kind === "cash" ? [[880, 0.08, "sine"], [1320, 0.12, "sine"]] : [[180, 0.18, "square"], [140, 0.22, "square"]];
    let t = ctx.currentTime;
    for (const [freq, len, type] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(kind === "bad" ? 0.12 : 0.18, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + len);
      t += len + 0.02;
    }
  } catch {
    /* no sound card or blocked: the screen still shows it */
  }
}
