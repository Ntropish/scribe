# Scribe: design doc

The app lets a user record audio in a browser, runs it through the LAN
whisper-stream service for transcription with speaker detection, and stores
transcripts organized by **space → session → line**, with per-space group
ACLs mirroring Docs. Agents reach transcripts via an MCP server.

## Decisions

| Q | Decision |
|---|----------|
| 1. Name | **Scribe**. Repo / domain: `scribe`. |
| 2. Speaker enrollment | **B2a**: extend whisper-stream with persistent speaker enrollment keyed by space + name. Service returns known speaker identifiers in the `final` frame. |
| 3. Deploy target | **Space**, at `scribe.trivorn.org`. App server reaches Desk's whisper-stream over the home LAN (`ws://10.0.0.26:8765`, IP discovery via env var). |
| 4. Audio bytes | **Text only**. No PCM persistence. |
| 5. Pause semantics | **P1, soft pause**: the Socket.IO connection stays open across pause so the client keeps getting updates and the service's speaker state is preserved. |
| 6. Client transport | **Socket.IO** between browser and app server. App server bridges to raw WebSocket on the LAN side. |

## Conceptual model

| Concept | Role |
|---------|------|
| Space | Top-level grouping with group-based access (mirrors Docs). Owner + grants of `viewer`/`editor`/`owner` to Auth Core groups. Sessions are created inside a space. |
| Session | One recording. Owned by the creator, lives in one space, has a state (`recording` / `paused` / `stopped` / `finalized`). |
| Capture | A single WS connection's worth of audio. A session can contain multiple captures across pause/resume cycles. |
| Line | One finalized utterance from whisper-stream: `start_ms`, `end_ms`, `text`, raw `speaker_label` from the model (per-capture scope). |
| Speaker | The named person assigned to a line. Three precedence tiers: line-level override → session-level mapping → space-level mapping → fall back to raw label. |

A line's *displayed* speaker is resolved at read time by walking the tiers
most-specific-first; nothing is denormalized into the line row.

## Architecture

```
Browser  ──(Socket.IO over WSS)──▶  Space: scribe app server (Hono + socket.io)
                                       │
                                       │  shared Postgres (Space)
                                       │
                                       └──(raw WS over LAN)──▶  Desk: whisper-stream :8765
```

- App server lives on Space alongside comms, docs, auth-core.
- Browser talks to it as `scribe.trivorn.org` via the existing Cloudflare tunnel pattern.
- Server-to-Postgres uses the shared cluster on Space (same as docs).
- App server reaches whisper-stream on Desk over the home LAN. No tunnel, no public exposure of the python service. IP comes from `WHISPER_STREAM_URL` env var; LAN DHCP means the value can shift, so the deploy config reads it from the same place comms/docs read their secrets.
- Whisper-stream stays on Desk. It's a service, not a deployable app. It needs the persistent-enrollment extension (B2a). The service starts manually on Desk; autostart was considered and rejected. Cross-tunnel auth / WSS aren't needed while the only client is Space-on-LAN.

## Data model (Postgres on Space)

