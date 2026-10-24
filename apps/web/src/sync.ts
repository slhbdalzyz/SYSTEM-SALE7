import type { CatalogProduct } from "@pos/shared";
import { api, ApiError } from "./api";
import { db, getMeta, setMeta, storeCatalog } from "./localdb";
import { session } from "./session";

export interface SyncState {
  online: boolean;
  pending: number;
  failed: number;
  lastSync: string | null;
  error: string | null;
}

let state: SyncState = { online: navigator.onLine, pending: 0, failed: 0, lastSync: null, error: null };
const listeners = new Set<(s: SyncState) => void>();

function update(p: Partial<SyncState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l(state));
}

export function onSync(fn: (s: SyncState) => void) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export async function refreshCounts() {
  const all = await db.outbox.toArray();
  update({ pending: all.length, failed: all.filter((o) => o.error).length });
}

/** Pulls catalog changes. A small overlap avoids missing edits committed while the last sync ran. */
export async function syncCatalog(token: string) {
  const last = await getMeta<string>("catalogSince");
  const since = last ? new Date(new Date(last).getTime() - 60_000).toISOString() : undefined;
  const r = await api<{ serverTime: string; products: CatalogProduct[]; full: boolean }>(
    `/sync/catalog${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    { token },
  );
  await storeCatalog(r.products, r.full);
  await setMeta("catalogSince", r.serverTime);
}

/**
 * Sends queued work in the order it happened. A rejected sale stays in the queue with its error
 * so a manager can see it; it does not block the sales behind it.
 */
export async function flushOutbox(token: string) {
  const items = await db.outbox.orderBy("seq").toArray();
  const sales = items.filter((i) => i.kind === "sale");
  for (const item of items.filter((i) => i.kind === "shift_open")) {
    try {
      await api("/shifts/open", { token, body: item.payload });
      await db.outbox.delete(item.seq!);
    } catch (e) {
      if (e instanceof ApiError && e.status > 0) await db.outbox.update(item.seq!, { error: e.message });
      else throw e;
    }
  }
  for (let i = 0; i < sales.length; i += 50) {
    const chunk = sales.slice(i, i + 50);
    const r = await api<{ results: { id: string; status: string; error?: string }[] }>("/sales/batch", {
      token,
      body: { sales: chunk.map((c) => c.payload) },
    });
    for (const res of r.results) {
      const item = chunk.find((c) => c.refId === res.id);
      if (!item) continue;
      if (res.status === "rejected") await db.outbox.update(item.seq!, { error: res.error });
      else await db.outbox.delete(item.seq!);
    }
  }
  for (const item of items.filter((i) => i.kind === "shift_close")) {
    const { shiftId, closingCashMinor } = item.payload as { shiftId: string; closingCashMinor: number };
    try {
      await api(`/shifts/${shiftId}/close`, { token, body: { closingCashMinor } });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e; // 409: already closed
    }
    await db.outbox.delete(item.seq!);
  }
}

export async function syncNow() {
  const token = session.staffToken;
  if (!token) return;
  try {
    await flushOutbox(token);
    await syncCatalog(token);
    update({ online: true, lastSync: new Date().toISOString(), error: null });
  } catch (e) {
    const offline = e instanceof ApiError && e.status === 0;
    update({ online: !offline, error: offline ? null : (e as Error).message });
  } finally {
    await refreshCounts();
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSyncLoop() {
  if (timer) return;
  void syncNow();
  timer = setInterval(syncNow, 20_000);
  window.addEventListener("online", () => void syncNow());
  window.addEventListener("offline", () => update({ online: false }));
}
