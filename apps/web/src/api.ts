export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BASE = import.meta.env.VITE_API_URL ?? "/api";

export const DEMO = import.meta.env.VITE_DEMO === "1";

/** status 0 means the server could not be reached (offline). */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  // Spelled out (not DEMO) so the real build drops the demo, and its 16 MB database, entirely.
  if (import.meta.env.VITE_DEMO === "1") {
    const { handle } = await import("./demo/server");
    const r = await handle(opts.method ?? (opts.body === undefined ? "GET" : "POST"), path, opts.token, opts.body);
    if (r.status >= 400) throw new ApiError(r.status, (r.data as { error?: string }).error ?? `خطأ ${r.status}`);
    return r.data as T;
  }
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
    throw new ApiError(0, "لا يوجد اتصال بالسيرفر");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `خطأ ${res.status}`);
  return data as T;
}
