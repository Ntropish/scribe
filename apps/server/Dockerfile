FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=bunfig,target=/app/bunfig.toml \
    bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared/
COPY apps/web apps/web/
RUN cd apps/web && bun run build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=bunfig,target=/app/bunfig.toml \
    bun install --production --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared/
COPY apps/server apps/server/
COPY --from=builder /app/apps/web/dist apps/web/dist/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["bun", "apps/server/src/index.ts"]
