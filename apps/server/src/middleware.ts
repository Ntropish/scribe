import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context } from "hono";
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

function bypassContext(): AuthContext {
  return {
    type: "user",
    userId: "__bypass__",
    subject: "__bypass__",
    username: "anonymous",
    groups: ["admin"],
    managedAgents: [],
  };
}

async function authFromCookie(c: Context): Promise<AuthContext | null> {
  const sessionId = getCookie(c, "scribe_session");
  if (!sessionId) return null;
  const session = await getSession(sessionId);
  if (!session) return null;
  const user = await getUser(session.userId);
  if (!user) return null;
  return {
    type: "user",
    userId: user.id,
    subject: user.oidcSub,
    username: user.username,
    groups: session.groups,
    managedAgents: session.managedAgents,
  };
}

function pickUsername(claims: Record<string, unknown>, sub: string): string {
  const preferred = claims.preferred_username;
  if (typeof preferred === "string" && preferred) return preferred;
  const name = claims.name;
  if (typeof name === "string" && name) return name;
  return sub;
}

async function authFromBearer(c: Context): Promise<AuthContext | null> {
  const authz = c.req.header("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) return null;
  const token = authz.slice("bearer ".length).trim();
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: env.oidcIssuer });
    const claims = payload as Record<string, unknown>;
    const sub = typeof claims.sub === "string" ? claims.sub : null;
    if (!sub) return null;
    return {
      type: "user",
      userId: sub,
      subject: sub,
      username: pickUsername(claims, sub),
      groups: readStringArray(claims, "groups"),
      managedAgents: readStringArray(claims, "managed_agents"),
    };
  } catch {
    return null;
  }
}

export const authMiddleware = createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
  if (env.authDisabled) {
    c.set("auth", bypassContext());
    return next();
  }
  const fromCookie = await authFromCookie(c);
  if (fromCookie) {
    c.set("auth", fromCookie);
    return next();
  }
  const fromBearer = await authFromBearer(c);
  if (fromBearer) {
    c.set("auth", fromBearer);
    return next();
  }
  return c.json({ error: "Unauthorized" }, 401);
});

export function getAuth(c: { get: (key: "auth") => AuthContext }): AuthContext {
  return c.get("auth");
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.groups.includes("admin");
}
