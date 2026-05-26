# scribe

Trivorn transcription app. Sessions in spaces, Whisper transcription with speaker diarization, group-based ACLs, MCP for agent access.

## Layout

```
apps/server/         Hono + socket.io + MCP + SPA host
apps/web/            React + Vite SPA (TanStack Router)
packages/shared/     zod schemas, shared types
migrations/          Postgres migrations (run at container startup)
docker/              docker-compose.yml
```

## Stack

Bun, Hono, socket.io, React, TanStack Router, Postgres, Auth Core OIDC, MCP. Whisper transcription runs on a separate LAN service ([whisper-stream](https://github.com/Ntropish/whisper-stream)).

## Develop

```sh
cp .env.example .env
cp .bunfig.toml.example .bunfig.toml   # paste your repo.trivorn.org token
bun install
bun run dev
```

## Deploy

`main` deploys to https://scribe.trivorn.org via `.github/workflows/deploy.yml`. Never deploy manually.

Design doc: [design.md](./design.md).
