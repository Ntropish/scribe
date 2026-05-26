import { getPostgresClient } from "./infrastructure";

export interface ResolvedLine {
  id: string;
  sessionId: string;
  captureId: string;
  lineIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  rawSpeakerLabel: string;
  speakerOverrideId: string | null;
  resolvedSpeaker: string;
  createdAt: string;
}

interface DbRow {
  id: string;
  session_id: string;
  capture_id: string;
  line_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  raw_speaker_label: string;
  speaker_override_id: string | null;
  resolved_speaker: string;
  created_at: string;
}

function toResolvedLine(row: DbRow): ResolvedLine {
  return {
    id: row.id,
    sessionId: row.session_id,
    captureId: row.capture_id,
    lineIndex: row.line_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    text: row.text,
    rawSpeakerLabel: row.raw_speaker_label,
    speakerOverrideId: row.speaker_override_id,
    resolvedSpeaker: row.resolved_speaker,
    createdAt: row.created_at,
  };
}

export async function loadResolvedLineById(id: string): Promise<ResolvedLine | null> {
  const sql = getPostgresClient();
  const rows = await sql<DbRow[]>`
    SELECT
      l.id, l.session_id, l.capture_id, l.line_index, l.start_ms, l.end_ms,
      l.text, l.raw_speaker_label, l.speaker_override_id,
      COALESCE(sov.name, ssm_session.name, ssm_space.name, l.raw_speaker_label) AS resolved_speaker,
      l.created_at
    FROM lines l
    LEFT JOIN speakers sov ON sov.id = l.speaker_override_id
    LEFT JOIN session_speaker_mappings ssm_sj
      ON ssm_sj.session_id = l.session_id AND ssm_sj.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_session ON ssm_session.id = ssm_sj.speaker_id
    INNER JOIN sessions s ON s.id = l.session_id
    LEFT JOIN space_speaker_mappings ssm_sp
      ON ssm_sp.space_id = s.space_id AND ssm_sp.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_space ON ssm_space.id = ssm_sp.speaker_id
    WHERE l.id = ${id}
  `;
  return rows[0] ? toResolvedLine(rows[0]) : null;
}

export async function loadResolvedLinesForSession(sessionId: string): Promise<ResolvedLine[]> {
  const sql = getPostgresClient();
  const rows = await sql<DbRow[]>`
    SELECT
      l.id, l.session_id, l.capture_id, l.line_index, l.start_ms, l.end_ms,
      l.text, l.raw_speaker_label, l.speaker_override_id,
      COALESCE(sov.name, ssm_session.name, ssm_space.name, l.raw_speaker_label) AS resolved_speaker,
      l.created_at
    FROM lines l
    LEFT JOIN speakers sov ON sov.id = l.speaker_override_id
    LEFT JOIN session_speaker_mappings ssm_sj
      ON ssm_sj.session_id = l.session_id AND ssm_sj.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_session ON ssm_session.id = ssm_sj.speaker_id
    INNER JOIN sessions s ON s.id = l.session_id
    LEFT JOIN space_speaker_mappings ssm_sp
      ON ssm_sp.space_id = s.space_id AND ssm_sp.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_space ON ssm_space.id = ssm_sp.speaker_id
    WHERE l.session_id = ${sessionId}
    ORDER BY l.line_index ASC
  `;
  return rows.map(toResolvedLine);
}

export async function loadResolvedLinesByIds(ids: string[]): Promise<ResolvedLine[]> {
  if (ids.length === 0) return [];
  const sql = getPostgresClient();
  const rows = await sql<DbRow[]>`
    SELECT
      l.id, l.session_id, l.capture_id, l.line_index, l.start_ms, l.end_ms,
      l.text, l.raw_speaker_label, l.speaker_override_id,
      COALESCE(sov.name, ssm_session.name, ssm_space.name, l.raw_speaker_label) AS resolved_speaker,
      l.created_at
    FROM lines l
    LEFT JOIN speakers sov ON sov.id = l.speaker_override_id
    LEFT JOIN session_speaker_mappings ssm_sj
      ON ssm_sj.session_id = l.session_id AND ssm_sj.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_session ON ssm_session.id = ssm_sj.speaker_id
    INNER JOIN sessions s ON s.id = l.session_id
    LEFT JOIN space_speaker_mappings ssm_sp
      ON ssm_sp.space_id = s.space_id AND ssm_sp.raw_speaker_label = l.raw_speaker_label
    LEFT JOIN speakers ssm_space ON ssm_space.id = ssm_sp.speaker_id
    WHERE l.id = ANY(${ids})
  `;
  return rows.map(toResolvedLine);
}

export async function lineIdsForSpaceLabel(
  spaceId: string,
  rawLabel: string,
): Promise<string[]> {
  const sql = getPostgresClient();
  const rows = await sql<{ id: string }[]>`
    SELECT l.id
    FROM lines l
    INNER JOIN sessions s ON s.id = l.session_id
    WHERE s.space_id = ${spaceId}
      AND l.raw_speaker_label = ${rawLabel}
  `;
  return rows.map((r) => r.id);
}

export async function lineIdsForSessionLabel(
  sessionId: string,
  rawLabel: string,
): Promise<string[]> {
  const sql = getPostgresClient();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM lines
    WHERE session_id = ${sessionId}
      AND raw_speaker_label = ${rawLabel}
  `;
  return rows.map((r) => r.id);
}

export async function gatherEmbeddingsForSpaceLabel(
  spaceId: string,
  rawLabel: string,
): Promise<number[][]> {
  const sql = getPostgresClient();
  const rows = await sql<{ embedding: number[] }[]>`
    SELECT l.embedding
    FROM lines l
    INNER JOIN sessions s ON s.id = l.session_id
    WHERE s.space_id = ${spaceId}
      AND l.raw_speaker_label = ${rawLabel}
      AND l.embedding IS NOT NULL
  `;
  return rows
    .map((r) => r.embedding)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
}

export async function getSessionsForSpace(spaceId: string): Promise<string[]> {
  const sql = getPostgresClient();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sessions WHERE space_id = ${spaceId}
  `;
  return rows.map((r) => r.id);
}
