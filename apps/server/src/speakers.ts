import { Hono } from "hono";
import { z } from "zod";
import { getPostgresClient } from "./infrastructure";
import { authMiddleware, getAuth, type AuthContext } from "./middleware";
import {
  effectiveSpaceRole,
  loadSpaceBySlug,
  loadSpaceById,
  meetsRole,
} from "./space-acl";
import {
  gatherEmbeddingsForSpaceLabel,
  getSessionsForSpace,
  lineIdsForSessionLabel,
  lineIdsForSpaceLabel,
  loadResolvedLinesByIds,
} from "./lines";
import { getIo } from "./sockets";
import { enroll as enrollAtService } from "./whisper-stream-client";

const createSpeakerSchema = z.object({
  name: z.string().min(1).max(200),
});

const setMappingSchema = z.object({
  speaker_id: z.string().uuid().nullable(),
});

interface SpeakerRow {
  id: string;
  spaceId: string;
  name: string;
  createdAt: string;
}

function toSpeaker(row: { id: string; space_id: string; name: string; created_at: string }): SpeakerRow {
  return {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

async function loadSession(id: string): Promise<{
  id: string;
  space_id: string;
  state: "recording" | "paused" | "stopped" | "finalized";
} | null> {
  const sql = getPostgresClient();
  const rows = await sql<{
    id: string;
    space_id: string;
    state: "recording" | "paused" | "stopped" | "finalized";
  }[]>`SELECT id, space_id, state FROM sessions WHERE id = ${id}`;
  return rows[0] ?? null;
}

async function broadcastLineUpdates(sessionIds: string[], lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  const io = getIo();
  if (!io) return;
  const lines = await loadResolvedLinesByIds(lineIds);
  const bySession = new Map<string, typeof lines>();
  for (const line of lines) {
    const arr = bySession.get(line.sessionId) ?? [];
    arr.push(line);
    bySession.set(line.sessionId, arr);
  }
  for (const sessionId of sessionIds) {
    const arr = bySession.get(sessionId);
    if (!arr) continue;
    for (const line of arr) {
      io.to(`session:${sessionId}`).emit("line_updated", {
        id: line.id,
        session_id: line.sessionId,
        capture_id: line.captureId,
        line_index: line.lineIndex,
        start_ms: line.startMs,
        end_ms: line.endMs,
        text: line.text,
        raw_speaker_label: line.rawSpeakerLabel,
        resolved_speaker: line.resolvedSpeaker,
        created_at: line.createdAt,
      });
    }
  }
}

const speakers = new Hono<{ Variables: { auth: AuthContext } }>();

speakers.use("*", authMiddleware);

speakers.get("/spaces/:slug/speakers", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "viewer") && space.visibility !== "public") {
    return c.json({ error: "forbidden" }, 403);
  }
  const sql = getPostgresClient();
  const rows = await sql<{ id: string; space_id: string; name: string; created_at: string }[]>`
    SELECT id, space_id, name, created_at
    FROM speakers
    WHERE space_id = ${space.id}
    ORDER BY name ASC
  `;
  return c.json(rows.map(toSpeaker));
});

