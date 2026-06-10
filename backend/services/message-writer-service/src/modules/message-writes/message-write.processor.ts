import { Prisma, type PrismaClient } from '@prisma/client';
import type { Message } from '../../../../../packages/shared-types/src/api-types.js';
import {
  roomEventChannel,
  type RedisLike,
} from '../../../../../packages/shared-redis/src/index.js';
import type { MessageWriteCommand } from '../../../../../packages/shared-nats/src/index.js';

type MessageRow = {
  id: string;
  content: string;
  createdAt: Date;
  senderId: string;
  roomId: string;
};

export interface ProcessMessageWriteDependencies {
  originConnectionId?: string;
  deliveryAttempt?: number;
  maxDeliveryAttempts?: number;
}

export interface ProcessMessageWriteBatchDependencies {
  publisher?: RedisLike;
  originConnectionId?: string;
}

export interface DrainMessageOutboxDependencies {
  publisher?: RedisLike;
  limit?: number;
  staleLockMs?: number;
}

type BatchPersistedMessageRow = MessageRow & {
  originConnectionId: string | null;
};

type ClaimedOutboxRow = {
  id: string;
  messageId: string;
  originConnectionId: string | null;
  attempts: number;
};

function toMessageDto(msg: MessageRow): Message {
  return {
    id:         msg.id,
    chat_id:    msg.roomId,
    sender_id:  msg.senderId,
    type:       'TEXT',
    body:       msg.content,
    created_at: msg.createdAt.toISOString(),
  };
}

export async function processMessageWriteCommand(
  prisma: PrismaClient,
  command: MessageWriteCommand,
  deps: ProcessMessageWriteDependencies = {},
): Promise<Message | undefined> {
  const deliveryAttempt = Math.max(1, deps.deliveryAttempt ?? 1);
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 5);

  try {
    const [message] = await processMessageWriteCommands(prisma, [command], {
      originConnectionId: deps.originConnectionId,
    });
    return message;
  } catch (err) {
    if (deliveryAttempt >= maxDeliveryAttempts) {
      return undefined;
    }

    throw err;
  }
}

