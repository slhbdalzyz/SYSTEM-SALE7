import type { TillTheme } from "@pos/shared";
import { tokenClaims, session } from "../session";

/**
 * How the till looks and sounds for the cashier signed in: text size, a dark screen for long
 * evening shifts, and the scan beep. Kept on this device, per cashier.
 */
export interface TillPrefs { size: "md" | "lg" | "xl"; dark: boolean; sound: boolean; /** The scan sound: the scanner recording, or the old short beep. */ scanSound: "scanner" | "beep"; quickSize: "sm" | "md" | "lg"; quickPlace: "top" | "bottom"; kitchenSlip: boolean; /** Colours of their own; "" = the shop's. */ theme: TillTheme | "" }
export const DEFAULT_PREFS: TillPrefs = { size: "md", dark: false, sound: true, scanSound: "scanner", quickSize: "md", quickPlace: "top", kitchenSlip: true, theme: "" };

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

import chaChingUrl from "../assets/cha-ching.mp3";
import scannerUrl from "../assets/scanner-beep.mp3";

let ctx: AudioContext | null = null;
const recordings = new Map<string, Promise<AudioBuffer | null>>();

/** A real recording, fetched and decoded once, then kept for every sale or scan after. */
function recording(c: AudioContext, url: string) {
  let p = recordings.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => c.decodeAudioData(b))
      .catch(() => null);
    recordings.set(url, p);
  }
  return p;
}
const loadChaChing = (c: AudioContext) => recording(c, chaChingUrl);

/** Plays a decoded recording; false when it isn't ready, so the caller plays a tone instead. */
function playBuffer(c: AudioContext, buf: AudioBuffer | null, gain: number, rate = 1, offset = 0) {
  if (!buf) return false;
  const src = c.createBufferSource();
  const g = c.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(g).connect(c.destination);
  src.start(0, offset);
  return true;
}

/** Gets the recording ready before the first sale, so it plays the moment the sale is done. */
export function preloadSaleSound() {
  try {
    ctx ??= new AudioContext();
    void loadChaChing(ctx);
    void recording(ctx, scannerUrl);
  } catch {
    /* no sound card */
  }
}

/** The sound of a finished sale. Falls back to the short two-tone chime if the file can't play. */
export function saleSound(on = true) {
  if (!on) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const c = ctx;
    void loadChaChing(c).then((buf) => {
      if (!playBuffer(c, buf, 0.9)) sound("cash");
    });
  } catch {
    /* no sound card or blocked: the screen still shows it */
  }
}

/** Plays short tones one after the other. */
function tones(list: [number, number, OscillatorType][], gain: number) {
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  let t = ctx.currentTime;
  for (const [freq, len, type] of list) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + len);
    t += len + 0.02;
  }
}

/** A short beep for an item in the cart, a low buzz for a code the till doesn't know. */
export function sound(kind: "ok" | "bad" | "cash", on = true) {
  if (!on) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    tones(
      kind === "ok" ? [[1550, 0.07, "sine"]] : kind === "cash" ? [[880, 0.08, "sine"], [1320, 0.12, "sine"]] : [[180, 0.18, "square"], [140, 0.22, "square"]],
      kind === "bad" ? 0.12 : 0.18,
    );
  } catch {
    /* no sound card or blocked: the screen still shows it */
  }
}

/**
 * The sound of an item going into the cart. A new item gets the full scanner beep; the same
 * item scanned again is quieter, so the cashier hears it was counted twice; an item sold by
 * weight is lower. With «beep» chosen, the old short tones do the same.
 */
export function scanSound(kind: "new" | "again" | "weighed", style: TillPrefs["scanSound"] = "scanner", on = true) {
  if (!on) return;
  const gain = kind === "again" ? 0.35 : 0.8;
  const rate = kind === "weighed" ? 0.78 : 1;
  const beep = () => tones([[kind === "weighed" ? 1050 : 1550, 0.07, "sine"]], kind === "again" ? 0.07 : 0.18);
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    if (style === "beep") return beep();
    const c = ctx;
    // The file opens with 50 ms of nothing: skipped, so the beep lands the moment the code is read.
    void recording(c, scannerUrl).then((buf) => {
      if (!playBuffer(c, buf, gain, rate, 0.05)) beep();
    });
  } catch {
    /* no sound card or blocked: the screen still shows it */
  }
}
