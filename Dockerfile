FROM node:20-alpine AS base
RUN npm install -g pnpm@9

# ── Builder ──────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY lib/api-zod/package.json         ./lib/api-zod/
COPY lib/api-spec/package.json        ./lib/api-spec/
COPY lib/db/package.json              ./lib/db/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY scripts/package.json             ./scripts/

# Install all deps using the lockfile (no re-resolution)
RUN pnpm install --no-frozen-lockfile

# Copy source and build
COPY lib/         ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
COPY tsconfig.base.json tsconfig.json ./

RUN pnpm --filter @workspace/api-server run build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Built bundle + pino workers
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

# @google/genai is marked external in build.mjs, so it must be in node_modules at runtime
COPY --from=builder /app/node_modules ./node_modules

# Data directory — persists between container restarts, resets only on redeploy
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
