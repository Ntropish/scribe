CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_sub TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  groups TEXT[] NOT NULL DEFAULT '{}'::text[],
  managed_agents TEXT[] NOT NULL DEFAULT '{}'::text[],
  access_token TEXT,
  refresh_token TEXT,
  picture TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oidc_login_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