export async function processMessageWriteCommands(
  prisma: PrismaClient,
  commands: MessageWriteCommand[],
  deps: ProcessMessageWriteBatchDependencies = {},
): Promise<Message[]> {
  if (!commands.length) return [];

  const deduped = dedupeMessageWriteCommands(commands);
  const batchJson = messageWriteBatchJson(deduped, deps.originConnectionId);
  const roomIds = [...new Set(deduped.map((command) => command.room_id))].sort();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Room"
      WHERE "id" IN (${Prisma.join(roomIds)})
      ORDER BY "id"
      FOR UPDATE
    `;

    const existingMessages = await tx.$queryRaw<Array<{
      id: string;
      requestId: string;
      senderId: string;
      roomId: string;
      content: string;
    }>>`
      WITH input AS (${messageWriteInputSql(batchJson)})
      SELECT
        m."id",
        m."requestId",
        m."senderId",
        m."roomId",
        m."content"
      FROM "Message" AS m
      JOIN input
        ON m."id" = input."messageId"
        OR (
          input."senderId" = m."senderId"
          AND input."requestId" = m."requestId"
        )
      ORDER BY m."senderId", m."requestId", m."id"
      FOR UPDATE OF m
    `;
    const messagesByKey = new Map(
      existingMessages.map((message) => [messageWriteKey(message.senderId, message.requestId), message]),
    );
    const messagesById = new Map(existingMessages.map((message) => [message.id, message]));

    for (const command of deduped) {
      const existing = messagesByKey.get(messageWriteKey(command.sender_id, command.request_id))
        ?? messagesById.get(command.message_id);
      if (
        existing &&
        (
          existing.id !== command.message_id ||
          existing.requestId !== command.request_id ||
          existing.senderId !== command.sender_id ||
          existing.roomId !== command.room_id ||
          existing.content !== command.body
        )
      ) {
        throw new Error('message write command does not match existing request');
      }
    }

    const persistedMessages = await tx.$queryRaw<BatchPersistedMessageRow[]>`
      WITH input AS (${messageWriteInputSql(batchJson)}),
      candidates AS (
        SELECT
          input.*,
          ROW_NUMBER() OVER (
            PARTITION BY input."roomId"
            ORDER BY input."acceptedAt", input."messageId"
          ) - 1 AS "roomOffset"
        FROM input
        WHERE NOT EXISTS (
          SELECT 1
          FROM "Message" AS m
          WHERE
            m."id" = input."messageId"
            OR (
              m."senderId" = input."senderId"
              AND m."requestId" = input."requestId"
            )
        )
      ),
      room_counts AS (
        SELECT "roomId", COUNT(*)::BIGINT AS "messageCount"
        FROM candidates
        GROUP BY "roomId"
      ),
      room_allocations AS (
        UPDATE "Room" AS r
        SET "nextMessageSeq" = r."nextMessageSeq" + rc."messageCount"
        FROM room_counts AS rc
        WHERE r."id" = rc."roomId"
        RETURNING
          r."id",
          r."nextMessageSeq" - rc."messageCount" AS "startSequence"
      ),
      inserted_messages AS (
        INSERT INTO "Message" (
          "id",
          "content",
          "createdAt",
          "persistedAt",
          "requestId",
          "roomSequence",
          "senderId",
          "roomId"
        )
        SELECT
          candidates."messageId",
          candidates."body",
          candidates."acceptedAt",
          candidates."acceptedAt",
          candidates."requestId",
          room_allocations."startSequence" + candidates."roomOffset",
          candidates."senderId",
          candidates."roomId"
        FROM candidates
        JOIN room_allocations ON room_allocations."id" = candidates."roomId"
        ON CONFLICT DO NOTHING
        RETURNING "id", "content", "createdAt", "senderId", "roomId", "requestId"
      ),
      outbox_insert AS (
        INSERT INTO "MessageOutbox" (
          "id",
          "eventType",
          "messageId",
          "originConnectionId"
        )
        SELECT
          'outbox_' || md5('message.created:' || inserted_messages."id"),
          'message.created',
          inserted_messages."id",
          candidates."originConnectionId"
        FROM inserted_messages
        JOIN candidates ON candidates."messageId" = inserted_messages."id"
        ON CONFLICT ("eventType", "messageId") DO NOTHING
      )
      SELECT
        inserted_messages."id",
        inserted_messages."content",
        inserted_messages."createdAt",
        inserted_messages."senderId",
        inserted_messages."roomId",
        candidates."originConnectionId"
      FROM inserted_messages
      JOIN candidates ON candidates."messageId" = inserted_messages."id"
      ORDER BY inserted_messages."createdAt", inserted_messages."id"
    `;

    await updateRoomsLastMessageAt(tx as PrismaClient, persistedMessages);
    return persistedMessages;
  });

  return result.map(toMessageDto);
}

export async function drainMessageOutbox(
  prisma: PrismaClient,
  deps: DrainMessageOutboxDependencies = {},
): Promise<number> {
  if (!deps.publisher) return 0;

  const limit = Math.max(1, deps.limit ?? 100);
  const staleLockMs = Math.max(1, deps.staleLockMs ?? 30_000);
  const claimed = await prisma.$transaction((tx) => tx.$queryRaw<ClaimedOutboxRow[]>`
    WITH claimable AS (
      SELECT "id"
      FROM "MessageOutbox"
      WHERE
        (
          "status" IN ('PENDING'::"MessageOutboxStatus", 'FAILED'::"MessageOutboxStatus")
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP)
        )
        OR (
          "status" = 'PUBLISHING'::"MessageOutboxStatus"
          AND "lockedAt" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
        )
      ORDER BY "createdAt", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "MessageOutbox" AS outbox
    SET
      "status" = 'PUBLISHING'::"MessageOutboxStatus",
      "attempts" = outbox."attempts" + 1,
      "lockedAt" = CURRENT_TIMESTAMP,
      "nextAttemptAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM claimable
    WHERE outbox."id" = claimable."id"
    RETURNING
      outbox."id",
      outbox."messageId",
      outbox."originConnectionId",
      outbox."attempts"
  `);

  if (!claimed.length) return 0;

  const messages = await prisma.message.findMany({
    where: { id: { in: claimed.map((row) => row.messageId) } },
    select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
  });
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  let published = 0;

  for (const row of claimed) {
    const message = messagesById.get(row.messageId);
    if (!message) {
      await markOutboxFailed(prisma, row, new Error('message not found for outbox event'));
      continue;
    }

    try {
      const dto = toMessageDto(message);
      await deps.publisher.publish(roomEventChannel(dto.chat_id), JSON.stringify({
        type: 'message.created',
        room_id: dto.chat_id,
        message: dto,
        ...(row.originConnectionId ? { origin_connection_id: row.originConnectionId } : {}),
      }));

      await prisma.$transaction([
        prisma.$executeRaw`
          UPDATE "MessageOutbox"
          SET
            "status" = 'PUBLISHED'::"MessageOutboxStatus",
            "publishedAt" = CURRENT_TIMESTAMP,
            "lockedAt" = NULL,
            "failureReason" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${row.id}
        `,
        prisma.$executeRaw`
          UPDATE "Message"
          SET
            "status" = 'FANOUTED'::"MessageStatus",
            "fanoutedAt" = CURRENT_TIMESTAMP,
            "failedAt" = NULL,
            "failureReason" = NULL
          WHERE
            "id" = ${row.messageId}
            AND "status" IN ('PERSISTED'::"MessageStatus", 'FANOUT_FAILED'::"MessageStatus")
        `,
      ]);
      published += 1;
    } catch (err) {
      await markOutboxFailed(prisma, row, err);
    }
  }

  return published;
}

function messageWriteBatchJson(commands: MessageWriteCommand[], fallbackOriginConnectionId?: string): string {
  return JSON.stringify(commands.map((command) => ({
    messageId: command.message_id,
    requestId: command.request_id,
    senderId: command.sender_id,
    roomId: command.room_id,
    body: command.body,
    acceptedAt: command.accepted_at,
    originConnectionId: command.origin_connection_id ?? fallbackOriginConnectionId ?? null,
  })));
}

function messageWriteInputSql(batchJson: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      input."messageId",
      input."requestId",
      input."senderId",
      input."roomId",
      input."body",
      (input."acceptedAt"::timestamptz AT TIME ZONE 'UTC')::timestamp(3) AS "acceptedAt",
      input."originConnectionId"
    FROM jsonb_to_recordset(${batchJson}::jsonb) AS input(
      "messageId" text,
      "requestId" text,
      "senderId" text,
      "roomId" text,
      "body" text,
      "acceptedAt" text,
      "originConnectionId" text
    )
  `;
}

