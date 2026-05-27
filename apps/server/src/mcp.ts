import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authMiddleware, getAuth, isAdmin, type AuthContext } from "./middleware";
import { getOrigin } from "./well-known";
import { getPostgresClient } from "./infrastructure";
import { loadResolvedLinesForSession } from "./lines";

const mcp = new Hono<{ Variables: { auth: AuthContext } }>();

function challenge(req: Request) {
  const origin = getOrigin(req);
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

interface SpaceMinimal {
  id: string;
  created_by_sub: string;
  visibility: "private" | "public";
}

async function loadSpaceMinimalBySlug(slug: string): Promise<SpaceMinimal | null> {
  const sql = getPostgresClient();
  const rows = await sql<SpaceMinimal[]>`
    SELECT id, created_by_sub, visibility FROM spaces
    WHERE slug = ${slug} AND archived_at IS NULL
  `;
  return rows[0] ?? null;
}

async function loadSpaceMinimalById(id: string): Promise<SpaceMinimal | null> {
  const sql = getPostgresClient();
  const rows = await sql<SpaceMinimal[]>`
    SELECT id, created_by_sub, visibility FROM spaces
    WHERE id = ${id} AND archived_at IS NULL
  `;
  return rows[0] ?? null;
}

async function isSpaceAccessible(space: SpaceMinimal, auth: AuthContext): Promise<boolean> {
  if (isAdmin(auth)) return true;
  if (space.visibility === "public") return true;
  if (space.created_by_sub === auth.subject) return true;
  if (auth.managedAgents.includes(space.created_by_sub)) return true;
  if (auth.groups.length === 0) return false;
  const sql = getPostgresClient();
  const rows = await sql<{ space_id: string }[]>`
    SELECT space_id FROM space_grants
    WHERE space_id = ${space.id} AND group_name = ANY(${auth.groups})
    LIMIT 1
  `;
  return rows.length > 0;
}

function registerListSpaces(server: McpServer, auth: AuthContext) {
  server.registerTool(
    "list_spaces",
    {
      description:
        "List Scribe spaces the caller can access via Auth Core groups, as owner, admin, or managed-agent. " +
        "Public spaces are also visible.",
      inputSchema: {},
    },
    async () => {
      const sql = getPostgresClient();
      const admin = isAdmin(auth);
      const rows = await sql<{
        id: string;
        slug: string;
        name: string;
        description: string;
        visibility: "private" | "public";
        created_by_sub: string;
        member_role: "maintainer" | "editor" | "viewer" | null;
      }[]>`
        SELECT
          s.id, s.slug, s.name, s.description, s.visibility,
          s.created_by_sub,
          sg.role AS member_role
        FROM spaces s
        LEFT JOIN LATERAL (
          SELECT role
          FROM space_grants
          WHERE space_id = s.id AND group_name = ANY(${auth.groups})
          ORDER BY CASE role WHEN 'maintainer' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
          LIMIT 1
        ) sg ON true
        WHERE s.archived_at IS NULL
          AND (
            ${admin}
            OR s.visibility = 'public'
            OR s.created_by_sub = ${auth.subject}
            OR s.created_by_sub = ANY(${auth.managedAgents})
            OR sg.role IS NOT NULL
          )
        ORDER BY s.name ASC
      `;
      return textResult(
        rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          visibility: r.visibility,
          is_owner: r.created_by_sub === auth.subject,
          member_role: r.member_role,
          admin,
        })),
      );
    },
  );
}

function registerListSessions(server: McpServer, auth: AuthContext) {
  server.registerTool(
    "list_sessions",
    {
      description:
        "List transcription sessions in a Scribe space. Optional from/to (ISO timestamps) filter by started_at. " +
        "Scoped to spaces the caller can access.",
      inputSchema: {
        space: z.string().describe("space slug"),
        from: z.string().optional(),
        to: z.string().optional(),
      },
    },
    async ({ space, from, to }) => {
      const spaceRow = await loadSpaceMinimalBySlug(space);
      if (!spaceRow) return errorResult("space not found");
      if (!(await isSpaceAccessible(spaceRow, auth))) return errorResult("forbidden");

      const sql = getPostgresClient();
      const fromArg = from ?? null;
      const toArg = to ?? null;
      const rows = await sql<{
        id: string;
        title: string;
        state: string;
        started_at: string;
        finalized_at: string | null;
      }[]>`
        SELECT id, title, state, started_at, finalized_at
        FROM sessions
        WHERE space_id = ${spaceRow.id}
          AND (${fromArg}::timestamptz IS NULL OR started_at >= ${fromArg}::timestamptz)
          AND (${toArg}::timestamptz IS NULL OR started_at <= ${toArg}::timestamptz)
        ORDER BY started_at DESC
      `;
      return textResult(rows);
    },
  );
}

