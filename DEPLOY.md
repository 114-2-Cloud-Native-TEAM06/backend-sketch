# Deployment Guide

This repository now uses a split backend architecture. Do not deploy it as the
old single `src/index.ts` application; that entrypoint has been removed.

## Current Services

| Service | Default port | Entry point | Responsibility |
|---|---:|---|---|
| `chat-service` | 8080 | `services/chat-service/src/main.ts` | Chat REST APIs and REST message creation |
| `user-service` | 8082 | `services/user-service/src/main.ts` | Auth and user REST APIs |
| `notification-service` | 8083 | `services/notification-service/src/main.ts` | Notification API/health service |
| `realtime-service` | 8081 | `services/realtime-service/src/main.ts` | WebSocket `/ws/chat` |
| `message-writer-service` | internal | `services/message-writer-service/src/main.ts` | JetStream consumer that persists async message writes |
| `postgres` | 5432 | `postgres:16-alpine` | Primary database |
| `redis` | 6379 | `redis:7-alpine` | Presence, rate limits, idempotency cache, room fanout |
| `nats` | 4222 / 8222 | `nats:2.10-alpine` | JetStream message-write queue and monitor |

## Local Full Stack

Start the default local stack:

```bash
docker compose up --build -d
```

Apply Prisma migrations and generate the client after PostgreSQL is healthy:

```bash
docker compose exec user-service npx prisma migrate deploy
docker compose exec user-service npx prisma generate
```

Health checks:

```bash
curl http://localhost:8080/health
curl http://localhost:8082/health
curl http://localhost:8083/health
curl http://localhost:8222/healthz
```

WebSocket endpoint:

```text
ws://localhost:8081/ws/chat?token=<jwt>
```

## Split Compose Files

The root `docker-compose.yml` is the normal local developer stack. The split
compose files are useful when starting infrastructure and services separately:

```bash
docker network create backend-sketch-net
docker compose -f compose.postgres.yml up -d
docker compose -f compose.redis.yml up -d
docker compose -f compose.nats.yml up -d
docker compose -f compose.api.yml up --build -d
docker compose -f compose.writer.yml up --build -d
docker compose -f compose.realtime-2.yml up --build -d
```

Use `compose.realtime.yml` for a single realtime instance, or
`compose.realtime-2.yml` for two realtime instances behind the nginx gateway in
`ops/nginx/realtime-2.conf`.

## Required Environment Variables

All application services require:

```text
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<postgres-host>:5432/<db>
REDIS_URL=redis://<redis-host>:6379
JWT_SECRET=<strong-secret>
API_VERSION=1
```

NATS-backed services (`realtime-service` and `message-writer-service`) require:

```text
NATS_URL=nats://<nats-host>:4222
```

Service ports can be overridden when needed:

```text
CHAT_SERVICE_PORT=8080
USER_SERVICE_PORT=8082
NOTIFICATION_SERVICE_PORT=8083
WS_PORT=8081
```

Writer tuning variables:

```text
MESSAGE_WRITER_BATCH_SIZE=250
MESSAGE_WRITER_BATCH_FLUSH_MS=50
MESSAGE_WRITER_BATCH_CONCURRENCY=4
MESSAGE_WRITER_MAX_MESSAGES=512
MESSAGE_WRITE_MAX_ACK_PENDING=4096
MESSAGE_WRITE_MAX_DELIVER=5
MESSAGE_WRITE_ACK_WAIT_MS=30000
MESSAGE_WRITER_DISABLE_FANOUT=false
```

Set `MESSAGE_WRITER_DISABLE_FANOUT=false` when the writer should drain
`MessageOutbox` and publish `message.created` events to Redis for realtime
instances. The local default currently disables writer fanout in the main
compose file unless this environment variable is overridden.

## Production Deployment Shape

Deploy these as separate processes or containers:

1. PostgreSQL
2. Redis
3. NATS with JetStream enabled
4. `user-service`
5. `chat-service`
6. `notification-service`
7. one or more `realtime-service` replicas
8. one or more `message-writer-service` replicas

Expose only the public application ports:

| Public surface | Service | Port |
|---|---|---:|
| Chat REST | `chat-service` | 8080 |
| Auth/User REST | `user-service` | 8082 |
| Notification API | `notification-service` | 8083 |
| WebSocket | `realtime-service` or gateway | 8081 |

Keep PostgreSQL, Redis, NATS client port `4222`, and NATS monitor port `8222`
private unless the platform requires temporary operational access.

## NATS Setup

NATS must run with JetStream enabled. The local full stack uses:

```yaml
command: ["-js", "-sd", "/data/jetstream", "-m", "8222"]
```

The split `compose.nats.yml` enables JetStream and monitoring with:

```yaml
command: ["-js", "-m", "8222"]
```

The application creates the `MESSAGE_WRITES` stream and `message-writer`
durable consumer on startup, so no manual stream bootstrap is required.

## Database Migration

Run migrations once per deployment before serving traffic:

```bash
npx prisma migrate deploy
npx prisma generate
```

In the current Docker setup, run this from `user-service` because it already has
the backend source mounted and shares the same database URL:

```bash
docker compose exec user-service npx prisma migrate deploy
docker compose exec user-service npx prisma generate
```

## Smoke Test

1. Register or log in through `user-service` on port `8082`.
2. Create/read chats through `chat-service` on port `8080`.
3. Connect to `ws://<host>:8081/ws/chat?token=<jwt>`.
4. Send a WebSocket `send` frame.
5. Confirm the client receives an `ack`.
6. Confirm the message appears in `GET /api/v1/chats/:id/messages`.
7. Check writer logs for `message_writer_metrics` and confirm NATS backlog drains.

## Operational Notes

- The realtime service publishes WebSocket message-write commands to NATS.
- The writer service consumes the JetStream queue, persists messages in
  PostgreSQL, updates room ordering, and optionally drains the outbox to Redis.
- Redis is still required for presence, rate limits, idempotency cache, and
  cross-instance room event fanout.
- The generated load-test data under `load/reports/` and
  `backend/load-tests/generated/` is local output and should not be committed.
