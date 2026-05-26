import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./env";
import { getSession, getUser } from "./db";

export interface AuthContext {
  type: "user";
  userId: string;
  subject: string;
  username: string;
  groups: string[];
  managedAgents: string[];
}

const jwks = createRemoteJWKSet(new URL(`${env.oidcIssuer}/.well-known/jwks.json`));

function readStringArray(claims: Record<string, unknown>, key: string): string[] {
  const value = claims[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export const authMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  if (env.authDisabled) {
    c.set("auth", {
      type: "user",
      userId: "__bypass__",
      subject: "__bypass__",
      username: "anonymous",
      groups: ["admin"],
      managedAgents: [],
    });
    return next();
  }

  const sessionId = getCookie(c, "scribe_session");
  if (sessionId) {
    const session = await getSession(sessionId);
    if (session) {
      const user = await getUser(session.userId);
      if (user) {
        c.set("auth", {
          type: "user",
          userId: user.id,
          subject: user.oidcSub,
          username: user.username,
          groups: session.groups,
          managedAgents: session.managedAgents,
        });
        return next();
      }
    }
  }

  const authz = c.req.header("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) {
    const token = authz.slice("bearer ".length).trim();
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: env.oidcIssuer });
      const claims = payload as Record<string, unknown>;
      const sub = typeof claims.sub === "string" ? claims.sub : null;
      if (sub) {
        const username = (typeof claims.preferred_username === "string" && claims.preferred_username)
          || (typeof claims.name === "string" && claims.name)
          || sub;
        c.set("auth", {
          type: "user",
          userId: sub,
          subject: sub,
          username,
          groups: readStringArray(claims, "groups"),
          managedAgents: readStringArray(claims, "managed_agents"),
        });
        return next();
      }
    } catch {
      // fall through to 401
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

export function getAuth(c: { get: (key: "auth") => AuthContext }): AuthContext {
  return c.get("auth");
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.groups.includes("admin");
}