function registerGetSession(server: McpServer, auth: AuthContext) {
  server.registerTool(
    "get_session",
    {
      description:
        "Get one Scribe session including its resolved transcript lines. " +
        "Scoped to sessions in spaces the caller can access.",
      inputSchema: { id: z.string().uuid().describe("session id") },
    },
    async ({ id }) => {
      const sql = getPostgresClient();
      const sessionRows = await sql<{
        id: string;
        space_id: string;
        title: string;
        state: string;
        started_at: string;
        ended_at: string | null;
        finalized_at: string | null;
        finalized_by_sub: string | null;
      }[]>`
        SELECT id, space_id, title, state, started_at, ended_at,
               finalized_at, finalized_by_sub
        FROM sessions WHERE id = ${id}
      `;
      const sessionRow = sessionRows[0];
      if (!sessionRow) return errorResult("session not found");
      const spaceRow = await loadSpaceMinimalById(sessionRow.space_id);
      if (!spaceRow) return errorResult("session not found");
      if (!(await isSpaceAccessible(spaceRow, auth))) return errorResult("forbidden");

      const lines = await loadResolvedLinesForSession(sessionRow.id);
      return textResult({
        ...sessionRow,
        lines: lines.map((l) => ({
          id: l.id,
          line_index: l.lineIndex,
          start_ms: l.startMs,
          end_ms: l.endMs,
          text: l.text,
          resolved_speaker: l.resolvedSpeaker,
        })),
      });
    },
  );
}

function registerListSpeakers(server: McpServer, auth: AuthContext) {
  server.registerTool(
    "list_speakers",
    {
      description: "List named speakers in a Scribe space the caller can access.",
      inputSchema: { space: z.string().describe("space slug") },
    },
    async ({ space }) => {
      const spaceRow = await loadSpaceMinimalBySlug(space);
      if (!spaceRow) return errorResult("space not found");
      if (!(await isSpaceAccessible(spaceRow, auth))) return errorResult("forbidden");

      const sql = getPostgresClient();
      const rows = await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM speakers WHERE space_id = ${spaceRow.id}
        ORDER BY name ASC
      `;
      return textResult(rows);
    },
  );
}

function registerSearch(server: McpServer, auth: AuthContext) {
  server.registerTool(
    "search",
    {
      description:
        "Full-text search across Scribe transcript lines. Returns ranked hits with snippet and resolved speaker. " +
        "Scoped to spaces the caller can access.",
      inputSchema: {
        q: z.string().min(1).describe("search phrase"),
        space: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ q, space, from, to, limit }) => {
      const sql = getPostgresClient();
      const fromArg = from ?? null;
      const toArg = to ?? null;
      const spaceArg = space ?? null;
      const limitArg = limit ?? 50;
      const rows = await sql<{
        line_id: string;
        session_id: string;
        session_title: string;
        space_slug: string;
        start_ms: number;
        snippet: string;
        resolved_speaker: string;
        started_at: string;
      }[]>`
        SELECT
          l.id AS line_id,
          l.session_id,
          s.title AS session_title,
          sp.slug AS space_slug,
          l.start_ms,
          ts_headline(
            'english',
            l.text,
            websearch_to_tsquery('english', ${q}),
            'StartSel=[[, StopSel=]], MaxFragments=2, MaxWords=12, MinWords=3'
          ) AS snippet,
          COALESCE(sov.name, ssm_session.name, ssm_space.name, l.raw_speaker_label) AS resolved_speaker,
          s.started_at
        FROM lines l
        INNER JOIN sessions s ON s.id = l.session_id
        INNER JOIN spaces sp ON sp.id = s.space_id
        LEFT JOIN speakers sov ON sov.id = l.speaker_override_id
        LEFT JOIN session_speaker_mappings ssm_sj
          ON ssm_sj.session_id = l.session_id AND ssm_sj.raw_speaker_label = l.raw_speaker_label
        LEFT JOIN speakers ssm_session ON ssm_session.id = ssm_sj.speaker_id
        LEFT JOIN space_speaker_mappings ssm_sp
          ON ssm_sp.space_id = sp.id AND ssm_sp.raw_speaker_label = l.raw_speaker_label
        LEFT JOIN speakers ssm_space ON ssm_space.id = ssm_sp.speaker_id
        LEFT JOIN LATERAL (
          SELECT role
          FROM space_grants
          WHERE space_id = sp.id AND group_name = ANY(${auth.groups})
          ORDER BY CASE role WHEN 'maintainer' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
          LIMIT 1
        ) sg ON true
        WHERE l.text_search @@ websearch_to_tsquery('english', ${q})
          AND (${fromArg}::timestamptz IS NULL OR s.started_at >= ${fromArg}::timestamptz)
          AND (${toArg}::timestamptz IS NULL OR s.started_at <= ${toArg}::timestamptz)
          AND (${spaceArg}::text IS NULL OR sp.slug = ${spaceArg})
          AND sp.archived_at IS NULL
          AND (
            ${isAdmin(auth)}
            OR sp.visibility = 'public'
            OR sp.created_by_sub = ${auth.subject}
            OR sp.created_by_sub = ANY(${auth.managedAgents})
            OR sg.role IS NOT NULL
          )
        ORDER BY ts_rank(l.text_search, websearch_to_tsquery('english', ${q})) DESC,
                 s.started_at DESC,
                 l.start_ms ASC
        LIMIT ${limitArg}
      `;
      return textResult({ results: rows, next_cursor: null });
    },
  );
}

function createServer(auth: AuthContext): McpServer {
  const server = new McpServer({ name: "scribe", version: "0.1.0" });
  registerListSpaces(server, auth);
  registerListSessions(server, auth);
  registerGetSession(server, auth);
  registerListSpeakers(server, auth);
  registerSearch(server, auth);
  return server;
}

mcp.all("/*", async (c, next) => {
  const authz = c.req.header("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "authorization required" }, 401, {
      "WWW-Authenticate": challenge(c.req.raw),
    });
  }
  return authMiddleware(c, next);
});

mcp.all("/*", async (c) => {
  const auth = getAuth(c);
  const server = createServer(auth);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcp;
