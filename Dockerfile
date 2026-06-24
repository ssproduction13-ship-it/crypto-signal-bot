FROM node:22-alpine AS builder
  WORKDIR /app

  COPY package.json ./
  RUN npm install

  COPY tsconfig.json build.mjs ./
  COPY src/ ./src/

  RUN npm run build

  FROM node:22-alpine
  WORKDIR /app

  COPY --from=builder /app/node_modules ./node_modules
  COPY --from=builder /app/dist ./dist

  ENV NODE_ENV=production
  ENV PORT=8080

  CMD ["node", "--enable-source-maps", "dist/index.mjs"]
  