import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { join } from "node:path";
import { env } from "./env";
import { runMigrations } from "./migrate";
import { wellKnown } from "./well-known";
import authRoutes from "./auth";
import mcpRoutes from "./mcp";
import spacesRoutes from "./spaces";
import sessionsRoutes from "./sessions";
import speakersRoutes from "./speakers";
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

const webDist = join(import.meta.dirname, "..", "..", "web", "dist");
app.use("/assets/*", serveStatic({ root: webDist }));
app.get("*", serveStatic({ root: webDist, path: "index.html" }));

const server = serve({ fetch: app.fetch, port: env.port });

attachSocketIO(server as unknown as import("node:http").Server);

setInterval(() => {
  void cleanupExpired();
}, 60 * 60 * 1000);

console.log(`scribe listening on :${env.port}`);
