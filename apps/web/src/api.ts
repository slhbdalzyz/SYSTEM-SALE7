export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The local edition's web app is also opened from the shop's main computer by other devices
// (http://192.168.1.10:7400): there the API is on the same address, not on 127.0.0.1.
const servedByShopComputer = import.meta.env.VITE_LOCAL === "1" && typeof location !== "undefined" && location.port === "7400";
let BASE = servedByShopComputer ? "/api" : (import.meta.env.VITE_API_URL ?? "/api");

/**
 * A second till in the Windows app (see client.rs): the API is on the shop's main computer,
 * e.g. http://192.168.1.10:7400. Set before the first screen, and again when the main computer
 * is found at a new address.
 */
let mainServer: string | null = null;
export function setMainServer(url: string) {
  mainServer = url.replace(/\/+$/, "");
  BASE = `${mainServer}/api`;
}
export const onMainServer = () => mainServer;
/** Called when the main computer can't be reached (it may have a new address). */
let lostMain: (() => void) | null = null;
export function onLostMain(f: () => void) {
  lostMain = f;
}

export const DEMO = import.meta.env.VITE_DEMO === "1";
/** The Windows app's local edition: the API runs on this computer, with the shop's data on its disk. */
export const LOCAL = import.meta.env.VITE_LOCAL === "1";

// The app starts its local server as it opens; the first request waits for it (the first run also
// builds the database, which takes a few seconds).
let localReady: Promise<void> | null = null;
function waitForLocalServer() {
  localReady ??= (async () => {
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    localReady = null; // try again on the next request
  })();
  return localReady;
}

/** status 0 means the server could not be reached (offline). */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  // Spelled out (not DEMO) so the real build drops the demo, and its 16 MB database, entirely.
  if (import.meta.env.VITE_DEMO === "1") {
    const { handle } = await import("./demo/server");
    const r = await handle(opts.method ?? (opts.body === undefined ? "GET" : "POST"), path, opts.token, opts.body);
    if (r.status >= 400) throw new ApiError(r.status, (r.data as { error?: string }).error ?? `خطأ ${r.status}`);
    return r.data as T;
  }
  // A second till does not wait for a server of its own: it sells offline when the main computer is away.
  if (LOCAL && !mainServer) await waitForLocalServer();
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    if (mainServer) lostMain?.();
    throw new ApiError(0, mainServer ? "الجهاز الرئيسي مش واصل" : "لا يوجد اتصال بالسيرفر");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `خطأ ${res.status}`);
  return data as T;
}

/** Sends a file as it is (a backup to restore), with extra headers. */
export async function apiUpload<T = unknown>(path: string, file: Blob, headers: Record<string, string> = {}, token?: string | null): Promise<T> {
  // A second till does not wait for a server of its own: it sells offline when the main computer is away.
  if (LOCAL && !mainServer) await waitForLocalServer();
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: file });
  } catch {
    if (mainServer) lostMain?.();
    throw new ApiError(0, mainServer ? "الجهاز الرئيسي مش واصل" : "لا يوجد اتصال بالسيرفر");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `خطأ ${res.status}`);
  return data as T;
}
