FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm

COPY package.json ./
RUN pnpm install --no-frozen-lockfile

COPY tsconfig.json build.mjs ./
COPY src/ ./src/

RUN node build.mjs

FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