async function markOutboxFailed(
  prisma: PrismaClient,
  row: ClaimedOutboxRow,
  err: unknown,
): Promise<void> {
  const retryDelayMs = Math.min(60_000, Math.max(1_000, row.attempts * row.attempts * 1_000));
  const failureReason = formatFailureReason(err);
  await prisma.$transaction([
    prisma.$executeRaw`
      UPDATE "MessageOutbox"
      SET
        "status" = 'FAILED'::"MessageOutboxStatus",
        "nextAttemptAt" = ${new Date(Date.now() + retryDelayMs)},
        "lockedAt" = NULL,
        "failureReason" = ${failureReason},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${row.id}
    `,
    prisma.$executeRaw`
      UPDATE "Message"
      SET
        "status" = 'FANOUT_FAILED'::"MessageStatus",
        "failedAt" = CURRENT_TIMESTAMP,
        "failureReason" = ${failureReason}
      WHERE "id" = ${row.messageId}
    `,
  ]);
}

async function updateRoomsLastMessageAt(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  messages: MessageRow[],
): Promise<void> {
  const maxByRoom = new Map<string, Date>();
  for (const message of messages) {
    const current = maxByRoom.get(message.roomId);
    if (!current || message.createdAt > current) maxByRoom.set(message.roomId, message.createdAt);
  }
  if (!maxByRoom.size) return;

  const roomMaxes = JSON.stringify([...maxByRoom].map(([roomId, lastCreatedAt]) => ({
    roomId,
    lastCreatedAt: lastCreatedAt.toISOString(),
  })));

  await prisma.$executeRaw`
    WITH room_maxes AS (
      SELECT
        input."roomId",
        (input."lastCreatedAt"::timestamptz AT TIME ZONE 'UTC')::timestamp(3) AS "lastCreatedAt"
      FROM jsonb_to_recordset(${roomMaxes}::jsonb) AS input(
        "roomId" text,
        "lastCreatedAt" text
      )
    )
    UPDATE "Room" AS r
    SET "lastMessageAt" = GREATEST(r."lastMessageAt", room_maxes."lastCreatedAt")
    FROM room_maxes
    WHERE r."id" = room_maxes."roomId"
  `;
}

function formatFailureReason(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return reason.slice(0, 2000);
}

function dedupeMessageWriteCommands(commands: MessageWriteCommand[]): MessageWriteCommand[] {
  const deduped = new Map<string, MessageWriteCommand>();
  for (const command of commands) {
    const key = messageWriteKey(command.sender_id, command.request_id);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, command);
      continue;
    }

    if (
      existing.message_id !== command.message_id ||
      existing.room_id !== command.room_id ||
      existing.body !== command.body
    ) {
      throw new Error('batch contains conflicting message write commands');
    }
  }
  return [...deduped.values()];
}

function messageWriteKey(senderId: string, requestId: string): string {
  return `${senderId}:${requestId}`;
}
