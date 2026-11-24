// Shop network mode: the web app served to the shop's other devices, and the licence's device count.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readNetwork, saveNetwork, serveWeb } from "../src/local/network";
import { assertWithinPlan, setLocalDeviceLimit } from "../src/billing";
import type { Db } from "../src/db";

function get(webDir: string | null, url: string, method = "GET") {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      headers = h;
      return this;
    },
    end(b?: Buffer | string) {
      body = b ? b.toString() : "";
    },
  } as unknown as ServerResponse;
  serveWeb(webDir, { url, method } as IncomingMessage, res);
  return { status, headers, body };
}

describe("serving the web app", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pos-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<app>");
  writeFileSync(path.join(dir, "assets", "a.js"), "js");
  writeFileSync(path.join(tmpdir(), "secret.txt"), "secret");

  it("serves files, and the app for any page", () => {
    expect(get(dir, "/").body).toBe("<app>");
    const js = get(dir, "/assets/a.js?v=1");
    expect(js.body).toBe("js");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect(get(dir, "/owner").body).toBe("<app>");
    expect(get(dir, "/assets/missing.js").body).toBe("<app>");
  });

  it("never serves a file outside its folder", () => {
    expect(get(dir, "/../secret.txt").body).toBe("<app>");
    expect(get(dir, "/assets/%2e%2e/%2e%2e/secret.txt").body).toBe("<app>");
  });

  it("answers 404 without a web folder, and to writes", () => {
    expect(get(null, "/").status).toBe(404);
    expect(get(dir, "/", "POST").status).toBe(404);
    rmSync(dir, { recursive: true });
  });

  it("remembers whether the network is on", () => {
    const d = mkdtempSync(path.join(tmpdir(), "pos-net-"));
    expect(readNetwork(d).lan).toBe(false);
    saveNetwork(d, { lan: true });
    expect(readNetwork(d).lan).toBe(true);
    rmSync(d, { recursive: true });
  });
});

describe("devices the licence covers", () => {
  const db = (devices: number) => ({ query: async () => ({ rows: [{ n: devices }], rowCount: 1 }) }) as unknown as Db;
  it("stops at the licence's count", async () => {
    setLocalDeviceLimit(2);
    await expect(assertWithinPlan(db(1), "t", "devices")).resolves.toBeUndefined();
    await expect(assertWithinPlan(db(2), "t", "devices")).rejects.toThrow("الترخيص يسمح بـ 2");
    await expect(assertWithinPlan(db(2), "t", "devices", "kitchen")).resolves.toBeUndefined();
    setLocalDeviceLimit(null);
  });
});
