import { Hono } from "hono";
import { env } from "./env";

export function getOrigin(req: Request): string {
  if (env.publicOrigin) {
    return env.publicOrigin.replace(/\/$/, "");
  }
  const url = new URL(req.url);
  const proto = req.headers.get("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

function protectedResource(req: Request) {
  const origin = getOrigin(req);
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [env.oidcIssuer],
    bearer_methods_supported: ["header"],
  };
}

export const wellKnown = new Hono();

wellKnown.get("/oauth-protected-resource", (c) => c.json(protectedResource(c.req.raw)));
wellKnown.get("/oauth-protected-resource/*", (c) => c.json(protectedResource(c.req.raw)));
