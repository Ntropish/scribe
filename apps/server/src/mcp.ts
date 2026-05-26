import { Hono } from "hono";
import { env } from "./env";
import { getOrigin } from "./well-known";

const mcp = new Hono();

function challenge(req: Request) {
  const origin = getOrigin(req);
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

mcp.all("/*", async (c) => {
  const authz = c.req.header("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "authorization required" }, 401, {
      "WWW-Authenticate": challenge(c.req.raw),
    });
  }
  void env; // tools register here once the MCP-server bead lands
  return c.json({ error: "not implemented" }, 501);
});

export default mcp;
