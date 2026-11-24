// Shop network mode: the computer with the database also serves the web app to the shop's other
// devices on the same Wi-Fi or cable (a second till in a browser, the kitchen screen, the owner's
// phone). Off by default: the server then listens on this computer only.
import { createSocket } from "node:dgram";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";

export function readNetwork(dataDir: string): { lan: boolean } {
  try {
    return { lan: false, ...JSON.parse(readFileSync(path.join(dataDir, "network.json"), "utf8")) };
  } catch {
    return { lan: false };
  }
}

export function saveNetwork(dataDir: string, v: { lan: boolean }) {
  writeFileSync(path.join(dataDir, "network.json"), JSON.stringify(v));
}

/** This computer's addresses on the shop's network, as the other devices type them. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
  }
  return out;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain",
};

/** Serves the web app's files; any other path gets the app itself (it reads the address). */
export function serveWeb(webDir: string | null, req: IncomingMessage, res: ServerResponse) {
  if (!webDir || (req.method !== "GET" && req.method !== "HEAD")) {
    res.writeHead(404, { "content-type": "application/json" }).end(`{"error":"غير موجود"}`);
    return;
  }
  let rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.resolve(webDir, `.${rel}`);
  // Nothing outside the web app's folder.
  const inside = file.startsWith(path.resolve(webDir) + path.sep);
  const target = inside && existsSync(file) && statSync(file).isFile() ? file : path.join(webDir, "index.html");
  const type = TYPES[path.extname(target)] ?? "application/octet-stream";
  const cache = target.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": type, "cache-control": cache });
  res.end(req.method === "HEAD" ? undefined : readFileSync(target));
}

/**
 * The other Windows tills find this computer by asking on the shop's network (a UDP broadcast
 * "SALE7-FIND" to port 7401), so a new address from the router after a restart doesn't cut them
 * off. Answers only while the shop network is on.
 */
export const FIND_PORT = 7401;
export const FIND_ASK = "SALE7-FIND";

export function startFinder(answer: () => Promise<Record<string, unknown> | null>, port = FIND_PORT): () => void {
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    try {
      sock.close();
    } catch {
      /* already closed */
    }
  };
  sock.on("message", (msg, from) => {
    if (msg.toString("utf8").trim() !== FIND_ASK) return;
    void answer()
      .then((a) => a && open && sock.send(JSON.stringify({ app: "sale7-pos", ...a }), from.port, from.address))
      .catch(() => undefined);
  });
  sock.on("error", (e) => {
    console.error("finding on the shop network unavailable:", e.message);
    close();
  });
  sock.bind(port, "0.0.0.0");
  return close;
}
