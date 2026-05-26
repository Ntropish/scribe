import { randomBytes } from "node:crypto";
import { getPostgresClient } from "./infrastructure";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  oidcSub: string;
  username: string;
  displayName: string;
}

export interface Session {
  id: string;
  userId: string;
  groups: string[];
  managedAgents: string[];
  accessToken: string | null;
  refreshToken: string | null;
  picture: string | null;
  expiresAt: Date;
}

export interface OidcLoginState {
  state: string;
  codeVerifier: string;
  redirect: string;
}

export async function getUserByOidcSub(sub: string): Promise<User | null> {
  const sql = getPostgresClient();
  const rows = await sql<User[]>`
    SELECT id, oidc_sub AS "oidcSub", username, display_name AS "displayName"
    FROM users WHERE oidc_sub = ${sub}
  `;
  return rows[0] ?? null;
}

export async function getUser(id: string): Promise<User | null> {
  const sql = getPostgresClient();
  const rows = await sql<User[]>`
    SELECT id, oidc_sub AS "oidcSub", username, display_name AS "displayName"
    FROM users WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

export async function createUser(username: string, displayName: string, oidcSub: string): Promise<User> {
  const sql = getPostgresClient();
  const rows = await sql<User[]>`
    INSERT INTO users (username, display_name, oidc_sub)
    VALUES (${username}, ${displayName}, ${oidcSub})
    RETURNING id, oidc_sub AS "oidcSub", username, display_name AS "displayName"
  `;
  const row = rows[0];
  if (!row) throw new Error("createUser returned no row");
  return row;
}

export async function createSession(
  userId: string,
  groups: string[],
  managedAgents: string[],
  accessToken: string,
  picture: string | null,
  refreshToken: string | null,
): Promise<Session> {
  const sql = getPostgresClient();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const rows = await sql<Session[]>`
    INSERT INTO sessions (id, user_id, groups, managed_agents, access_token, refresh_token, picture, expires_at)
    VALUES (${id}, ${userId}, ${groups}, ${managedAgents}, ${accessToken}, ${refreshToken ?? null}, ${picture ?? null}, ${expiresAt})
    RETURNING id, user_id AS "userId", groups, managed_agents AS "managedAgents",
              access_token AS "accessToken", refresh_token AS "refreshToken",
              picture, expires_at AS "expiresAt"
  `;
  const row = rows[0];
  if (!row) throw new Error("createSession returned no row");
  return row;
}

export async function getSession(id: string): Promise<Session | null> {
  const sql = getPostgresClient();
  const rows = await sql<Session[]>`
    SELECT id, user_id AS "userId", groups, managed_agents AS "managedAgents",
           access_token AS "accessToken", refresh_token AS "refreshToken",
           picture, expires_at AS "expiresAt"
    FROM sessions
    WHERE id = ${id} AND expires_at > now()
  `;
  return rows[0] ?? null;
}

export async function deleteSession(id: string): Promise<void> {
  const sql = getPostgresClient();
  await sql`DELETE FROM sessions WHERE id = ${id}`;
}

export async function createOidcLoginState(state: string, codeVerifier: string, redirect: string): Promise<void> {
  const sql = getPostgresClient();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await sql`
    INSERT INTO oidc_login_states (state, code_verifier, redirect, expires_at)
    VALUES (${state}, ${codeVerifier}, ${redirect}, ${expiresAt})
  `;
}

export async function consumeOidcLoginState(state: string): Promise<OidcLoginState | null> {
  const sql = getPostgresClient();
  const rows = await sql<OidcLoginState[]>`
    DELETE FROM oidc_login_states
    WHERE state = ${state} AND expires_at > now()
    RETURNING state, code_verifier AS "codeVerifier", redirect
  `;
  return rows[0] ?? null;
}

export async function cleanupExpired(): Promise<void> {
  const sql = getPostgresClient();
  await sql`DELETE FROM sessions WHERE expires_at <= now()`;
  await sql`DELETE FROM oidc_login_states WHERE expires_at <= now()`;
}
