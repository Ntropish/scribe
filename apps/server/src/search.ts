import { Hono } from "hono";
import { z } from "zod";
import { getPostgresClient } from "./infrastructure";
import { authMiddleware, getAuth, isAdmin, type AuthContext } from "./middleware";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const querySchema = z.object({
  q: z.string().min(1).max(500),
  space: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional().or(z.literal("").transform(() => undefined)),
  to: z.string().datetime({ offset: true }).optional().or(z.literal("").transform(() => undefined)),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return DEFAULT_LIMIT;
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n <= 0) return DEFAULT_LIMIT;
      return Math.min(n, MAX_LIMIT);
    }),
});

interface SearchRow {
  line_id: string;
  session_id: string;
  session_title: string;
  space_slug: string;
  start_ms: number;
  snippet: string;
  resolved_speaker: string;
  started_at: string;
}

interface SearchArgs {
  q: string;
  space: string | null;
  from: string | null;
  to: string | null;
  limit: number;
}

async function runSearch(auth: AuthContext, args: SearchArgs): Promise<SearchRow[]> {
  const sql = getPostgresClient();
  return sql<SearchRow[]>`
    SELECT
      l.id AS line_id,
      l.session_id,
      s.title AS session_title,
      sp.slug AS space_slug,
      l.start_ms,
      ts_headline(
        'english',
        l.text,
        websearch_to_tsquery('english', ${args.q}),
        'StartSel=[[, StopSel=]], MaxFragments=2, MaxWords=12, MinWords=3'
      ) AS snippet,
      COALESCE(
        sov.name,
        ssm_session.name,
        ssm_space.name,
        l.raw_speaker_label
      ) AS resolved_speaker,
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
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
      LIMIT 1
    ) sg ON true
    WHERE l.text_search @@ websearch_to_tsquery('english', ${args.q})
      AND (${args.from}::timestamptz IS NULL OR s.started_at >= ${args.from}::timestamptz)
      AND (${args.to}::timestamptz IS NULL OR s.started_at <= ${args.to}::timestamptz)
      AND (${args.space}::text IS NULL OR sp.slug = ${args.space})
      AND sp.archived_at IS NULL
      AND (
        ${isAdmin(auth)}
        OR sp.visibility = 'public'
        OR sp.created_by_sub = ${auth.subject}
        OR sp.created_by_sub = ANY(${auth.managedAgents})
        OR sg.role IS NOT NULL
      )
    ORDER BY ts_rank(l.text_search, websearch_to_tsquery('english', ${args.q})) DESC,
             s.started_at DESC,
             l.start_ms ASC
    LIMIT ${args.limit}
  `;
}

const search = new Hono<{ Variables: { auth: AuthContext } }>();

search.use("*", authMiddleware);

search.get("/", async (c) => {
  const auth = getAuth(c);
  const parsed = querySchema.safeParse({
    q: c.req.query("q"),
    space: c.req.query("space"),
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }

  const rows = await runSearch(auth, {
    q: parsed.data.q,
    space: parsed.data.space ?? null,
    from: parsed.data.from ?? null,
    to: parsed.data.to ?? null,
    limit: parsed.data.limit,
  });
  return c.json({ results: rows, next_cursor: null });
});

export default search;
