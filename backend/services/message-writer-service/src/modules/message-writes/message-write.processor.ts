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
      await markMessageWriteCommandDead(prisma, command, err);
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
  const roomIds = [...new Set(deduped.map((command) => command.room_id))].sort((a, b) => a.localeCompare(b));

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Room"
      WHERE "id" IN (${Prisma.join(roomIds)})
      ORDER BY "id"
      FOR UPDATE
    `;

    await tx.$executeRaw`
      WITH input AS (${messageWriteInputSql(batchJson)})
      INSERT INTO "MessageWrite" (
        "id",
        "requestId",
        "senderId",
        "roomId",
        "content",
        "acceptedAt"
      )
      SELECT
        input."messageId",
        input."requestId",
        input."senderId",
        input."roomId",
        input."body",
        input."acceptedAt"
      FROM input
      ON CONFLICT ("senderId", "requestId") DO NOTHING
    `;

    const writes = await tx.$queryRaw<Array<{
      id: string;
      requestId: string;
      senderId: string;
      roomId: string;
      content: string;
      status: string;
      acceptedAt: Date;
    }>>`
      WITH input AS (${messageWriteInputSql(batchJson)})
      SELECT
        mw."id",
        mw."requestId",
        mw."senderId",
        mw."roomId",
        mw."content",
        mw."status"::text AS "status",
        mw."acceptedAt"
      FROM "MessageWrite" AS mw
      JOIN input
        ON input."senderId" = mw."senderId"
        AND input."requestId" = mw."requestId"
      ORDER BY mw."senderId", mw."requestId"
      FOR UPDATE OF mw
    `;
    const writesByKey = new Map(writes.map((write) => [messageWriteKey(write.senderId, write.requestId), write]));

    for (const command of deduped) {
      const write = writesByKey.get(messageWriteKey(command.sender_id, command.request_id));
      if (
        !write ||
        write.id !== command.message_id ||
        write.roomId !== command.room_id ||
        write.content !== command.body
      ) {
        throw new Error('message write command does not match existing request');
      }
    }

    const persistedMessages = await tx.$queryRaw<BatchPersistedMessageRow[]>`
      WITH input AS (${messageWriteInputSql(batchJson)}),
      write_rows AS (
        SELECT
          mw."id",
          mw."requestId",
          mw."senderId",
          mw."roomId",
          mw."content",
          mw."status",
          mw."acceptedAt",
          input."originConnectionId"
        FROM "MessageWrite" AS mw
        JOIN input
          ON input."senderId" = mw."senderId"
          AND input."requestId" = mw."requestId"
      ),
      candidates AS (
        SELECT
          write_rows.*,
          ROW_NUMBER() OVER (
            PARTITION BY write_rows."roomId"
            ORDER BY write_rows."acceptedAt", write_rows."id"
          ) - 1 AS "roomOffset"
        FROM write_rows
        WHERE
          write_rows."status" <> 'DEAD'::"MessageWriteStatus"
          AND NOT EXISTS (
            SELECT 1
            FROM "Message" AS m
            WHERE
              m."id" = write_rows."id"
              OR (
                m."senderId" = write_rows."senderId"
                AND m."requestId" = write_rows."requestId"
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
          "requestId",
          "roomSequence",
          "senderId",
          "roomId"
        )
        SELECT
          candidates."id",
          candidates."content",
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
          write_rows."originConnectionId"
        FROM inserted_messages
        JOIN write_rows ON write_rows."id" = inserted_messages."id"
        ON CONFLICT ("eventType", "messageId") DO NOTHING
      ),
      all_messages AS (
        SELECT
          inserted_messages."id",
          inserted_messages."content",
          inserted_messages."createdAt",
          inserted_messages."senderId",
          inserted_messages."roomId",
          inserted_messages."requestId"
        FROM inserted_messages
        UNION
        SELECT
          m."id",
          m."content",
          m."createdAt",
          m."senderId",
          m."roomId",
          m."requestId"
        FROM "Message" AS m
        JOIN write_rows
          ON m."id" = write_rows."id"
          OR (
            m."senderId" = write_rows."senderId"
            AND m."requestId" = write_rows."requestId"
          )
        WHERE NOT EXISTS (
          SELECT 1
          FROM inserted_messages
          WHERE inserted_messages."id" = m."id"
        )
      ),
      write_updates AS (
        UPDATE "MessageWrite" AS mw
        SET
          "status" = 'PERSISTED'::"MessageWriteStatus",
          "persistedAt" = all_messages."createdAt",
          "failedAt" = NULL,
          "failureReason" = NULL
        FROM all_messages
        WHERE
          mw."senderId" = all_messages."senderId"
          AND mw."requestId" = all_messages."requestId"
          AND mw."status" NOT IN ('DEAD'::"MessageWriteStatus", 'FANOUTED'::"MessageWriteStatus")
      )
      SELECT
        inserted_messages."id",
        inserted_messages."content",
        inserted_messages."createdAt",
        inserted_messages."senderId",
        inserted_messages."roomId",
        write_rows."originConnectionId"
      FROM inserted_messages
      JOIN write_rows ON write_rows."id" = inserted_messages."id"
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
          UPDATE "MessageWrite"
          SET
            "status" = 'FANOUTED'::"MessageWriteStatus",
            "failedAt" = NULL,
            "failureReason" = NULL
          WHERE
            "id" = ${row.messageId}
            AND "status" = 'PERSISTED'::"MessageWriteStatus"
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
  await prisma.$executeRaw`
    UPDATE "MessageOutbox"
    SET
      "status" = 'FAILED'::"MessageOutboxStatus",
      "nextAttemptAt" = ${new Date(Date.now() + retryDelayMs)},
      "lockedAt" = NULL,
      "failureReason" = ${formatFailureReason(err)},
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id}
  `;
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

async function markMessageWriteDead(
  prisma: PrismaClient,
  messageWriteId: string,
  err: unknown,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "MessageWrite"
      SET
        "status" = 'DEAD'::"MessageWriteStatus",
        "failedAt" = CURRENT_TIMESTAMP,
        "failureReason" = ${formatFailureReason(err)}
      WHERE
        "id" = ${messageWriteId}
        AND "status" = 'PENDING'::"MessageWriteStatus"
    `;
  } catch (markErr) {
    console.error('failed to mark message write dead:', markErr);
  }
}

async function markMessageWriteCommandDead(
  prisma: PrismaClient,
  command: MessageWriteCommand,
  err: unknown,
): Promise<void> {
  try {
    const existing = await prisma.messageWrite.findUnique({
      where: { senderId_requestId: { senderId: command.sender_id, requestId: command.request_id } },
      select: { id: true },
    });
    if (existing) {
      await markMessageWriteDead(prisma, existing.id, err);
      return;
    }

    await prisma.messageWrite.create({
      data: {
        id: command.message_id,
        requestId: command.request_id,
        senderId: command.sender_id,
        roomId: command.room_id,
        content: command.body,
        acceptedAt: new Date(command.accepted_at),
        status: 'DEAD',
        failedAt: new Date(),
        failureReason: formatFailureReason(err),
      },
    });
  } catch (markErr) {
    console.error('failed to mark message write command dead:', markErr);
  }
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