```sql
CREATE TABLE spaces (
  id UUID PK,
  slug TEXT UNIQUE,
  name TEXT,
  visibility TEXT CHECK (visibility IN ('private','public')),
  created_by_sub TEXT,
  created_at, updated_at, archived_at
);

CREATE TABLE space_grants (              -- mirrors docs.space_grants
  id UUID PK,
  space_id UUID FK,
  group_name TEXT,
  role TEXT CHECK (role IN ('owner','editor','viewer')),
  UNIQUE (space_id, group_name)
);

CREATE TABLE sessions (
  id UUID PK,
  space_id UUID FK,
  title TEXT,
  state TEXT CHECK (state IN ('recording','paused','stopped','finalized')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  finalized_by_sub TEXT,
  created_by_sub TEXT,
  created_at, updated_at
);

CREATE TABLE captures (                  -- one row per WS connection
  id UUID PK,
  session_id UUID FK,
  capture_index INTEGER,                 -- 0,1,2,... within session
  started_at TIMESTAMPTZ,                -- client wall-clock at WS open
  ended_at TIMESTAMPTZ,
  UNIQUE (session_id, capture_index)
);

CREATE TABLE lines (
  id UUID PK,
  session_id UUID FK,
  capture_id UUID FK,
  line_index INTEGER,                    -- 0,1,2,... within session
  start_ms INTEGER,                      -- ms since session start
  end_ms INTEGER,
  text TEXT,
  raw_speaker_label TEXT,                -- e.g. "Speaker 1" from whisper-stream
  speaker_override_id UUID,              -- nullable, line-level pin
  text_search TSVECTOR GENERATED ALWAYS AS
    (to_tsvector('english', text)) STORED,
  created_at TIMESTAMPTZ,
  UNIQUE (session_id, line_index)
);
CREATE INDEX ON lines USING GIN (text_search);
CREATE INDEX ON lines (session_id, start_ms);

CREATE TABLE speakers (
  id UUID PK,
  space_id UUID FK,
  name TEXT,                             -- "Justin", "Zina", ...
  UNIQUE (space_id, name)
);

CREATE TABLE space_speaker_mappings (    -- "in this space, raw=X → speaker"
  space_id UUID FK,
  raw_speaker_label TEXT,                -- only usable if labels are stable across sessions; see Q2
  speaker_id UUID FK,
  PRIMARY KEY (space_id, raw_speaker_label)
);

CREATE TABLE session_speaker_mappings (  -- "in this session, raw=X → speaker"
  session_id UUID FK,
  raw_speaker_label TEXT,
  speaker_id UUID FK,
  PRIMARY KEY (session_id, raw_speaker_label)
);
```

Resolution at read time, per line:

```
display_speaker = first non-null of:
  line.speaker_override_id                                       (line tier)
  session_speaker_mappings[line.raw_speaker_label]               (session tier)
  space_speaker_mappings[line.raw_speaker_label]                 (space tier)
  raw_speaker_label                                              (fallback)
```

The space tier only carries meaning if `raw_speaker_label` is stable across
captures and sessions. With the current service, it's not (see Q2).

## Speaker model

Whisper-stream today emits `"Speaker 1"`, `"Speaker 2"`, ... stable inside
one WS connection and unrelated across connections. The v1 service
extension (decision Q2 = B2a) adds **persistent enrollment**:

- On the service: store pyannote 512-dim embeddings keyed by `(space_id,
  speaker_name)`. The WS `start` handshake gains a `space_id` field so the
  service can load the right enrolled set.
- For each final utterance, the service runs cosine similarity against the
  enrolled embeddings for the space. If the best match passes the
  speaker_threshold, the `final` frame carries `speaker_name` (the enrolled
  name). Otherwise it falls back to a per-connection placeholder
  (`"Speaker 1"`, `"Speaker 2"`, ...) as before.
- New enrollment is driven by the app: when a user assigns a name to a
  speaker label inside a session, the app POSTs the per-line embeddings
  for that label up to whisper-stream's enrollment endpoint, which folds
  them into the space's centroid for that name.

This means `raw_speaker_label` in the `lines` table is sometimes a
human-readable name (matched at the service) and sometimes a placeholder
(`"Speaker 1"`). The three-tier resolution still applies: a line-level
override or session/space mapping wins over whatever the service emitted.

Service surface additions (proposed):

```
POST  /enroll          { space_id, speaker_name, embeddings: float32[][] }
GET   /enrolled?space_id=...
DELETE /enrolled/:space_id/:speaker_name
```

These run on the same WS server's HTTP side. They're internal-LAN-only, no
auth at the protocol level; Scribe's app server gates access via its own
Auth Core middleware before relaying.

## Audio capture

