# Instant Message System Backend

114-2 Cloud Native

## Local Stack

The backend is split into separate containers:

| Service | Port | Purpose |
|---|---:|---|
| `chat-service` | 8080 | Chat REST APIs |
| `realtime-service` | 8081 | WebSocket `/ws/chat` |
| `user-service` | 8082 | Auth and user REST APIs |
| `notification-service` | 8083 | Notification health/API service |
| `postgres` | 5432 | PostgreSQL |
| `redis` | 6379 | Redis |
| `nats` | 4222 / 8222 | NATS JetStream and monitor |

Start the full stack:

```bash
docker compose up --build -d
```

Apply database migrations after the database is healthy:

```bash
docker compose exec user-service npx prisma migrate deploy
docker compose exec user-service npx prisma generate
```

Verify the HTTP services:

```bash
curl http://localhost:8080/health
curl http://localhost:8082/health
curl http://localhost:8083/health
```

## API Usage

Auth and user APIs are served by `user-service` on port `8082`.

```http
POST http://localhost:8082/api/v1/auth/register
POST http://localhost:8082/api/v1/auth/login
GET  http://localhost:8082/api/v1/users/me
GET  http://localhost:8082/api/v1/users/:id
```

Chat APIs are served by `chat-service` on port `8080`.

```http
POST http://localhost:8080/api/v1/chats
GET  http://localhost:8080/api/v1/chats
GET  http://localhost:8080/api/v1/chats/:id
GET  http://localhost:8080/api/v1/chats/:id/messages?before_message_id=<messageId>&limit=50
```

Both auth endpoints return `{ user, token }`. Include the token in subsequent REST requests:

```http
Authorization: Bearer <token>
```

WebSocket is served by `realtime-service` on port `8081`:

```txt
ws://localhost:8081/ws/chat?token=<token>
```

Client frames include:

```json
{ "type": "send", "request_id": "client-id-1", "chat_id": "<chat-id>", "body": "hello" }
{ "type": "typing", "chat_id": "<chat-id>", "is_typing": true }
{ "type": "ping" }
```

Server frames include `ack`, `message`, `typing`, `presence`, `pong`, and `error`.

## Tests

Run all backend tests inside Docker:

```bash
docker compose --profile test run --rm --build test
```

Run only unit tests:

```bash
docker compose --profile test run --rm test npm run test:unit
```

Run only integration tests:

```bash
docker compose --profile test run --rm test sh -c "npx prisma generate && npx prisma migrate deploy && npm run test:integration"
```

Run TypeScript locally from `backend/`:

```bash
npx tsc --noEmit
```

## Load Testing

The k6 scripts live in `load/`. Defaults target the split service ports:

- `USER_API_BASE=http://localhost:8082`
- `CHAT_API_BASE=http://localhost:8080`
- `WS_BASE=ws://localhost:8081`

The dev compose file raises REST rate-limit defaults so k6 setup can create test users and rooms without measuring auth throttling.

Quick smoke run with local k6:

```bash
k6 run -e USERS=10 -e DURATION=30s load/ws-chat-load.js
```

Docker k6 example:

```bash
docker run --rm -v "$PWD/load:/scripts" grafana/k6 run \
  -e USER_API_BASE=http://host.docker.internal:8082 \
  -e CHAT_API_BASE=http://host.docker.internal:8080 \
  -e WS_BASE=ws://host.docker.internal:8081 \
  -e USERS=10 \
  -e DURATION=30s \
  -e RUN_ID=smoke \
  -e REPORT_DIR=/scripts/reports \
  /scripts/ws-chat-load.js
```

See `load/README.md` and `backend/load-tests/README.md` for staged load-test flows.

## Prisma Studio

```bash
docker compose exec user-service npx prisma studio --hostname 0.0.0.0
```

Then visit `http://localhost:5555`.

## Evaluation Criteria

| Weight | Category | Description |
|---:|---|---|
| 30% | Requirements Implementation | Core and advanced features work correctly |
| 10% | Code Quality | Readability, modularity, security |
| 25% | Architecture and Scalability | Capacity target and k6 load-test report |
| 25% | Testing and Verification | Unit tests, integration tests, correctness validation |
| 10% | Operations and Reliability | Metrics, health indicators, and explanations |
