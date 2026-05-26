import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, createHash } from "node:crypto";
import { env } from "./env";
import {
  consumeOidcLoginState,
  createOidcLoginState,
  createSession,
  createUser,
  deleteSession,
  getSession,
  getUser,
  getUserByOidcSub,
} from "./db";
import type { User } from "./db";
import { getOrigin } from "./well-known";

const auth = new Hono();

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
}

interface IdPayload {
  sub: string;
  name?: string;
  preferred_username?: string;
  picture?: string;
  groups?: string[];
  managed_agents?: string[];
}

interface TokenExchangeArgs {
  code: string;
  codeVerifier: string;
  origin: string;
}

async function exchangeCode(args: TokenExchangeArgs): Promise<{ ok: true; tokens: TokenResponse } | { ok: false; body: string }> {
  const res = await fetch(`${env.oidcIssuer}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: env.oidcClientId,
      client_secret: env.oidcClientSecret,
      redirect_uri: `${args.origin}/auth/callback`,
      code_verifier: args.codeVerifier,
    }),
  });
  if (!res.ok) return { ok: false, body: await res.text() };
  return { ok: true, tokens: (await res.json()) as TokenResponse };
}

export function decodeIdToken(idToken: string): IdPayload | null {
  const segment = idToken.split(".")[1];
  if (!segment) return null;
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString()) as IdPayload;
  } catch {
    return null;
  }
}

async function provisionUser(idPayload: IdPayload): Promise<User> {
  const existing = await getUserByOidcSub(idPayload.sub);
  if (existing) return existing;
  const username = idPayload.preferred_username || idPayload.sub;
  const displayName = idPayload.name || username;
  return createUser(username, displayName, idPayload.sub);
}

async function startSession(user: User, idPayload: IdPayload, tokens: TokenResponse) {
  return createSession(
    user.id,
    idPayload.groups ?? [],
    idPayload.managed_agents ?? [],
    tokens.access_token,
    idPayload.picture ?? null,
    tokens.refresh_token ?? null,
  );
}

export function safeRedirect(input: string): string {
  if (!input.startsWith("/") || input.startsWith("//")) return "/";
  return input;
}

auth.get("/auth/login", async (c) => {
  const redirect = c.req.query("redirect") || "/";
  const origin = getOrigin(c.req.raw);
  const state = randomBytes(16).toString("hex");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  await createOidcLoginState(state, codeVerifier, redirect);
  const url = new URL(`${env.oidcIssuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.oidcClientId);
  url.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "openid profile groups");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

auth.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");
  if (errorParam) return c.text(`Authentication failed: ${errorParam}`, 400);
  if (!code || !state) return c.text("Missing code or state", 400);

  const pkce = await consumeOidcLoginState(state);
  if (!pkce) return c.text("Invalid or expired state", 400);

  const origin = getOrigin(c.req.raw);
  const exchange = await exchangeCode({ code, codeVerifier: pkce.codeVerifier, origin });
  if (!exchange.ok) return c.text(`Token exchange failed: ${exchange.body}`, 500);

  const idPayload = decodeIdToken(exchange.tokens.id_token);
  if (!idPayload) return c.text("id_token missing or unreadable payload", 500);

  const user = await provisionUser(idPayload);
  const session = await startSession(user, idPayload, exchange.tokens);

  setCookie(c, "scribe_session", session.id, {
    path: "/",
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60,
  });

  return c.redirect(safeRedirect(pkce.redirect));
});

auth.get("/auth/logout", async (c) => {
  const sessionId = getCookie(c, "scribe_session");
  if (sessionId) await deleteSession(sessionId);
  deleteCookie(c, "scribe_session", { path: "/" });
  return c.redirect("/");
});

auth.get("/api/me", async (c) => {
  if (env.authDisabled) {
    return c.json({
      id: "__bypass__",
      sub: "__bypass__",
      username: "anonymous",
      displayName: "Anonymous",
      groups: ["admin"],
      managedAgents: [],
      picture: null,
    });
  }
  const sessionId = getCookie(c, "scribe_session");
  if (!sessionId) return c.json(null);
  const session = await getSession(sessionId);
  if (!session) return c.json(null);
  const user = await getUser(session.userId);
  if (!user) return c.json(null);
  return c.json({
    id: user.id,
    sub: user.oidcSub,
    username: user.username,
    displayName: user.displayName,
    groups: session.groups,
    managedAgents: session.managedAgents,
    picture: session.picture,
  });
});

export default auth;
