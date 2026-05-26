import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, validateEnv } from "./env";
import { runMigrations } from "./migrate";

validateEnv();
import { wellKnown } from "./well-known";
import authRoutes from "./auth";
import mcpRoutes from "./mcp";
import spacesRoutes from "./spaces";
import sessionsRoutes from "./sessions";
import speakersRoutes from "./speakers";
import searchRoutes from "./search";
import { attachSocketIO } from "./sockets";
import { cleanupExpired } from "./db";

if (env.databaseUrl) {
  await runMigrations();
}

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.route("/.well-known", wellKnown);
app.route("/", authRoutes);
app.route("/mcp", mcpRoutes);
app.route("/api/spaces", spacesRoutes);
app.route("/api", sessionsRoutes);
app.route("/api", speakersRoutes);
app.route("/api/search", searchRoutes);

const webDist = join(import.meta.dirname, "..", "..", "web", "dist");
if (existsSync(webDist)) {
  // Try to serve a real file under apps/web/dist first; rewrite `/` to
  // `/index.html`. Hono's serveStatic does not call next() on miss, so
  // the SPA fallback runs separately below for unmatched routes.
  app.use(
    "*",
    serveStatic({
      root: webDist,
      rewriteRequestPath: (p) => (p === "/" ? "/index.html" : p),
    }),
  );
  app.get("*", async (c) => {
    const path = c.req.path;
    const isBackend =
      path.startsWith("/api/") ||
      path.startsWith("/auth/") ||
      path.startsWith("/.well-known/") ||
      path === "/mcp" ||
      path.startsWith("/mcp/") ||
      path === "/healthz";
    if (isBackend) return c.notFound();
    const indexPath = join(webDist, "index.html");
    const html = await Bun.file(indexPath).text();
    return c.html(html);
  });
}

const server = serve({ fetch: app.fetch, port: env.port });

attachSocketIO(server as unknown as import("node:http").Server);

setInterval(() => {
  void cleanupExpired();
}, 60 * 60 * 1000);

console.log(`scribe listening on :${env.port}`);
