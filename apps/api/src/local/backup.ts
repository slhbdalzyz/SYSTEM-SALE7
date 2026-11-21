// Backups for the local edition. A backup is a full copy of the shop's database (PGlite's own
// data folder, packed and compressed), so restoring it on a new computer brings back everything,
// logins and PINs included. With a backup password set, the file is encrypted (AES-256-GCM): a
// lost USB stick does not give the shop's data away.
//
// File layout: "S7BK", a version byte (0 plain, 1 encrypted), then for version 1 the salt (16),
// the IV (12) and the auth tag (16), then the packed database.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("S7BK");
export const KEEP = 30;
const KEEP_BEFORE_UPDATE = 3;
const NAME = /^sale7-\d{8}-\d{6}\.s7bak$/;

export interface BackupSettings {
  extraDir: string | null;
  salt: string | null;
  key: string | null;
  lastAt: string | null;
  lastName: string | null;
  lastError: string | null;
  extraError: string | null;
}

export class BackupError extends Error {
  statusCode = 400;
}

const deriveKey = (password: string, salt: Buffer) => scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export function seal(data: Buffer, key: Buffer | null, salt: Buffer | null): Buffer {
  if (!key || !salt) return Buffer.concat([MAGIC, Buffer.from([0]), data]);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, c.getAuthTag(), body]);
}

