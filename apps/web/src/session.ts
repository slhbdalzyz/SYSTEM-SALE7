// What this browser remembers between visits. Tokens only; all business data lives on the server and in IndexedDB.

export interface DeviceInfo {
  id: string;
  name: string;
  prefix: string;
  storeName: string;
}

const KEYS = { deviceToken: "pos.deviceToken", device: "pos.device", staff: "pos.staffToken", admin: "pos.adminToken", kind: "pos.deviceKind" } as const;

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function set(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the session just won't survive a reload */
  }
}

export const session = {
  get deviceToken() {
    return get(KEYS.deviceToken);
  },
  set deviceToken(v: string | null) {
    set(KEYS.deviceToken, v);
  },
  get device(): DeviceInfo | null {
    const v = get(KEYS.device);
    return v ? (JSON.parse(v) as DeviceInfo) : null;
  },
  set device(v: DeviceInfo | null) {
    set(KEYS.device, v ? JSON.stringify(v) : null);
  },
  /** "price_checker" turns this browser into a shelf price checker instead of a till. */
  get deviceKind(): "pos" | "price_checker" | null {
    return get(KEYS.kind) as "pos" | "price_checker" | null;
  },
  set deviceKind(v: "pos" | "price_checker" | null) {
    set(KEYS.kind, v);
  },
  /** Cashier session on this device (from PIN). */
  get staffToken() {
    return get(KEYS.staff);
  },
  set staffToken(v: string | null) {
    set(KEYS.staff, v);
  },
  /** Owner/manager session for the admin screens (from email + password). */
  get adminToken() {
    return get(KEYS.admin);
  },
  set adminToken(v: string | null) {
    set(KEYS.admin, v);
  },
};

export function tokenClaims(token: string | null): { sub: string; role: string; exp: number; did?: string; sid?: string } | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return null;
  }
}

export function tokenValid(token: string | null): boolean {
  const c = tokenClaims(token);
  return !!c && c.exp * 1000 > Date.now();
}
