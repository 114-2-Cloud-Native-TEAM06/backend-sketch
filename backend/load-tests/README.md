# Phased Bottleneck Load Tests

These scripts split the path into measurable stages:

```txt
realtime ingress -> NATS publish -> writer consume -> DB write -> Redis fanout
```

Run compose commands from the repository root unless the command explicitly changes into `backend`.

Always reset state before formal comparison:

```bash
docker compose -f compose.writer.yml down
docker compose -f compose.realtime.yml down
docker compose -f compose.api.yml down
docker compose -f compose.nats.yml down -v
docker compose -f compose.redis.yml down -v
docker compose -f compose.postgres.yml down -v
docker network inspect backend-sketch-net >/dev/null 2>&1 || docker network create backend-sketch-net
docker compose -f compose.postgres.yml up -d --wait
docker compose -f compose.redis.yml up -d --wait
docker compose -f compose.nats.yml up -d --wait
docker compose -f compose.api.yml up -d --build
docker compose -f compose.api.yml exec user-service npx prisma migrate deploy
cd backend && npm run load:seed
npm run load:snapshot
```

Bring up `compose.realtime.yml` and `compose.writer.yml` only for the stage that needs them. PostgreSQL, Redis, and NATS are separate compose projects, but all runtime compose files share the external `backend-sketch-net` network, so service URLs remain `postgres:5432`, `redis:6379`, and `nats:4222`.

## Common Metrics

- k6: sent frames, received ACKs, ACK errors, `ws_ack_latency_ms`, connect status.
- Realtime logs: JSON lines with `event=realtime_metrics`, including `ws_connected`, `send_frame_received`, `nats_publish_*`, `ack_sent`, `publish_latency_ms`, `ack_latency_ms`, and `event_loop_lag_ms`.
- Writer logs: JSON lines with `event=message_writer_metrics`, including batch counts, batch duration, commands persisted/sec, split count, failures, and queue state.
- Snapshot: `npm run load:snapshot` prints DB counts and JetStream stream/consumer backlog.

## Stage A: Realtime Ingress Only

Start realtime with:

```bash
REALTIME_DISABLE_NATS_PUBLISH=true docker compose -f compose.realtime.yml up -d --build
```

Then run bounded k6:

```bash
cd backend
WS_VUS=50 WS_DURATION=2m WS_MAX_PENDING=25 npm run load:ws:bounded
WS_VUS=100 WS_DURATION=2m WS_MAX_PENDING=25 npm run load:ws:bounded
WS_VUS=150 WS_DURATION=2m WS_MAX_PENDING=25 npm run load:ws:bounded
```

If ACK p95 or connection failures are already bad here, the bottleneck is realtime ingress, WebSocket handling, membership lookup, rate limiting, or event-loop pressure.

## Stage B: Realtime To NATS Publish

Run realtime with `REALTIME_DISABLE_NATS_PUBLISH=false` and stop `message-writer-service` so DB consumption does not hide ingress behavior.

```bash
docker compose -f compose.writer.yml down
REALTIME_DISABLE_NATS_PUBLISH=false docker compose -f compose.realtime.yml up -d
cd backend
WS_VUS=50 WS_DURATION=2m WS_MAX_PENDING=25 npm run load:ws:bounded
npm run load:snapshot
```

Compare `send_frame_received`, `nats_publish_succeeded`, and NATS stream `messages`. If realtime receives many frames but publish success or stream growth lags, the bottleneck is realtime -> NATS publish.

## Stage C: NATS To Writer To DB

Skip WebSocket and publish commands directly to JetStream:

```bash
docker compose -f compose.realtime.yml down
docker compose -f compose.writer.yml up -d --build
cd backend
NATS_LOAD_MESSAGES=50000 NATS_LOAD_CONCURRENCY=100 npm run load:nats
NATS_LOAD_MESSAGES=100000 NATS_LOAD_CONCURRENCY=250 npm run load:nats
NATS_LOAD_MESSAGES=200000 NATS_LOAD_CONCURRENCY=500 npm run load:nats
npm run load:snapshot
```

Use only this stage to compare writer implementations, such as raw SQL batch versus Prisma batch.

## Stage D: End To End With Fanout Off

Run all services with:

```bash
REALTIME_DISABLE_NATS_PUBLISH=false docker compose -f compose.realtime.yml up -d
MESSAGE_WRITER_DISABLE_FANOUT=true docker compose -f compose.writer.yml up -d
```

Then run the same bounded k6 gradient and snapshots. If Stage B is healthy but this stage degrades, focus on writer/DB resource contention.

## Stage E: End To End With Fanout On

Run writer with:

```bash
MESSAGE_WRITER_DISABLE_FANOUT=false docker compose -f compose.writer.yml up -d
```

If only this stage degrades, focus on Redis pub/sub and realtime broadcast pressure.
