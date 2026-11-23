// The local edition's yearly licence. Without a key the shop has 14 days from its first run; with
// one, it is open until the key's last day, then the usual 7 days of grace, then locked (the till
// keeps selling, the back office stops taking changes, as on the cloud). The state is written into
// the shop's own row (status, paid_until), so the subscription lock everyone already has applies.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { forgetTenant, setLocalDeviceLimit } from "../billing";
import { formatMachineId, LicenseError, readLicense, type LicensePayload } from "../license";

interface Store {
  key: string | null;
  /** The latest time this computer has seen: a clock turned back past it means someone is cheating the date. */
  lastSeen: string | null;
  /** When the first shop was set up on this computer: the trial runs from then, even if the shop is cleared and set up again. */
  trialFrom?: string;
  checkedOnlineAt: string | null;
}

interface Q {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const DAY = 86_400_000;
export const TRIAL_DAYS = 14;
/** Devices (tills, kitchen screens, price checkers) during the trial. */
export const TRIAL_DEVICES = 3;
const BACKDATE_SLACK = DAY;

/** This computer's own ID: Windows' MachineGuid, Linux's machine-id, or one made and kept with the data. */
export function readMachineId(dataDir: string): string {
  let raw = "";
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", windowsHide: true });
      raw = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? "";
    } else if (existsSync("/etc/machine-id")) {
      raw = readFileSync("/etc/machine-id", "utf8");
    }
  } catch {
    /* fall back below */
  }
  if (!raw.trim()) {
    const f = path.join(dataDir, "machine.id");
    if (!existsSync(f)) writeFileSync(f, randomUUID());
    raw = readFileSync(f, "utf8");
  }
  return formatMachineId(raw);
}

export class LocalLicense {
  private file: string;
  store: Store;
  constructor(dataDir: string, readonly machineId: string, readonly publicKeys: string[], private cloudUrl: string | null) {
    this.file = path.join(dataDir, "license.json");
    try {
      this.store = { key: null, lastSeen: null, checkedOnlineAt: null, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      this.store = { key: null, lastSeen: null, checkedOnlineAt: null };
    }
  }
  private save() {
    writeFileSync(this.file, JSON.stringify(this.store, null, 2));
  }

  /** The stored key, if it is genuine and for this computer. */
  current(): LicensePayload | null {
    if (!this.store.key) return null;
    try {
      const p = readLicense(this.store.key, this.publicKeys);
      return p.machine === this.machineId ? p : null;
    } catch {
      return null;
    }
  }

  /** Checks a key the owner pasted; stores it only if it is genuine, for this computer, and not older than the one in use. */
  activate(text: string): LicensePayload {
    if (!this.publicKeys.length) throw new LicenseError("هذه النسخة من البرنامج ما تقدرش تتحقق من المفاتيح. حمّل آخر نسخة من البرنامج");
    const p = readLicense(text, this.publicKeys);
    if (p.machine !== this.machineId) throw new LicenseError(`المفتاح هذا لجهاز ثاني (${p.machine}). رقم هذا الجهاز ${this.machineId}`);
    const cur = this.current();
    if (cur && cur.until > p.until) throw new LicenseError(`عندك مفتاح أحدث، صالح لين ${cur.until}`);
    this.store.key = text.replace(/\s+/g, "");
    this.save();
    return p;
  }

  /** Writes the licence's state into the shop's row. Run on start, every few minutes, and after activating. */
  async apply(db: Q, now = Date.now()) {
    setLocalDeviceLimit(this.current()?.devices ?? TRIAL_DEVICES);
    const t = (await db.query(`SELECT id, created_at FROM tenants ORDER BY created_at LIMIT 1`)).rows[0] as { id: string; created_at: Date } | undefined;
    if (!t) return;
    const seen = this.store.lastSeen ? new Date(this.store.lastSeen).getTime() : 0;
    if (seen && now < seen - BACKDATE_SLACK) {
      await db.query(`UPDATE tenants SET status = 'suspended', status_reason = $2 WHERE id = $1`, [t.id, "تاريخ الجهاز راجع لورا. صلّح التاريخ والوقت في ويندوز"]);
      forgetTenant(t.id);
      return;
    }
    if (now > seen) {
      this.store.lastSeen = new Date(now).toISOString();
      this.save();
    }
    const lic = this.current();
    if (lic) {
      await db.query(`UPDATE tenants SET status = 'active', status_reason = NULL, paid_until = ($2::date + interval '1 day' - interval '1 second') WHERE id = $1`, [t.id, lic.until]);
    } else {
      if (!this.store.trialFrom) {
        this.store.trialFrom = new Date(t.created_at).toISOString();
        this.save();
      }
      await db.query(`UPDATE tenants SET status = 'trial', status_reason = NULL, paid_until = LEAST(created_at, $2::timestamptz) + interval '${TRIAL_DAYS} days' WHERE id = $1`, [t.id, this.store.trialFrom]);
    }
    forgetTenant(t.id);
  }

  /** When online and near the end: fetch a renewal the platform already issued for this computer. */
  async renewOnline(now = Date.now()): Promise<boolean> {
    const cur = this.current();
    if (!cur || !this.cloudUrl) return false;
    if (new Date(`${cur.until}T00:00:00Z`).getTime() - now > 30 * DAY) return false;
    if (this.store.checkedOnlineAt && now - new Date(this.store.checkedOnlineAt).getTime() < 12 * 3600_000) return false;
    this.store.checkedOnlineAt = new Date(now).toISOString();
    this.save();
    try {
      const r = await fetch(`${this.cloudUrl}/licenses/${cur.id}/latest?machine=${encodeURIComponent(this.machineId)}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return false;
      const { key } = (await r.json()) as { key: string };
      const p = readLicense(key, this.publicKeys);
      if (p.machine !== this.machineId || p.until <= cur.until) return false;
      this.store.key = key;
      this.save();
      return true;
    } catch {
      return false; // no internet: try again later
    }
  }
}
