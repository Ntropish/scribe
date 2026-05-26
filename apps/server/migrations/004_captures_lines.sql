CREATE TABLE IF NOT EXISTS captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capture_index INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  UNIQUE (session_id, capture_index)
);

CREATE INDEX IF NOT EXISTS idx_captures_session
  ON captures (session_id, capture_index);

CREATE TABLE IF NOT EXISTS lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  raw_speaker_label TEXT NOT NULL,
  -- FK constraint added in the Speakers migration once that table exists.
  speaker_override_id UUID,
  embedding REAL[],
  text_search TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, line_index)
);

CREATE INDEX IF NOT EXISTS idx_lines_text_search
  ON lines USING GIN (text_search);

CREATE INDEX IF NOT EXISTS idx_lines_session_start
  ON lines (session_id, start_ms);
