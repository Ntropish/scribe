import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { env } from "./env";
import { getSession, updateSessionTokens } from "./db";

const preferences = new Hono();

interface RefreshedTokens {
  access_token: string;
  refresh_token?: string;
}

async function refreshAccessToken(sessionId: string, refreshToken: string): Promise<string | null> {
  const res = await fetch(`${env.oidcIssuer}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.oidcClientId,
      client_secret: env.oidcClientSecret,
    }),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as RefreshedTokens;
  await updateSessionTokens(sessionId, tokens.access_token, tokens.refresh_token ?? null);
  return tokens.access_token;
}

function buildUpstreamUrl(profileId: string | undefined): string {
  const base = `${env.oidcIssuer}/api/preferences`;
  return profileId ? `${base}?profile_id=${encodeURIComponent(profileId)}` : base;
}

preferences.get("/", async (c) => {
  const sessionId = getCookie(c, "scribe_session");
  if (!sessionId) return c.json({ error: "Unauthorized" }, 401);
  const session = await getSession(sessionId);
  if (!session?.accessToken) return c.json({ error: "Unauthorized" }, 401);

  const url = buildUpstreamUrl(c.req.query("profile_id"));

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  if (res.status === 401 && session.refreshToken) {
    const newToken = await refreshAccessToken(sessionId, session.refreshToken);
    if (newToken) {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${newToken}` },
      });
    }
  }

  if (!res.ok) {
    return c.json({ error: "Failed to fetch preferences" }, res.status as never);
  }
  return c.json(await res.json());
});

export default preferences;
