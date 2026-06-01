# Production image (Zeabur / any PaaS).
# Unlike Dockerfile.dev, this COPIES the source into the image (no bind mount)
# and starts without watch mode. NATS and Redis are optional — the app only
# uses them when NATS_URL / REDIS_URL are set, so a minimal deploy needs just
# DATABASE_URL (Postgres).
FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache openssl

# Install deps against the schema so @prisma/client is generated for musl.
# --include=dev keeps tsx + the prisma CLI even if the platform sets
# NODE_ENV=production (both are needed to run/migrate).
COPY package*.json ./
COPY prisma ./prisma
RUN npm install --include=dev && npx prisma generate

# App source
COPY . .

# REST + WebSocket (expose both so Zeabur can map a domain to each)
EXPOSE 8080 8081

# Apply pending migrations on boot, then start REST(:8080) + WS(:8081).
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/index.ts"]
