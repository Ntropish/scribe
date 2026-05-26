# scribe

Transcription app. Architecture:

```
Browser  ──Socket.IO/WSS──▶  Space: scribe (Hono + socket.io)  ──raw WS/LAN──▶  Desk: whisper-stream :8765
                                       │
                                       └── Postgres on Space (shared cluster, `scribe` db)
```

## Layout

- `apps/server/` Hono REST + Socket.IO + MCP + SPA host. Bun runtime.
- `apps/web/` React + Vite + TanStack Router SPA, built into `apps/server/public/` for production.
- `packages/shared/` zod schemas + TS types shared client / server.
- `migrations/` Postgres migrations run at server startup. Sorted alphabetically; `<number>_<name>.sql`.

## Conventions

- All auth flows go through Auth Core. Server-side `scribe_session` cookies for the SPA, Auth Core JWTs for `/mcp`.
- Group-based ACL on spaces mirrors docs: `space_grants(space_id, group_name, role)`. Admin = `groups.admin`.
- Postgres full-text on `lines.text_search` (tsvector STORED generated column). Pattern mirrors video-inspector / docs.
- `@trivorn/*` packages resolve through Verdaccio at `repo.trivorn.org`.
- Deploys are automatic from `main` via `.github/workflows/deploy.yml`. Never deploy manually.

## Definition of Done

`bun run typecheck` exits 0. CI deploy goes green. Manual smoke (login, browse, record a session, see lines arrive) works against the deployed app.
