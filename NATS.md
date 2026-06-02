# NATS JetStream Architecture

This document describes the NATS implementation that exists in the current
multi-service backend.

## Role In The System

NATS JetStream is used as the durable queue between realtime/chat write paths
and PostgreSQL persistence.

Redis is still used for short-lived realtime coordination:

- presence state
- REST and WebSocket rate limits
- idempotency cache
- `room:<roomId>:events` pub/sub fanout across realtime instances

PostgreSQL remains the source of truth for users, rooms, messages,
`MessageWrite`, and `MessageOutbox`.

## Services That Use NATS

| Service | NATS role |
|---|---|
| `realtime-service` | Publishes async WebSocket message writes to JetStream |
| `message-writer-service` | Durable JetStream consumer that persists commands |

The implementation lives in:

- `backend/packages/shared-nats/src/jetstream-message-buffer.ts`
- `backend/packages/shared-nats/src/message-write-buffer.ts`
- `backend/services/realtime-service/src/modules/realtime/realtime.server.ts`
- `backend/services/message-writer-service/src/main.ts`
- `backend/services/message-writer-service/src/modules/message-writes/message-write.processor.ts`

`chat-service` currently persists the normal REST message route synchronously in
PostgreSQL and publishes Redis room events. It has a buffered helper in
`chats.service.ts`, but the default REST route does not wire a NATS publisher.

## Stream And Subject

The current implementation uses one durable stream:

| Setting | Default |
|---|---|
| Stream | `MESSAGE_WRITES` |
| Subject | `messages.write` |
| Durable consumer | `message-writer` |

These can be overridden with:

```text
MESSAGE_WRITE_STREAM=<stream-name>
MESSAGE_WRITE_SUBJECT=<subject-name>
MESSAGE_WRITE_CONSUMER=<consumer-name>
```

The stream and consumer are created or updated by application startup code:

- publisher startup calls `ensureMessageWriteStream`
- writer startup calls `ensureMessageWriteConsumer`

No separate NATS CLI bootstrap is required for the local stack.

## Message Command Payload

The queued command shape is `MessageWriteCommand`:

```ts
interface MessageWriteCommand {
  message_id: string;
  request_id: string;
  sender_id: string;
  room_id: string;
  body: string;
  accepted_at: string;
  origin_connection_id?: string;
}
```

`message_id` is used as the JetStream duplicate ID (`msgID`) when publishing.
`sender_id + request_id` is the database idempotency key.

## WebSocket Write Flow

1. A client sends a WebSocket `send` frame to `realtime-service`.
2. `realtime-service` validates auth, payload shape, room membership, and rate
   limits.
3. It creates a `MessageWriteCommand`.
4. It publishes the command to JetStream subject `messages.write`.
5. After JetStream accepts the publish, the client receives an `ack`.
6. `message-writer-service` consumes the command from the durable consumer.
7. The writer persists the message in PostgreSQL.
8. The writer updates room ordering and `Room.lastMessageAt`.
9. The writer creates a `MessageOutbox` row for room fanout.
10. If writer fanout is enabled, it drains the outbox to Redis
    `room:<roomId>:events`.
11. Realtime instances subscribed to Redis publish the final `message.created`
    event to connected WebSocket clients.

## REST Message Flow

`chat-service` currently persists normal REST chat operations directly in
PostgreSQL and publishes Redis room events for realtime delivery. The existing
REST route calls `createMessage`, not the buffered NATS write path.

## Writer Persistence Details

`message-writer-service` consumes from `MESSAGE_WRITES/message-writer` with
explicit ack.

For each batch it:

1. Deduplicates commands by `sender_id + request_id`.
2. Inserts missing `MessageWrite` rows.
3. Locks affected rooms.
4. Allocates monotonic per-room `roomSequence` values.
5. Inserts missing `Message` rows.
6. Marks writes as `PERSISTED`.
7. Inserts `MessageOutbox` rows.
8. Updates `Room.lastMessageAt`.
9. Acks the JetStream messages.

If a batch fails, the writer recursively splits the batch. A single failing
command is nacked for redelivery until max delivery is reached. After max
delivery, the command is marked `DEAD`.

## Database Tables

The NATS-backed write path uses these Prisma models:

- `MessageWrite`: queued write state and idempotency record
- `Message`: persisted chat message
- `MessageOutbox`: durable Redis fanout work item
- `Room.nextMessageSeq`: per-room ordering allocator
- `Room.lastMessageAt`: room list ordering timestamp

Important constraints:

```text
MessageWrite @@unique([senderId, requestId])
Message      @@unique([senderId, requestId])
Message      @@unique([roomId, roomSequence])
MessageOutbox @@unique([eventType, messageId])
```

## Runtime Configuration

Required:

```text
NATS_URL=nats://nats:4222
```

Stream/consumer:

```text
MESSAGE_WRITE_STREAM=MESSAGE_WRITES
MESSAGE_WRITE_SUBJECT=messages.write
MESSAGE_WRITE_CONSUMER=message-writer
MESSAGE_WRITE_STREAM_MAX_MSGS=1000000
MESSAGE_WRITE_MAX_DELIVER=5
MESSAGE_WRITE_ACK_WAIT_MS=30000
MESSAGE_WRITE_MAX_ACK_PENDING=4096
```

Writer batching:

```text
MESSAGE_WRITER_BATCH_SIZE=250
MESSAGE_WRITER_BATCH_FLUSH_MS=50
MESSAGE_WRITER_BATCH_CONCURRENCY=4
MESSAGE_WRITER_MAX_MESSAGES=512
MESSAGE_WRITER_EXPIRES_MS=1000
MESSAGE_WRITER_DISABLE_FANOUT=true
LOAD_METRICS_LOG_INTERVAL_MS=5000
```

Realtime publish controls:

```text
REALTIME_DISABLE_NATS_PUBLISH=false
WS_RATE_LIMIT_MODE=off
```

Set `MESSAGE_WRITER_DISABLE_FANOUT=false` to make the writer drain
`MessageOutbox` and publish Redis room events. When it is `true`, messages are
still persisted, but outbox fanout is left disabled for that process.

## Local NATS

The default full stack runs:

```bash
docker compose up -d nats
```

NATS monitor:

```bash
curl http://localhost:8222/healthz
```

The local NATS service listens on:

```text
nats://localhost:4222
```

Containers use:

```text
nats://nats:4222
```

## Observability

`message-writer-service` logs periodic JSON metrics named
`message_writer_metrics`, including:

- `commands_persisted`
- `messages_created`
- `commands_persisted_per_sec`
- `current_batch_size`
- `pending_batches`
- `in_flight_batches`
- `batch_size`
- `batch_duration_ms`
- `event_loop_lag_ms`
- `dead_commands`

Useful checks:

```bash
docker compose logs -f message-writer-service
curl http://localhost:8222/jsz
curl http://localhost:8222/connz
```

## Failure Behavior

- If the realtime service cannot publish to NATS, the client receives an error
  instead of a successful `ack`.
- If the writer crashes before acking a JetStream message, JetStream redelivers
  it.
- If PostgreSQL rejects a duplicated request, the writer uses the
  `senderId/requestId` idempotency record instead of inserting a duplicate.
- If Redis fanout fails, the message remains persisted in PostgreSQL and the
  outbox row can be retried.
- If a command repeatedly fails past `MESSAGE_WRITE_MAX_DELIVER`, the related
  `MessageWrite` is marked `DEAD`.

## Load-Test Artifacts

Generated k6 reports and generated load-test datasets are local artifacts:

```text
load/reports/
backend/load-tests/generated/
```

They are ignored by Git except for `load/reports/.gitkeep`.
