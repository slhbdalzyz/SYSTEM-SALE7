// The local edition keeps its till data (the device's key, sign-ins, the offline catalogue) in the
// Windows app's browser storage, while the shop itself lives in the database on the disk. The two
// can stop matching: the demo edition installed before on the same computer leaves its demo till
// behind (same app, same storage), and a fresh database (first install, or data folder removed)
// knows none of what the browser remembers. The app then opened on a till nobody can sign in to.
// So before the first screen, the browser's data is checked against the shop on this computer and
// dropped when it belongs to another one (or to none yet).
import Dexie from "dexie";
import { api } from "./api";

const MARK = "pos.localShop";
const RESET = "pos.localReset";

function write(k: string, v: string | null) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Whether anything from an earlier till is kept in this browser. */
function hasTillData(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pos.") && k !== MARK && k !== RESET) return true;
    }
  } catch {
    /* storage blocked: nothing is kept */
  }
  return false;
}

export async function matchLocalShop(): Promise<void> {
  let shopId: string;
  let resetAt = "";
  try {
    const s = await api<{ shop: { id?: string; name: string; resetAt?: string | null } | null }>("/local/status");
    shopId = s.shop ? (s.shop.id ?? s.shop.name) : "";
    resetAt = s.shop?.resetAt ?? "";
  } catch {
    return; // the server did not start: the first screen shows that, with a retry
  }
  const known = read(MARK);
  if (known === shopId) {
    // Same shop, but its records were cleared (on this till or another): this till's copy of
    // them (queued sales, catalogue with old stock) is dropped; its sign-in and device stay.
    if (resetAt && read(RESET) !== resetAt) {
      await Dexie.delete("pos").catch(() => undefined);
      write(RESET, resetAt);
    }
    return;
  }
  // The browser's data belongs to the same shop when it was set up before this check existed.
  if (known === null && shopId && !hasTillData()) {
    remember(shopId, resetAt);
    return;
  }
  if (known === null && shopId) {
    // Till data from before this check: keep it only if this database knows the device.
    const token = read("pos.deviceToken");
    const kind = read("pos.deviceKind");
    if (!token || (kind && kind !== "pos") || (await deviceKnown(token))) {
      remember(shopId, resetAt);
      return;
    }
  }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("pos.")) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch {
    /* storage blocked: nothing to drop */
  }
  await Dexie.delete("pos").catch(() => undefined);
  remember(shopId, resetAt);
}

async function deviceKnown(token: string): Promise<boolean> {
  try {
    await api("/auth/device-users", { body: { deviceToken: token } });
    return true;
  } catch (e) {
    // Only "this database does not know the device" drops it; any other error keeps the data.
    return (e as { status?: number }).status !== 401;
  }
}

function remember(shopId: string, resetAt: string) {
  write(RESET, resetAt || null);
  try {
    if (shopId) localStorage.setItem(MARK, shopId);
    else localStorage.removeItem(MARK);
  } catch {
    /* storage blocked */
  }
}
