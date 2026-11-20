// Routes that exist only in the local edition.
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";

export async function localRoutes(app: FastifyInstance, opts: { shutdownToken: string; stop: () => void }) {
  /** What the first screen needs: is there a shop on this computer yet, or is this the first run. */
  app.get("/local/status", async () => {
    const t = (await app.db.query(`SELECT name FROM tenants ORDER BY created_at LIMIT 1`)).rows[0] as { name: string } | undefined;
    return { edition: "local", shop: t ? { name: t.name } : null };
  });

  /** The Windows app asks for a clean stop when it closes, so the database is never cut off mid-write. */
  app.post("/local/shutdown", async (req, reply) => {
    const got = Buffer.from(String(req.headers["x-shutdown-token"] ?? ""));
    const want = Buffer.from(opts.shutdownToken);
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return reply.status(403).send({ error: "ممنوع" });
    setTimeout(opts.stop, 50);
    return { ok: true };
  });
}