Browser:
1. `getUserMedia({audio: true})` with permission gate via the recorder UI.
2. `AudioWorkletNode` downmixes + resamples to 16 kHz mono float32, converts to int16.
3. Joins the per-session Socket.IO room and emits `audio` events carrying int16 PCM buffers (Socket.IO supports binary directly).
4. Listens for `partial` and `final` events from the server.

App server (single Hono + Socket.IO process):
1. On socket connect: authenticate (Auth Core session cookie or bearer), check the user has at least `viewer` on the session's space, join room `session:<id>`.
2. On socket `start`: open a raw WS to `WHISPER_STREAM_URL`, send the service's `start` JSON with `language` and `space_id`. Create a new `captures` row, capture_index = max+1.
3. On socket `audio`: forward the int16 PCM as a binary frame to the service WS.
4. On service `partial`: broadcast as `partial` event into the session room (no DB write).
5. On service `final`: stamp `start_ms` / `end_ms` from the capture's `started_at`, insert a row into `lines`, broadcast `line` into the session room.
6. On socket `pause`: stop forwarding audio but keep the service WS open (P1).
7. On socket `stop` or disconnect: send `{type: "stop"}` to the service WS, close it, mark capture `ended_at`.

Multiple browsers can join the same session room (e.g. the recorder's phone plus a watching laptop) and all see partials and finals as they arrive. Only one socket per session is the designated **recorder**; others are observers. The recorder lock is taken on `start` and released on disconnect.

## Pause / resume / finalize

| Action | What happens |
|--------|--------------|
| Pause | Recorder client emits `pause`. App server stops forwarding audio frames to the service WS but keeps it open. Session state stays `recording` while the WS is alive; we don't need a separate `paused` value, but we expose `is_audio_flowing` in the session payload for UX. |
| Resume | Recorder client emits `resume`. App server resumes forwarding. Same capture row, same service speaker state. |
| Stop | Recorder client emits `stop` (or disconnects). App server closes the service WS, marks capture `ended_at`, session moves to `stopped`. |
| Finalize | Authorized user posts to `/api/sessions/:id/finalize`. `state = 'finalized'`, no further edits to lines / speaker mappings / title. Admins (`groups.admin`) can post to `/api/sessions/:id/unfinalize` to clear it. |

The service WS stays open across pauses, so its per-connection speaker
state persists; once enrollment lands the resolved speaker names are
stable across pauses by construction.

## HTTP + Socket.IO surface

REST (Hono), all auth via Auth Core session cookie or `Authorization: Bearer <jwt>`:

```
GET    /api/spaces
POST   /api/spaces
GET    /api/spaces/:slug
PATCH  /api/spaces/:slug
GET    /api/spaces/:slug/grants
PUT    /api/spaces/:slug/grants/:group
DELETE /api/spaces/:slug/grants/:group

GET    /api/spaces/:slug/sessions          ?from=, ?to=, ?q=
POST   /api/spaces/:slug/sessions
GET    /api/sessions/:id                   includes lines
PATCH  /api/sessions/:id                   title, etc.
POST   /api/sessions/:id/finalize
POST   /api/sessions/:id/unfinalize        admin-only

GET    /api/spaces/:slug/speakers
POST   /api/spaces/:slug/speakers
PUT    /api/spaces/:slug/speaker-mappings/:rawLabel
PUT    /api/sessions/:id/speaker-mappings/:rawLabel
PUT    /api/lines/:id/speaker              line-level override

GET    /api/search                         ?q=, ?space=, ?from=, ?to=
```

Socket.IO (same node http server, mounted at default `/socket.io/`):

| Direction | Event | Payload |
|-----------|-------|---------|
| client→server | `join` | `{ session_id }` |
| client→server | `start` | `{ session_id, language? }`. Recorder asks for the recorder lock. |
| client→server | `audio` | `ArrayBuffer` of int16 PCM 16kHz mono. |
| client→server | `pause` | `{}` |
| client→server | `resume` | `{}` |
| client→server | `stop` | `{}` |
| server→client | `state` | `{ session_id, state, is_audio_flowing, recorder_socket_id }`. Initial + on change. |
| server→client | `partial` | `{ text, capture_id }` |
| server→client | `line` | The full line row (id, line_index, start_ms, end_ms, text, raw_speaker_label, resolved speaker). |
| server→client | `line_updated` | When a speaker mapping changes resolves an existing line differently. |
| server→client | `error` | `{ message }` for recoverable errors (e.g. recorder already taken). |

## MCP surface

Mounted at `/mcp` with the same Auth Core bearer flow as docs and comms.
Tools scoped to "view transcripts in spaces the caller can access":

| Tool | Returns |
|------|---------|
| `list_spaces` | Accessible spaces (id, slug, name). |
| `list_sessions` | Sessions in a space, with optional date filter. |
| `get_session` | One session including resolved lines (text + display speaker + timestamps). |
| `search` | Text search across lines, with optional `space`, `from`, `to` filters. Returns matched lines with snippet + session context. |
| `list_speakers` | Named speakers known in a space. |

No write tools in v1. Agents observe; humans correct.

## Search

Mirrors video-inspector + docs: `to_tsvector('english', text)` STORED on
`lines`, `websearch_to_tsquery` for parsing, `ts_rank` for ordering,
`ts_headline` for the snippet. Date filtering on `sessions.started_at`.
Access filtering via `space_grants` join with `group_name = ANY(auth.groups)`,
plus the owner/admin/managed-agent bypasses already used in docs.

## Deployment

Same `.github/workflows/deploy.yml` pattern as the other Trivorn services.
Deploy target depends on Q3 (Desk vs Space). Postgres migrations run at
container startup. Verdaccio pulls happen via the same client-credentials
flow already wired into the CI Package Registry service client.

## Stack

- React + Vite (SPA)
- TanStack Router
- Hono (REST + SPA host)
- socket.io / socket.io-client (real-time)
- @modelcontextprotocol/sdk (MCP)
- Drizzle ORM + raw SQL for full-text bits, same as docs
- Postgres (shared cluster on Space)
- whisper-stream on Desk for transcription

## Tooling

- Bun
- Auth Core OIDC (server-side session cookies on the SPA, JWT bearers on MCP)
- @trivorn/* packages via Verdaccio at repo.trivorn.org
- Playwright for end-to-end smoke

## Repo layout (proposed)

```
apps/
  server/    Hono API + MCP endpoint + SPA host
  web/       React SPA
packages/
  shared/    zod schemas + types
migrations/  Postgres migrations
docker/      Dockerfile, docker-compose.yml
```

## Remaining open questions

1. **Whisper-stream hardening scope.** Beads against whisper-stream that
   we need before v1:
   - Persistent speaker enrollment (B2a). Required. In flight.
   - Autostart on Desk: rejected. Service starts manually.
   - Token auth at the WS handshake. Not strictly required since the only
     consumer is Space-on-LAN; defer.
   - WSS termination. Not needed for Space to Desk over LAN; defer.
   - Crash recovery on the service. Defer; app server handles reconnect.

2. **Admin group.** Default to `groups.admin` as in docs unless you want a
   dedicated `scribe-admin` group.

3. **Audio worklet packaging.** Inline in the SPA for v1, extract to
   `@trivorn/audio-capture` only if a second consumer appears. Not a v1
   blocker.

4. **Recorder lock UX.** When a second client opens a session that already
   has an active recorder, do we offer "take over" (kicks the first
   recorder) or hard-deny? Hard-deny is simpler; take-over matches
   multi-device habits.

5. **MCP `search` audience.** The MCP tool walks the same access path as
   the REST search. Confirm agents searching get the same group-based
   filtering humans do, and that `act.sub` (acting-on-behalf-of-user)
   plays the same role as in docs.
