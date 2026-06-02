# Scalability Optimization Notes

Date: 2026-06-01
Branch: scalability-benchmark-optimizations

## Evaluation Focus

The target evaluation criteria is architecture and scalability:

- Handle tens of thousands of concurrent online users.
- Support roughly 1,000 users sending one message per second.

The previous observed load-test result reached high send volume but was not stable:

- `ws-chat-load-20260601165249`: 100 users, 3,180 msg/sec average send rate.
- Ack p95: 6.47s.
- Ack error rate: 22.86%.
- DB persisted ratio from manual count: about 89.0%.

## Optimization 1: O(1) User Socket Index And Targeted User Fanout

Files:

- `backend/src/modules/realtime/realtime.service.ts`
- `backend/src/modules/realtime/realtime.server.ts`

Before this change, `hasOpenSocketForUser(userId)` scanned every connected socket. That becomes expensive when connect and close events happen under thousands of concurrent WebSocket clients.

Persisted and failed status events are acknowledgements for the sender. Broadcasting them to the whole room also multiplies status traffic by room size.

Change:

- Added `userSockets: Map<string, Set<WebSocket>>`.
- Updated `addClient` and `removeClient` to maintain the user socket index.
- Changed `hasOpenSocketForUser` to inspect only sockets for the target user.
- Added `broadcastToUser` for targeted server events.
- Changed `message_status` persisted and failed events to use `broadcastToUser(event.sender_id, ...)`.

Expected impact:

- Faster connect and close handling.
- Lower CPU cost as concurrent online users increase.
- Better fit for multi-device users because user-level lookup no longer scans the whole connection set.
- Fewer unnecessary WebSocket frames during high message throughput.

## Optimization 2: Backpressure Guard For Server Sends

Files:

- `backend/src/modules/realtime/realtime.server.ts`
- `backend/src/modules/realtime/realtime.service.ts`

Large fanout or slow clients can make `ws.send()` queue data faster than the network can flush it. Without a guard, memory can grow and hurt healthy clients.

Change:

- Added `WS_SEND_BUFFER_LIMIT_BYTES`.
- Default limit: `1048576` bytes.
- If a socket exceeds the limit, the server closes it with code `1013` and reason `backpressure`.

Expected impact:

- Protects the WebSocket server from slow-client memory pressure.
- Keeps high-load tests from being dominated by a small number of stuck sockets.
- Makes overload behavior explicit and measurable.

## Optimization 3: Configurable Room Preload On WebSocket Connect

Files:

- `backend/src/modules/realtime/realtime.server.ts`
- `docker-compose.yml`

The original WebSocket connect path queried all room memberships for every user immediately after connect. That is useful for normal app behavior, but it makes a pure concurrent-online benchmark depend heavily on database reads.

Change:

- Added `WS_PRELOAD_ROOMS`.
- Default: `true`, preserving current product behavior.
- Set `WS_PRELOAD_ROOMS=false` when measuring raw concurrent WebSocket online capacity.

Expected impact:

- Lets scalability benchmarks isolate long-lived WebSocket connection capacity from room-membership DB lookup cost.
- Keeps existing message fanout behavior available in normal mode.

## Benchmark

New benchmark script:

```bash
sh load/evaluation-criteria-benchmark.sh
```

This benchmark produces:

```text
load/reports/evaluation-criteria-benchmark-<RUN_PREFIX>.md
```

It runs two evaluation-aligned tests:

1. Online ceiling test for concurrent WebSocket users.
2. Throughput test using 1,000 users, each sending one message per second.

The summary markdown is written after the online stage and refreshed after the throughput stage. If a high online step fails during k6 `setup()`, the benchmark still continues to the throughput stage so the `1,000 users x 1 msg/sec` result is not skipped.

Recommended command for the architecture/scalability evaluation:

```bash
WS_PRELOAD_ROOMS=false docker compose up -d --force-recreate app

API_HEALTH_TIMEOUT_SECONDS=120 \
API_BASE=http://host.docker.internal:8080 \
WS_BASE=ws://host.docker.internal:8081 \
ONLINE_USER_STEPS="1000 5000 10000 20000" \
THROUGHPUT_USERS=1000 \
THROUGHPUT_SEND_INTERVAL_MS=1000 \
sh load/evaluation-criteria-benchmark.sh
```

`API_HEALTH_TIMEOUT_SECONDS=120` gives the app container time to finish restarting after `--force-recreate`. Without this wait, k6 can enter `setup()` before REST `/health` is ready and produce a misleading zero-connection report.

Pass thresholds used by the benchmark:

| Area | Metric | Threshold |
|---|---:|---:|
| Concurrent online users | connect success rate | >= 99% |
| Concurrent online users | unexpected close | <= 0 |
| Concurrent online users | pong success rate | >= 95% |
| Concurrent online users | pong p95 | <= 1s |
| 1,000 users x 1 msg/sec | ack error rate | <= 1% |
| 1,000 users x 1 msg/sec | ack p95 | <= 1s |
| 1,000 users x 1 msg/sec | DB persisted ratio | >= 98% |

## How To Interpret Results

If the online ceiling passes but throughput fails, the WebSocket connection layer is healthy and the bottleneck is likely message persistence, NATS, or PostgreSQL.

If the online ceiling fails early, inspect:

- Docker CPU and memory limits.
- `ulimit -n`.
- WebSocket close codes.
- Node process memory.
- Postgres load during connect if `WS_PRELOAD_ROOMS=true`.

If throughput fails with high ack p95 or low DB ratio, inspect:

- NATS JetStream backlog.
- DB writer throughput.
- Prisma connection pool.
- PostgreSQL CPU, locks, and disk I/O.
- `lastMessageAt` update frequency.
