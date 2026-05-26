import { Hono } from "hono";
import { z } from "zod";
import { getPostgresClient } from "./infrastructure";
import { authMiddleware, getAuth, isAdmin, type AuthContext } from "./middleware";
import {
  effectiveSpaceRole,
  loadSpaceBySlug,
  meetsRole,
} from "./space-acl";

export type SessionState = "recording" | "paused" | "stopped" | "finalized";

export interface SessionRow {
  id: string;
  spaceId: string;
  spaceSlug: string;
  title: string;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
  finalizedAt: string | null;
  finalizedBySub: string | null;
  createdBySub: string;
  createdAt: string;
  updatedAt: string;
}

const createSchema = z.object({
  title: z.string().max(500).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
});

const dateOrEmpty = z
  .string()
  .datetime({ offset: true })
  .optional()
  .or(z.literal("").transform(() => undefined));

const listQuery = z.object({
  from: dateOrEmpty,
  to: dateOrEmpty,
  q: z.string().max(500).optional(),
});

interface DbSessionRow {
  id: string;
  space_id: string;
  space_slug: string;
  title: string;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  finalized_at: string | null;
  finalized_by_sub: string | null;
  created_by_sub: string;
  created_at: string;
  updated_at: string;
}

function toSession(row: DbSessionRow): SessionRow {
  return {
    id: row.id,
    spaceId: row.space_id,
    spaceSlug: row.space_slug,
    title: row.title,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalizedAt: row.finalized_at,
    finalizedBySub: row.finalized_by_sub,
    createdBySub: row.created_by_sub,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadSession(id: string): Promise<DbSessionRow | null> {
  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    SELECT
      s.id, s.space_id, sp.slug AS space_slug, s.title, s.state,
      s.started_at, s.ended_at, s.finalized_at, s.finalized_by_sub,
      s.created_by_sub, s.created_at, s.updated_at
    FROM sessions s
    INNER JOIN spaces sp ON sp.id = s.space_id
    WHERE s.id = ${id}
  `;
  return rows[0] ?? null;
}

// Sessions in a space are listed under /api/spaces/:slug/sessions; per-session
// reads / writes go through /api/sessions/:id. We mount this under /api so the
// app server can register both prefixes on it.
const sessions = new Hono<{ Variables: { auth: AuthContext } }>();

sessions.use("*", authMiddleware);

sessions.get("/spaces/:slug/sessions", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "viewer") && space.visibility !== "public") {
    return c.json({ error: "forbidden" }, 403);
  }

  const parsed = listQuery.safeParse({
    from: c.req.query("from"),
    to: c.req.query("to"),
    q: c.req.query("q"),
  });
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const { from, to, q } = parsed.data;

  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    SELECT
      s.id, s.space_id, sp.slug AS space_slug, s.title, s.state,
      s.started_at, s.ended_at, s.finalized_at, s.finalized_by_sub,
      s.created_by_sub, s.created_at, s.updated_at
    FROM sessions s
    INNER JOIN spaces sp ON sp.id = s.space_id
    WHERE s.space_id = ${space.id}
      AND (${from ?? null}::timestamptz IS NULL OR s.started_at >= ${from ?? null}::timestamptz)
      AND (${to ?? null}::timestamptz IS NULL OR s.started_at <= ${to ?? null}::timestamptz)
      AND (${q ?? null}::text IS NULL OR s.title ILIKE '%' || ${q ?? null} || '%')
    ORDER BY s.started_at DESC
  `;

  return c.json(rows.map(toSession));
});

sessions.post("/spaces/:slug/sessions", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const title = parsed.data.title ?? "";

  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    WITH inserted AS (
      INSERT INTO sessions (space_id, title, created_by_sub)
      VALUES (${space.id}, ${title}, ${auth.subject})
      RETURNING id, space_id, title, state, started_at, ended_at,
                finalized_at, finalized_by_sub, created_by_sub,
                created_at, updated_at
    )
    SELECT
      i.id, i.space_id, ${space.slug} AS space_slug, i.title, i.state,
      i.started_at, i.ended_at, i.finalized_at, i.finalized_by_sub,
      i.created_by_sub, i.created_at, i.updated_at
    FROM inserted i
  `;
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return c.json(toSession(row), 201);
});

sessions.get("/sessions/:id", async (c) => {
  const auth = getAuth(c);
  const session = await loadSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);

  const space = await loadSpaceBySlug(session.space_slug);
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);

  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "viewer") && space.visibility !== "public") {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json(toSession(session));
});

sessions.patch("/sessions/:id", async (c) => {
  const auth = getAuth(c);
  const session = await loadSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);

  if (session.state === "finalized") {
    return c.json({ error: "session is finalized" }, 409);
  }

  const space = await loadSpaceBySlug(session.space_slug);
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const { title } = parsed.data;
  if (title === undefined) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    WITH updated AS (
      UPDATE sessions SET
        title = ${title},
        updated_at = now()
      WHERE id = ${session.id}
      RETURNING id, space_id, title, state, started_at, ended_at,
                finalized_at, finalized_by_sub, created_by_sub,
                created_at, updated_at
    )
    SELECT
      u.id, u.space_id, ${session.space_slug} AS space_slug, u.title, u.state,
      u.started_at, u.ended_at, u.finalized_at, u.finalized_by_sub,
      u.created_by_sub, u.created_at, u.updated_at
    FROM updated u
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toSession(row));
});

sessions.post("/sessions/:id/finalize", async (c) => {
  const auth = getAuth(c);
  const session = await loadSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);

  if (session.state === "finalized") {
    return c.json({ error: "already finalized" }, 409);
  }

  const space = await loadSpaceBySlug(session.space_slug);
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    WITH updated AS (
      UPDATE sessions SET
        state = 'finalized',
        finalized_at = now(),
        finalized_by_sub = ${auth.subject},
        updated_at = now()
      WHERE id = ${session.id}
      RETURNING id, space_id, title, state, started_at, ended_at,
                finalized_at, finalized_by_sub, created_by_sub,
                created_at, updated_at
    )
    SELECT
      u.id, u.space_id, ${session.space_slug} AS space_slug, u.title, u.state,
      u.started_at, u.ended_at, u.finalized_at, u.finalized_by_sub,
      u.created_by_sub, u.created_at, u.updated_at
    FROM updated u
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toSession(row));
});

sessions.post("/sessions/:id/unfinalize", async (c) => {
  const auth = getAuth(c);
  if (!isAdmin(auth)) return c.json({ error: "forbidden" }, 403);

  const session = await loadSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);

  if (session.state !== "finalized") {
    return c.json({ error: "not finalized" }, 409);
  }

  const sql = getPostgresClient();
  const rows = await sql<DbSessionRow[]>`
    WITH updated AS (
      UPDATE sessions SET
        state = 'stopped',
        finalized_at = NULL,
        finalized_by_sub = NULL,
        updated_at = now()
      WHERE id = ${session.id}
      RETURNING id, space_id, title, state, started_at, ended_at,
                finalized_at, finalized_by_sub, created_by_sub,
                created_at, updated_at
    )
    SELECT
      u.id, u.space_id, ${session.space_slug} AS space_slug, u.title, u.state,
      u.started_at, u.ended_at, u.finalized_at, u.finalized_by_sub,
      u.created_by_sub, u.created_at, u.updated_at
    FROM updated u
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toSession(row));
});

export default sessions;
