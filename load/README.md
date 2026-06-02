# WebSocket k6 Load Tests

These scripts test the local multi-service backend:

- user/auth API: `http://localhost:8082`
- chat API: `http://localhost:8080`
- WebSocket: `ws://localhost:8081/ws/chat`

## Prepare the Stack

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

## Chat Throughput Smoke Test

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

## Throughput Ceiling

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

## Online Connection Ceiling

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

## Useful Environment Variables

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
