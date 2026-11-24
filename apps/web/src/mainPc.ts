// A second till in the Windows app: it uses the shop's main computer over the network instead of
// a database of its own (see apps/desktop/src-tauri/src/client.rs). The main computer is found by
// asking on the network, and found again if the router gives it a new address.
import { onLostMain, setMainServer } from "./api";
import { invoke, isDesktopApp } from "./hardware/printer";

export interface MainPc {
  url: string;
  shopId: string;
  shopName: string;
}

let current: MainPc | null = null;
export const mainPc = () => current;

/** Before the first screen: when this computer is a second till, its API is on the main computer. */
export async function startClientMode(): Promise<MainPc | null> {
  if (!isDesktopApp()) return null;
  const m = await invoke<MainPc | null>("client_mode", {}).catch(() => null);
  if (!m) return null;
  current = m;
  setMainServer(m.url);
  onLostMain(() => void findAgain());
  return m;
}

/** The main computers on the shop's network (those with «شبكة المحل» on). */
export function findMainPcs(waitMs = 1500): Promise<MainPc[]> {
  return invoke<MainPc[]>("find_main_pcs", { waitMs });
}

let lastSearch = 0;
/** The main computer stopped answering: look for the same shop at another address (at most every 30 s). */
export async function findAgain(force = false): Promise<boolean> {
  if (!current || (!force && Date.now() - lastSearch < 30_000)) return false;
  lastSearch = Date.now();
  const same = (await findMainPcs(2000).catch(() => [])).find((f) => f.shopId === current!.shopId);
  if (!same) return false;
  if (same.url !== current.url) {
    current = same;
    setMainServer(same.url);
    await invoke("set_client_mode", { main: same }).catch(() => undefined);
  }
  return true;
}

/** "192.168.1.10" → "http://192.168.1.10:7400". */
export function mainUrl(typed: string): string {
  let t = typed.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(t)) t = `http://${t}`;
  if (!/:\d+$/.test(t.replace(/^https?:\/\//i, ""))) t = `${t}:7400`;
  return t;
}

/** Checks that a main computer answers at `url` and has a shop set up. */
export async function checkMain(url: string): Promise<MainPc> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`${url}/api/local/status`, { signal: ctl.signal });
    const s = (await r.json()) as { edition?: string; shop: { id: string; name: string } | null };
    if (s.edition !== "local") throw new Error("هذا مش جهاز رئيسي لبرنامج المحل");
    if (!s.shop) throw new Error("الجهاز الرئيسي ما عليهش محل لين توا. كمّل إعداد المحل عليه أول.");
    return { url, shopId: s.shop.id, shopName: s.shop.name };
  } catch (e) {
    if (e instanceof Error && !/abort|fetch|network|JSON/i.test(e.message)) throw e;
    throw new Error("ما ردّش. تأكد إن «شبكة المحل» شغالة على الجهاز الرئيسي، وإن الجهازين على نفس الشبكة.");
  } finally {
    clearTimeout(timer);
  }
}

/** Makes this computer a second till of `m`; the app reloads onto the main computer's sign-in. */
export async function becomeSecondTill(m: MainPc) {
  await invoke("set_client_mode", { main: m });
  location.reload();
}

/** Back to a computer with its own database: the app restarts. */
export async function leaveClientMode() {
  await invoke("set_client_mode", { main: null });
}
