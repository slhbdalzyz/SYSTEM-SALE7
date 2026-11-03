// A full copy of the shop's data as one file: a header line, then one line per row
// ({"t": table, "r": row}), gzipped when the browser can. The server hands it out a page at a time.
import { api, ApiError } from "../api";
import { isDesktopApp } from "../scale";

interface Manifest { format: string; schema: string | null; tenantId: string; createdAt: string; tables: { name: string; rows: number }[] }

export async function buildBackup(token: string | null, onProgress?: (done: number, total: number) => void): Promise<{ blob: Blob; name: string; rows: number }> {
  const m = await api<Manifest>("/backup", { token });
  const total = m.tables.reduce((a, t) => a + t.rows, 0);
  const parts: string[] = [JSON.stringify({ manifest: m }) + "\n"];
  let done = 0;
  for (const t of m.tables) {
    let after: string | null = null;
    do {
      const qs: string = after ? `?limit=1000&after=${after}` : "?limit=1000";
      const page: { rows: unknown[]; next: string | null } = await api(`/backup/${t.name}${qs}`, { token });
      for (const r of page.rows) parts.push(JSON.stringify({ t: t.name, r }) + "\n");
      done += page.rows.length;
      onProgress?.(done, total);
      after = page.next;
    } while (after);
  }
  const plain = new Blob(parts, { type: "application/x-ndjson" });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  if (typeof CompressionStream === "undefined") return { blob: plain, name: `backup-${stamp}.ndjson`, rows: done };
  const gz = await new Response(plain.stream().pipeThrough(new CompressionStream("gzip"))).blob();
  return { blob: gz, name: `backup-${stamp}.ndjson.gz`, rows: done };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Windows app only: writes the file into Documents\POS-Backups and keeps the last 30. Returns the path. */
export async function saveToDisk(blob: Blob, name: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("save_backup", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-name": name } });
}

const LAST = "pos.backup.last";
const DENIED = "pos.backup.denied";
const read = (k: string) => {
  try {
    return Number(localStorage.getItem(k) ?? 0);
  } catch {
    return 0;
  }
};
const write = (k: string, v: number) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {
    /* storage blocked */
  }
};

export const lastAutoBackup = () => read(LAST) || null;
let running = false;

/**
 * Runs on the till in the Windows app: once a day, if the owner allowed this device, saves
 * a full copy to its disk. A refusal is remembered for a few hours so it does not keep asking.
 */
export async function autoBackupIfDue(token: string | null) {
  if (!isDesktopApp() || !token) return;
  const now = Date.now();
  if (running || now - read(LAST) < 20 * 3600_000 || now - read(DENIED) < 6 * 3600_000) return;
  running = true;
  try {
    const b = await buildBackup(token);
    await saveToDisk(b.blob, b.name);
    write(LAST, now);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) write(DENIED, now);
  } finally {
    running = false;
  }
}