speakers.post("/spaces/:slug/speakers", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = createSpeakerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }

  const sql = getPostgresClient();
  try {
    const rows = await sql<{ id: string; space_id: string; name: string; created_at: string }[]>`
      INSERT INTO speakers (space_id, name) VALUES (${space.id}, ${parsed.data.name})
      RETURNING id, space_id, name, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return c.json(toSpeaker(row), 201);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      return c.json({ error: "speaker name already exists in this space" }, 409);
    }
    throw err;
  }
});

speakers.delete("/spaces/:slug/speakers/:id", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const sql = getPostgresClient();
  // Identify the labels whose resolution may change after we remove this
  // speaker, so we can broadcast line_updated for every affected line.
  const labels = await sql<{ raw_speaker_label: string }[]>`
    SELECT DISTINCT raw_speaker_label
    FROM space_speaker_mappings
    WHERE space_id = ${space.id}
      AND speaker_id = ${c.req.param("id")}
    UNION
    SELECT DISTINCT raw_speaker_label
    FROM session_speaker_mappings ssm
    INNER JOIN sessions s ON s.id = ssm.session_id
    WHERE s.space_id = ${space.id}
      AND ssm.speaker_id = ${c.req.param("id")}
  `;
  await sql`DELETE FROM speakers WHERE id = ${c.req.param("id")} AND space_id = ${space.id}`;

  const sessionIds = await getSessionsForSpace(space.id);
  const affectedLineIds = new Set<string>();
  for (const { raw_speaker_label } of labels) {
    const ids = await lineIdsForSpaceLabel(space.id, raw_speaker_label);
    for (const id of ids) affectedLineIds.add(id);
  }
  await broadcastLineUpdates(sessionIds, [...affectedLineIds]);

  return c.body(null, 204);
});

speakers.put("/spaces/:slug/speaker-mappings/:rawLabel", async (c) => {
  const auth = getAuth(c);
  const space = await loadSpaceBySlug(c.req.param("slug"));
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = setMappingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const rawLabel = c.req.param("rawLabel");

  const sql = getPostgresClient();
  let speakerName: string | null = null;
  if (parsed.data.speaker_id === null) {
    await sql`
      DELETE FROM space_speaker_mappings
      WHERE space_id = ${space.id} AND raw_speaker_label = ${rawLabel}
    `;
  } else {
    const speakerRow = await sql<{ name: string }[]>`
      SELECT name FROM speakers
      WHERE id = ${parsed.data.speaker_id} AND space_id = ${space.id}
    `;
    if (speakerRow.length === 0) {
      return c.json({ error: "speaker not found in this space" }, 404);
    }
    speakerName = speakerRow[0]!.name;
    await sql`
      INSERT INTO space_speaker_mappings (space_id, raw_speaker_label, speaker_id)
      VALUES (${space.id}, ${rawLabel}, ${parsed.data.speaker_id})
      ON CONFLICT (space_id, raw_speaker_label) DO UPDATE SET speaker_id = EXCLUDED.speaker_id
    `;
  }

  const sessionIds = await getSessionsForSpace(space.id);
  const affectedLineIds = await lineIdsForSpaceLabel(space.id, rawLabel);
  await broadcastLineUpdates(sessionIds, affectedLineIds);

  let enrollment: { ok: boolean; embedding_count?: number; error?: string } = { ok: true };
  if (parsed.data.speaker_id !== null && speakerName) {
    const embeddings = await gatherEmbeddingsForSpaceLabel(space.id, rawLabel);
    const result = await enrollAtService(space.id, speakerName, embeddings);
    if ("error" in result) {
      enrollment = { ok: false, error: result.error };
      return c.json(
        {
          mapping: { space_id: space.id, raw_speaker_label: rawLabel, speaker_id: parsed.data.speaker_id },
          enrollment,
        },
        502,
      );
    }
    enrollment = { ok: true, embedding_count: result.embedding_count };
  }

  return c.json({
    mapping: {
      space_id: space.id,
      raw_speaker_label: rawLabel,
      speaker_id: parsed.data.speaker_id,
    },
    enrollment,
  });
});

speakers.put("/sessions/:id/speaker-mappings/:rawLabel", async (c) => {
  const auth = getAuth(c);
  const session = await loadSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  if (session.state === "finalized") {
    return c.json({ error: "session is finalized" }, 409);
  }
  const space = await loadSpaceById(session.space_id);
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = setMappingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const rawLabel = c.req.param("rawLabel");

  const sql = getPostgresClient();
  if (parsed.data.speaker_id === null) {
    await sql`
      DELETE FROM session_speaker_mappings
      WHERE session_id = ${session.id} AND raw_speaker_label = ${rawLabel}
    `;
  } else {
    const speakerRow = await sql<{ id: string }[]>`
      SELECT id FROM speakers
      WHERE id = ${parsed.data.speaker_id} AND space_id = ${space.id}
    `;
    if (speakerRow.length === 0) {
      return c.json({ error: "speaker not found in this space" }, 404);
    }
    await sql`
      INSERT INTO session_speaker_mappings (session_id, raw_speaker_label, speaker_id)
      VALUES (${session.id}, ${rawLabel}, ${parsed.data.speaker_id})
      ON CONFLICT (session_id, raw_speaker_label) DO UPDATE SET speaker_id = EXCLUDED.speaker_id
    `;
  }

  const affectedLineIds = await lineIdsForSessionLabel(session.id, rawLabel);
  await broadcastLineUpdates([session.id], affectedLineIds);

  return c.json({
    mapping: {
      session_id: session.id,
      raw_speaker_label: rawLabel,
      speaker_id: parsed.data.speaker_id,
    },
  });
});

speakers.put("/lines/:id/speaker", async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => null);
  const parsed = setMappingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }

  const sql = getPostgresClient();
  const lineRows = await sql<{ id: string; session_id: string }[]>`
    SELECT id, session_id FROM lines WHERE id = ${c.req.param("id")}
  `;
  const line = lineRows[0];
  if (!line) return c.json({ error: "not found" }, 404);

  const session = await loadSession(line.session_id);
  if (!session) return c.json({ error: "not found" }, 404);
  if (session.state === "finalized") {
    return c.json({ error: "session is finalized" }, 409);
  }
  const space = await loadSpaceById(session.space_id);
  if (!space || space.archivedAt) return c.json({ error: "not found" }, 404);
  const role = await effectiveSpaceRole(space, auth);
  if (!meetsRole(role, "editor")) return c.json({ error: "forbidden" }, 403);

  if (parsed.data.speaker_id !== null) {
    const speakerRow = await sql<{ id: string }[]>`
      SELECT id FROM speakers
      WHERE id = ${parsed.data.speaker_id} AND space_id = ${space.id}
    `;
    if (speakerRow.length === 0) {
      return c.json({ error: "speaker not found in this space" }, 404);
    }
  }

  await sql`
    UPDATE lines
    SET speaker_override_id = ${parsed.data.speaker_id}
    WHERE id = ${line.id}
  `;

  await broadcastLineUpdates([session.id], [line.id]);

  return c.json({
    line_id: line.id,
    speaker_override_id: parsed.data.speaker_id,
  });
});

export default speakers;
