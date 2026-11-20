// The local edition's backup files: encryption, the folders they go to, and the owner's warning.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBackups, open, seal } from "../src/local/backup";

const tmp = () => mkdtempSync(path.join(tmpdir(), "pos-bk-"));

describe("backup files", () => {
  const data = Buffer.from("the shop's whole database");

  it("round-trips a plain file", () => {
    expect(open(seal(data, null, null), null, null).equals(data)).toBe(true);
  });

  it("encrypts with the password and refuses a wrong one", () => {
    const root = tmp();
    const b = new LocalBackups(root, root, async () => data);
    b.setPassword("secret-pass");
    const k = b.known!;
    const file = seal(data, k.key, k.salt);
    expect(file.includes(data)).toBe(false);
    expect(open(file, "secret-pass", null).equals(data)).toBe(true);
    // On the same computer the stored key opens it without typing the password.
    expect(open(file, null, k).equals(data)).toBe(true);
    expect(() => open(file, "wrong-pass", null)).toThrow("كلمة سر النسخ غير صحيحة");
    expect(() => open(file, null, null)).toThrow("اكتب كلمة سر");
    rmSync(root, { recursive: true });
  });

  it("refuses a file that is not a backup", () => {
    expect(() => open(Buffer.from("PK zip file"), null, null)).toThrow("مش ملف نسخة");
  });
});

describe("backup folders", () => {
  it("writes to both places, keeps the newest 30, and remembers when", async () => {
    const root = tmp();
    const extra = path.join(root, "usb");
    let n = 0;
    const b = new LocalBackups(root, root, async () => Buffer.from(`copy ${n++}`));
    b.setExtraDir(extra);
    expect(b.due()).toBe(true);
    const name = await b.run();
    expect(existsSync(path.join(root, "backups", name))).toBe(true);
    expect(existsSync(path.join(extra, name))).toBe(true);
    expect(b.due()).toBe(false);
    expect(b.list().map((f) => f.where).sort()).toEqual(["extra", "local"]);
    // Settings survive a restart of the server.
    expect(new LocalBackups(root, root, async () => Buffer.alloc(0)).settings.extraDir).toBe(extra);
    rmSync(root, { recursive: true });
  });

  it("keeps only the newest copies", async () => {
    const root = tmp();
    const b = new LocalBackups(root, root, async () => Buffer.from("x"));
    let t = Date.UTC(2026, 0, 1);
    const RealDate = Date;
    // Names carry the time to the second: step the clock so each copy gets its own name.
    globalThis.Date = class extends RealDate {
      constructor(...a: unknown[]) {
        super(...((a.length ? a : [t]) as [number]));
      }
      static now() {
        return t;
      }
    } as DateConstructor;
    try {
      for (let i = 0; i < 33; i++) {
        await b.run();
        t += 1000;
      }
    } finally {
      globalThis.Date = RealDate;
    }
    expect(readdirSync(path.join(root, "backups")).filter((f) => f.endsWith(".s7bak"))).toHaveLength(30);
    rmSync(root, { recursive: true });
  });

  it("warns after three days without a backup, or when the second place is missing", async () => {
    const root = tmp();
    const b = new LocalBackups(root, root, async () => Buffer.from("x"));
    expect(b.warning()).toBeNull();
    await b.run();
    expect(b.warning()).toBeNull();
    expect(b.warning(Date.now() + 4 * 86_400_000)).toContain("3 أيام");
    const usb = path.join(root, "usb");
    b.setExtraDir(usb);
    rmSync(usb, { recursive: true });
    expect(b.warning()).toContain("مش موصول");
    rmSync(root, { recursive: true });
  });

  it("refuses a folder it cannot use", () => {
    const root = tmp();
    const b = new LocalBackups(root, root, async () => Buffer.from("x"));
    expect(() => b.setExtraDir("relative/path")).toThrow("المسار كامل");
    rmSync(root, { recursive: true });
  });
});
