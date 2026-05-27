# syntax=docker/dockerfile:1.7
#
# NestJS API for production. Built from the monorepo root (Render's
# "Docker context" stays at the repo root; "Dockerfile path" points at
# apps/api/Dockerfile).
#
# Free-tier targets: Render Web Service. Neon Postgres requires TLS, so
# the runtime image keeps OpenSSL — distroless drops it and Prisma fails
# to connect.

ARG NODE_VERSION=20.18.0

# ── deps + build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Cache pnpm install by lockfile + workspace manifests.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile=false --filter api...

# Now copy the rest. Generate Prisma client + build NestJS.
COPY . .
RUN pnpm --filter api exec prisma generate \
 && pnpm --filter api build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

# OpenSSL is required by Prisma at runtime when connecting to a TLS DB
# (Neon, Supabase, etc.). The slim image already ships openssl, but we
# pin ca-certificates so server cert verification works out of the box.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Compiled bundle + node_modules from the build stage.
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/prisma ./prisma

EXPOSE 3001

# Render injects $PORT; Fastify (apps/api/src/main.ts) reads
# process.env.PORT and falls back to 3001 locally.
CMD ["node", "dist/main.js"]
