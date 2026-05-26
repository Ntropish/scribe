CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'recording'
    CHECK (state IN ('recording','paused','stopped','finalized')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  finalized_by_sub TEXT,
  created_by_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_space_started
  ON sessions (space_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_created_by
  ON sessions (created_by_sub);
