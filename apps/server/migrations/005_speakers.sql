CREATE TABLE IF NOT EXISTS speakers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (space_id, name)
);

CREATE INDEX IF NOT EXISTS idx_speakers_space ON speakers(space_id);

CREATE TABLE IF NOT EXISTS space_speaker_mappings (
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  raw_speaker_label TEXT NOT NULL,
  speaker_id UUID NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, raw_speaker_label)
);

CREATE TABLE IF NOT EXISTS session_speaker_mappings (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  raw_speaker_label TEXT NOT NULL,
  speaker_id UUID NOT NULL REFERENCES speakers(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, raw_speaker_label)
);

ALTER TABLE lines
  ADD CONSTRAINT lines_speaker_override_fk
  FOREIGN KEY (speaker_override_id) REFERENCES speakers(id) ON DELETE SET NULL;