/** The packed database inside a backup file. `known` is this computer's own key, tried when no password is typed. */
export function open(file: Buffer, password: string | null, known: { salt: Buffer; key: Buffer } | null): Buffer {
  if (file.length < 5 || !file.subarray(0, 4).equals(MAGIC)) throw new BackupError("هذا مش ملف نسخة احتياطية من النظام");
  const v = file[4];
  if (v === 0) return file.subarray(5);
  if (v !== 1) throw new BackupError("نسخة من إصدار أحدث من البرنامج. حدّث البرنامج أولاً");
  const salt = file.subarray(5, 21);
  const iv = file.subarray(21, 33);
  const tag = file.subarray(33, 49);
  let key: Buffer | null = null;
  if (password) key = deriveKey(password, salt);
  else if (known && known.salt.equals(salt)) key = known.key;
  if (!key) throw new BackupError("النسخة مشفرة: اكتب كلمة سر النسخ الاحتياطي");
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(file.subarray(49)), d.final()]);
  } catch {
    throw new BackupError("كلمة سر النسخ غير صحيحة");
  }
}

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Writes next to the older copies under a temporary name first, then keeps the newest `keep`. */
function writeInto(dir: string, name: string, data: Buffer, keep = KEEP) {
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${name}.part`);
  writeFileSync(tmp, data);
  renameSync(tmp, path.join(dir, name));
  const old = readdirSync(dir).filter((n) => NAME.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - keep))) rmSync(path.join(dir, n), { force: true });
}

export interface BackupFile {
  name: string;
  size: number;
  at: string;
  where: "local" | "extra";
}

export class LocalBackups {
  readonly dir: string;
  private file: string;
  settings: BackupSettings;
  running: Promise<string> | null = null;

  constructor(root: string, dataDir: string, private dump: () => Promise<Buffer>) {
    this.dir = path.join(root, "backups");
    this.file = path.join(dataDir, "backup.json");
    const blank: BackupSettings = { extraDir: null, salt: null, key: null, lastAt: null, lastName: null, lastError: null, extraError: null };
    try {
      this.settings = { ...blank, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      this.settings = blank;
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
  }

  get known() {
    const s = this.settings;
    return s.salt && s.key ? { salt: Buffer.from(s.salt, "hex"), key: Buffer.from(s.key, "hex") } : null;
  }

  setPassword(password: string | null) {
    if (password) {
      const salt = randomBytes(16);
      this.settings.salt = salt.toString("hex");
      this.settings.key = deriveKey(password, salt).toString("hex");
    } else {
      this.settings.salt = this.settings.key = null;
    }
    this.save();
  }

  setExtraDir(dir: string | null) {
    const d = dir?.trim() || null;
    if (d) {
      if (!path.isAbsolute(d)) throw new BackupError("اكتب المسار كامل، مثلاً E:\\نسخ المحل");
      try {
        mkdirSync(d, { recursive: true });
        const probe = path.join(d, ".sale7-write-test");
        writeFileSync(probe, "ok");
        rmSync(probe, { force: true });
      } catch {
        throw new BackupError("ما قدرناش نكتبوا في هذا المكان. تأكد إن الفلاشة أو القرص موصول");
      }
    }
    this.settings.extraDir = d;
    this.save();
  }

  /** Makes one backup now (or joins the one already running). Returns the file name. */
  run(): Promise<string> {
    this.running ??= this.make().finally(() => (this.running = null));
    return this.running;
  }

  private async make() {
    const name = `sale7-${stamp()}.s7bak`;
    try {
      const k = this.known;
      const data = seal(await this.dump(), k?.key ?? null, k?.salt ?? null);
      writeInto(this.dir, name, data);
      this.settings.extraError = null;
      if (this.settings.extraDir) {
        try {
          writeInto(this.settings.extraDir, name, data);
        } catch (e) {
          this.settings.extraError = `ما تمش النسخ على ${this.settings.extraDir}: ${(e as Error).message}`;
        }
      }
      Object.assign(this.settings, { lastAt: new Date().toISOString(), lastName: name, lastError: null });
      this.save();
      return name;
    } catch (e) {
      this.settings.lastError = (e as Error).message;
      this.save();
      throw e;
    }
  }

  /** Due when the shop has had no backup for a day. */
  due(now = Date.now()) {
    return !this.settings.lastAt || now - new Date(this.settings.lastAt).getTime() >= 24 * 3600_000;
  }

  list(): BackupFile[] {
    const out: BackupFile[] = [];
    for (const [where, dir] of [["local", this.dir], ["extra", this.settings.extraDir]] as const) {
      if (!dir || !existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((n) => NAME.test(n))) {
        try {
          const st = statSync(path.join(dir, name));
          out.push({ name, size: st.size, at: st.mtime.toISOString(), where });
        } catch {
          /* removed meanwhile */
        }
      }
    }
    return out.sort((a, b) => b.name.localeCompare(a.name) || a.where.localeCompare(b.where));
  }

  read(name: string, where: "local" | "extra") {
    const dir = where === "extra" ? this.settings.extraDir : this.dir;
    if (!NAME.test(name) || !dir) throw new BackupError("اسم الملف غير صحيح");
    const p = path.join(dir, name);
    if (!existsSync(p)) throw new BackupError("الملف مش موجود");
    return readFileSync(p);
  }

  /** What the owner should hear about: no backup for 3 days, or the USB stick was not there. */
  warning(now = Date.now()): string | null {
    const s = this.settings;
    if (s.lastError) return `آخر نسخة احتياطية فشلت: ${s.lastError}`;
    if (!s.lastAt) return null;
    if (now - new Date(s.lastAt).getTime() > 3 * 24 * 3600_000) return "ما فيش نسخة احتياطية من أكثر من 3 أيام";
    if (s.extraDir && (s.extraError || !existsSync(s.extraDir))) return s.extraError ?? `مكان النسخ الثاني (${s.extraDir}) مش موصول`;
    return null;
  }
}

/** A raw copy of the database folder before an update changes its tables, kept three deep. */
export function copyBeforeUpdate(root: string, dbDir: string) {
  const dir = path.join(root, "backups", "before-update");
  mkdirSync(dir, { recursive: true });
  cpSync(dbDir, path.join(dir, stamp()), { recursive: true });
  const old = readdirSync(dir).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_BEFORE_UPDATE))) rmSync(path.join(dir, n), { recursive: true, force: true });
}
