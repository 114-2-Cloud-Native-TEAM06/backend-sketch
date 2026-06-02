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

The k6 scripts live in `load/` and target the split service ports:

- `USER_API_BASE=http://localhost:8082`
- `CHAT_API_BASE=http://localhost:8080`
- `WS_BASE=ws://localhost:8081`

The dev compose file raises REST rate-limit defaults so k6 setup can create test users and rooms without measuring auth throttling.

### Prepare the Stack

For a clean baseline:

```bash
docker compose down -v
docker compose up --build -d
docker compose exec user-service npx prisma migrate deploy
docker compose exec user-service npx prisma generate
```

Health checks:

```bash
curl http://localhost:8080/health
curl http://localhost:8082/health
curl http://localhost:8083/health
```

### Chat Throughput Smoke Test

With local k6:

```bash
k6 run \
  -e USER_API_BASE=http://localhost:8082 \
  -e CHAT_API_BASE=http://localhost:8080 \
  -e WS_BASE=ws://localhost:8081 \
  -e USERS=10 \
  -e DURATION=30s \
  -e RUN_ID=smoke \
  load/ws-chat-load.js
```

With Docker k6:

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

Reports are written to:

```txt
load/reports/ws-chat-load-<RUN_ID>.txt
load/reports/ws-chat-load-<RUN_ID>.json
load/reports/ws-chat-load-<RUN_ID>.k6-summary.json
```

Validate persisted messages:

```bash
sh load/count-k6-messages.sh <RUN_ID>
```

### Evaluation Criteria Benchmark

For the evaluation criterion "roughly 1,000 users each send one message per second", use this single benchmark as the main result:

```bash
docker run --rm \
  -v "$PWD/load:/scripts" \
  grafana/k6 run \
  -e USER_API_BASE=http://host.docker.internal:8082 \
  -e CHAT_API_BASE=http://host.docker.internal:8080 \
  -e WS_BASE=ws://host.docker.internal:8081 \
  -e API_HEALTH_TIMEOUT_SECONDS=120 \
  -e USERS=1000 \
  -e DURATION=2m \
  -e SEND_INTERVAL_MS=1000 \
  -e SOCKET_LIFE_MS=120000 \
  -e MAX_PENDING_ACKS=20 \
  -e RUN_ID=eval-single-1000u1mps \
  -e REPORT_DIR=/scripts/reports \
  /scripts/ws-chat-load.js
```

This creates 1,000 users, 500 direct rooms, and sends about one message per user per second. Output:

```txt
load/reports/ws-chat-load-eval-single-1000u1mps.txt
load/reports/ws-chat-load-eval-single-1000u1mps.json
load/reports/ws-chat-load-eval-single-1000u1mps.k6-summary.json
```

Validate persisted messages:

```bash
docker compose exec postgres psql -U admin -d imdb -c \
  "SELECT count(*) FROM \"Message\" WHERE \"requestId\" LIKE 'k6-eval-single-1000u1mps-%';"
```

Interpretation checklist:

- WebSocket connect success should be close to 100%.
- Average send rate should be close to 1,000 msg/sec.
- `ack_p95 <= 1s`.
- `ack_error_rate <= 1%`.
- `DB count / messages_sent >= 98%`.

### Evaluation Summary Report

Run the staged helper when you want a supplementary concurrent-online ceiling report plus the 1,000 users x 1 msg/sec throughput benchmark:

```bash
WS_PRELOAD_ROOMS=false docker compose up -d --force-recreate realtime-service-1 realtime-service-2 realtime-gateway

API_HEALTH_TIMEOUT_SECONDS=120 \
USER_API_BASE=http://host.docker.internal:8082 \
CHAT_API_BASE=http://host.docker.internal:8080 \
WS_BASE=ws://host.docker.internal:8081 \
ONLINE_USER_STEPS="1000 5000 10000 20000" \
THROUGHPUT_USERS=1000 \
THROUGHPUT_SEND_INTERVAL_MS=1000 \
sh load/evaluation-criteria-benchmark.sh
```

The helper writes:

```txt
load/reports/evaluation-criteria-benchmark-<RUN_PREFIX>.md
load/reports/online-ceiling-<RUN_PREFIX>-online.csv
load/reports/throughput-ceiling-<RUN_PREFIX>-throughput.csv
```

The Markdown summary maps the result back to all five evaluation criteria: requirements implementation, code quality, architecture/scalability, system testing, and operations/reliability.

### Troubleshooting

If a report says `WebSocket connection attempts: 0`, k6 failed during `setup()` before opening WebSocket connections. Check the REST services first:

```bash
docker compose ps
curl http://localhost:8080/health
curl http://localhost:8082/health
```

Docker k6 targets:

```bash
# Docker Desktop on macOS
USER_API_BASE=http://host.docker.internal:8082 CHAT_API_BASE=http://host.docker.internal:8080 WS_BASE=ws://host.docker.internal:8081

# Linux Docker host
USER_API_BASE=http://172.17.0.1:8082 CHAT_API_BASE=http://172.17.0.1:8080 WS_BASE=ws://172.17.0.1:8081
```

k6 waits for REST `/health` for up to 60 seconds by default. Increase it after a slow rebuild:

```bash
API_HEALTH_TIMEOUT_SECONDS=120 sh load/evaluation-criteria-benchmark.sh
```

### Throughput Ceiling

The helper gradually lowers the send interval and stops at the first unstable result.

Stable defaults:

- `ack_error_rate_percent <= 1`
- `ack_p95_seconds <= 1`
- `db_ratio_percent >= 98`

```bash
sh load/find-throughput-ceiling.sh
```

Tighter example:

```bash
INTERVALS="100 90 80 70 60 50" \
ACK_ERROR_MAX=0.1 \
ACK_P95_MAX=0.5 \
DB_RATIO_MIN=99 \
sh load/find-throughput-ceiling.sh
```

Output:

```txt
load/reports/throughput-ceiling-<RUN_PREFIX>.csv
load/reports/throughput-ceiling-<RUN_PREFIX>.txt
```

### Online Connection Ceiling

This test opens WebSocket connections and periodically sends `ping` frames.

Stable defaults:

- connect success `>= 99%`
- unexpected close `<= 0`
- pong success `>= 95%`
- pong p95 `<= 1s`

```bash
sh load/find-online-ceiling.sh
```

Custom steps:

```bash
USER_STEPS="100 500 1000 1500 2000" sh load/find-online-ceiling.sh
```

Output:

```txt
load/reports/online-ceiling-<RUN_PREFIX>.csv
load/reports/online-ceiling-<RUN_PREFIX>.txt
```

### Useful Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `USER_API_BASE` | `http://localhost:8082` | Auth/user REST target |
| `CHAT_API_BASE` | `http://localhost:8080` | Chat REST target |
| `WS_BASE` | `ws://localhost:8081` | WebSocket target without `/ws/chat` |
| `USERS` | `100` | Chat throughput VUs |
| `DURATION` | `2m` | Test duration |
| `SEND_INTERVAL_MS` | `100` | Per-socket send interval |
| `MAX_PENDING_ACKS` | `1000` | Per-socket backpressure limit |
| `RUN_ID` | `local` | Report and message request ID prefix |
| `REPORT_DIR` | `load/reports` | Report output directory |

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
