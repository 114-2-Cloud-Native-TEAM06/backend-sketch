import { afterAll, beforeEach, expect, test } from 'vitest';
import {
  drainMessageOutbox,
  processMessageWriteCommand,
  processMessageWriteCommands,
} from '../../services/message-writer-service/src/modules/message-writes/message-write.processor.js';
import type { RedisLike } from '../../packages/shared-redis/src/index.js';
import { disconnectDatabase, prisma, resetDatabase } from '../helpers/db.js';

function createPublishingRedis(): { redis: RedisLike; published: Array<{ channel: string; message: string }> } {
  const published: Array<{ channel: string; message: string }> = [];
  return {
    published,
    redis: {
      get: async () => null,
      set: async () => null,
      incr: async () => 1,
      expire: async () => true,
      del: async () => 0,
      sAdd: async () => 0,
      sRem: async () => 0,
      sMembers: async () => [],
      publish: async (channel: string, message: string) => {
        published.push({ channel, message });
        return 1;
      },
      pSubscribe: async () => {},
      quit: async () => undefined,
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectDatabase();
});
test('message write worker creates the write record, persists the command, and enqueues fanout', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      lastMessageAt: new Date('2026-05-30T10:00:00.000Z'),
      members: { create: [{ userId: alice.id }] },
    },
  });
  const acceptedAt = new Date('2026-05-30T11:00:00.000Z');

  // Act
  const message = await processMessageWriteCommand(prisma, {
    message_id: 'msg-worker',
    request_id: 'req-worker',
    sender_id: alice.id,
    room_id: room.id,
    body: 'worker body',
    accepted_at: acceptedAt.toISOString(),
  });

  // Assert
  expect(message).toMatchObject({ id: 'msg-worker', body: 'worker body' });
  const persisted = await prisma.message.findUniqueOrThrow({ where: { id: 'msg-worker' } });
  const updatedWrite = await prisma.messageWrite.findUniqueOrThrow({ where: { id: 'msg-worker' } });
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  expect(persisted.content).toBe('worker body');
  expect(updatedWrite.status).toBe('PERSISTED');
  expect(updatedWrite.persistedAt?.toISOString()).toBe(acceptedAt.toISOString());
  expect(updatedRoom.lastMessageAt.toISOString()).toBe(acceptedAt.toISOString());
  expect(persisted.roomSequence).toBe(1n);
  expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::BIGINT AS count FROM "MessageOutbox"`).toEqual([
    { count: 1n },
  ]);
});

test('message write worker marks the write dead after retry exhaustion', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const write = await prisma.messageWrite.create({
    data: {
      requestId: 'req-dead',
      senderId: alice.id,
      roomId: room.id,
      content: 'dead body',
    },
  });

  // Act
  const result = await processMessageWriteCommand(prisma, {
    message_id: write.id,
    request_id: write.requestId,
    sender_id: alice.id,
    room_id: 'missing-room',
    body: write.content,
    accepted_at: write.acceptedAt.toISOString(),
  }, { deliveryAttempt: 3, maxDeliveryAttempts: 3 });

  // Assert
  const updatedWrite = await prisma.messageWrite.findUniqueOrThrow({ where: { id: write.id } });
  expect(result).toBeUndefined();
  expect(updatedWrite.status).toBe('DEAD');
  expect(updatedWrite.failureReason).toBeTruthy();
});

test('message write worker persists a batch of commands and drains outbox fanout', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      lastMessageAt: new Date('2026-05-30T10:00:00.000Z'),
      members: { create: [{ userId: alice.id }] },
    },
  });
  const { redis, published } = createPublishingRedis();

  // Act
  const messages = await processMessageWriteCommands(prisma, [
    {
      message_id: 'msg-batch-1',
      request_id: 'req-batch-1',
      sender_id: alice.id,
      room_id: room.id,
      body: 'first batch body',
      accepted_at: '2026-05-30T11:00:00.000Z',
    },
    {
      message_id: 'msg-batch-2',
      request_id: 'req-batch-2',
      sender_id: alice.id,
      room_id: room.id,
      body: 'second batch body',
      accepted_at: '2026-05-30T11:01:00.000Z',
    },
  ], { publisher: redis });

  // Assert
  expect(messages.map((message) => message.id).sort((a, b) => a.localeCompare(b))).toEqual(['msg-batch-1', 'msg-batch-2']);
  const persistedMessages = await prisma.message.findMany({ orderBy: { id: 'asc' } });
  const updatedWrites = await prisma.messageWrite.findMany({ orderBy: { id: 'asc' } });
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  expect(persistedMessages.map((message) => message.content)).toEqual(['first batch body', 'second batch body']);
  expect(persistedMessages.map((message) => message.roomSequence)).toEqual([1n, 2n]);
  expect(updatedWrites.map((write) => write.status)).toEqual(['PERSISTED', 'PERSISTED']);
  expect(updatedWrites.map((write) => write.persistedAt?.toISOString())).toEqual([
    '2026-05-30T11:00:00.000Z',
    '2026-05-30T11:01:00.000Z',
  ]);
  expect(updatedRoom.lastMessageAt.toISOString()).toBe('2026-05-30T11:01:00.000Z');
  expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::BIGINT AS count FROM "MessageOutbox"`).toEqual([
    { count: 2n },
  ]);
  expect(published).toHaveLength(0);

  await drainMessageOutbox(prisma, { publisher: redis });

  expect(published).toHaveLength(2);
  const fanoutedWrites = await prisma.messageWrite.findMany({ orderBy: { id: 'asc' } });
  expect(fanoutedWrites.map((write) => write.status)).toEqual(['FANOUTED', 'FANOUTED']);
  const outboxRows = await prisma.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status" FROM "MessageOutbox" ORDER BY "messageId"
  `;
  expect(outboxRows.map((row) => row.status)).toEqual(['PUBLISHED', 'PUBLISHED']);
});

test('message write worker deduplicates identical commands within the same batch', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const command = {
    message_id: 'msg-duplicate',
    request_id: 'req-duplicate',
    sender_id: alice.id,
    room_id: room.id,
    body: 'deduped body',
    accepted_at: '2026-05-30T11:00:00.000Z',
  };
  const { redis, published } = createPublishingRedis();

  // Act
  const messages = await processMessageWriteCommands(prisma, [command, command], { publisher: redis });

  // Assert
  expect(messages).toHaveLength(1);
  expect(await prisma.message.count()).toBe(1);
  expect(await prisma.messageWrite.count()).toBe(1);
  expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::BIGINT AS count FROM "MessageOutbox"`).toEqual([
    { count: 1n },
  ]);
  expect(published).toHaveLength(0);
});

test('message write worker does not publish again when redelivery finds an existing message', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const acceptedAt = new Date('2026-05-30T11:00:00.000Z');
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
      messageWrites: {
        create: {
          id: 'msg-redelivery',
          requestId: 'req-redelivery',
          senderId: alice.id,
          content: 'redelivery body',
          acceptedAt,
          persistedAt: acceptedAt,
          status: 'PERSISTED',
        },
      },
      messages: {
        create: {
          id: 'msg-redelivery',
          requestId: 'req-redelivery',
          senderId: alice.id,
          content: 'redelivery body',
          createdAt: acceptedAt,
          roomSequence: 1,
        },
      },
    },
  });
  const { redis, published } = createPublishingRedis();

  // Act
  const messages = await processMessageWriteCommands(prisma, [{
    message_id: 'msg-redelivery',
    request_id: 'req-redelivery',
    sender_id: alice.id,
    room_id: room.id,
    body: 'redelivery body',
    accepted_at: acceptedAt.toISOString(),
  }], { publisher: redis });

  // Assert
  expect(messages).toHaveLength(0);
  expect(await prisma.message.count()).toBe(1);
  expect(await prisma.messageWrite.count()).toBe(1);
  expect(published).toHaveLength(0);
});

test('message outbox retry keeps persisted writes until fanout succeeds', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const failingRedis: RedisLike = {
    get: async () => null,
    set: async () => null,
    incr: async () => 1,
    expire: async () => true,
    del: async () => 0,
    sAdd: async () => 0,
    sRem: async () => 0,
    sMembers: async () => [],
    publish: async () => {
      throw new Error('redis unavailable');
    },
    pSubscribe: async () => {},
    quit: async () => undefined,
  };
  const { redis, published } = createPublishingRedis();

  await processMessageWriteCommands(prisma, [{
    message_id: 'msg-outbox-retry',
    request_id: 'req-outbox-retry',
    sender_id: alice.id,
    room_id: room.id,
    body: 'retry body',
    accepted_at: '2026-05-30T11:00:00.000Z',
  }]);

  // Act
  await drainMessageOutbox(prisma, { publisher: failingRedis });

  // Assert
  const persistedWrite = await prisma.messageWrite.findUniqueOrThrow({ where: { id: 'msg-outbox-retry' } });
  const failedOutbox = await prisma.$queryRaw<Array<{ status: string; failureReason: string | null }>>`
    SELECT "status"::text AS "status", "failureReason" FROM "MessageOutbox" WHERE "messageId" = 'msg-outbox-retry'
  `;
  expect(persistedWrite.status).toBe('PERSISTED');
  expect(failedOutbox).toEqual([expect.objectContaining({ status: 'FAILED', failureReason: 'redis unavailable' })]);

  await prisma.$executeRaw`
    UPDATE "MessageOutbox"
    SET "nextAttemptAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
    WHERE "messageId" = 'msg-outbox-retry'
  `;
  await drainMessageOutbox(prisma, { publisher: redis });

  const fanoutedWrite = await prisma.messageWrite.findUniqueOrThrow({ where: { id: 'msg-outbox-retry' } });
  const publishedOutbox = await prisma.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status" FROM "MessageOutbox" WHERE "messageId" = 'msg-outbox-retry'
  `;
  expect(fanoutedWrite.status).toBe('FANOUTED');
  expect(publishedOutbox).toEqual([{ status: 'PUBLISHED' }]);
  expect(published).toHaveLength(1);
});

test('message write worker does not move room lastMessageAt backwards for an older batch', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      lastMessageAt: new Date('2026-05-30T12:00:00.000Z'),
      members: { create: [{ userId: alice.id }] },
    },
  });

  // Act
  await processMessageWriteCommands(prisma, [{
    message_id: 'msg-older-batch',
    request_id: 'req-older-batch',
    sender_id: alice.id,
    room_id: room.id,
    body: 'older batch body',
    accepted_at: '2026-05-30T11:00:00.000Z',
  }]);

  // Assert
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  expect(updatedRoom.lastMessageAt.toISOString()).toBe('2026-05-30T12:00:00.000Z');
});

test('message write worker assigns contiguous room sequences and keeps them on redelivery', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const commands = Array.from({ length: 5 }, (_, index) => ({
    message_id: `msg-seq-${index + 1}`,
    request_id: `req-seq-${index + 1}`,
    sender_id: alice.id,
    room_id: room.id,
    body: `sequence ${index + 1}`,
    accepted_at: `2026-05-30T11:0${index}:00.000Z`,
  }));

  // Act
  await processMessageWriteCommands(prisma, commands);
  await processMessageWriteCommands(prisma, commands);

  // Assert
  const messages = await prisma.message.findMany({ where: { roomId: room.id }, orderBy: { roomSequence: 'asc' } });
  expect(messages.map((message) => message.roomSequence)).toEqual([1n, 2n, 3n, 4n, 5n]);
  expect(await prisma.message.count()).toBe(5);
});

test('message write worker handles concurrent duplicate commands without duplicate messages or outbox rows', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  const command = {
    message_id: 'msg-concurrent-duplicate',
    request_id: 'req-concurrent-duplicate',
    sender_id: alice.id,
    room_id: room.id,
    body: 'concurrent body',
    accepted_at: '2026-05-30T11:00:00.000Z',
  };
  const { redis, published } = createPublishingRedis();

  // Act
  await Promise.all([
    processMessageWriteCommands(prisma, [command]),
    processMessageWriteCommands(prisma, [command]),
  ]);
  await Promise.all([
    drainMessageOutbox(prisma, { publisher: redis }),
    drainMessageOutbox(prisma, { publisher: redis }),
  ]);

  // Assert
  expect(await prisma.message.count()).toBe(1);
  expect(await prisma.messageWrite.count()).toBe(1);
  expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::BIGINT AS count FROM "MessageOutbox"`).toEqual([
    { count: 1n },
  ]);
  expect(published).toHaveLength(1);
});

test('message write worker does not rewrite a dead write as persisted', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  await prisma.messageWrite.create({
    data: {
      id: 'msg-dead-terminal',
      requestId: 'req-dead-terminal',
      senderId: alice.id,
      roomId: room.id,
      content: 'dead terminal',
      status: 'DEAD',
      failedAt: new Date('2026-05-30T11:00:00.000Z'),
      failureReason: 'terminal',
    },
  });

  // Act
  const messages = await processMessageWriteCommands(prisma, [{
    message_id: 'msg-dead-terminal',
    request_id: 'req-dead-terminal',
    sender_id: alice.id,
    room_id: room.id,
    body: 'dead terminal',
    accepted_at: '2026-05-30T11:00:00.000Z',
  }]);

  // Assert
  const write = await prisma.messageWrite.findUniqueOrThrow({ where: { id: 'msg-dead-terminal' } });
  expect(messages).toEqual([]);
  expect(write.status).toBe('DEAD');
  expect(await prisma.message.count()).toBe(0);
  expect(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::BIGINT AS count FROM "MessageOutbox"`).toEqual([
    { count: 0n },
  ]);
});

test('message write worker rejects conflicting duplicate commands without persisting the batch', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });

  // Act / Assert
  await expect(processMessageWriteCommands(prisma, [
    {
      message_id: 'msg-conflict-1',
      request_id: 'req-conflict',
      sender_id: alice.id,
      room_id: room.id,
      body: 'original body',
      accepted_at: '2026-05-30T11:00:00.000Z',
    },
    {
      message_id: 'msg-conflict-2',
      request_id: 'req-conflict',
      sender_id: alice.id,
      room_id: room.id,
      body: 'different body',
      accepted_at: '2026-05-30T11:00:00.000Z',
    },
  ])).rejects.toThrow('batch contains conflicting message write commands');
  expect(await prisma.message.count()).toBe(0);
  expect(await prisma.messageWrite.count()).toBe(0);
});

test('message write worker rejects an existing request conflict before persisting the Prisma batch', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
    },
  });
  await prisma.messageWrite.create({
    data: {
      id: 'msg-existing-conflict',
      requestId: 'req-existing-conflict',
      senderId: alice.id,
      roomId: room.id,
      content: 'original body',
      acceptedAt: new Date('2026-05-30T10:00:00.000Z'),
    },
  });

  // Act / Assert
  await expect(processMessageWriteCommands(prisma, [
    {
      message_id: 'msg-valid-in-rolled-back-batch',
      request_id: 'req-valid-in-rolled-back-batch',
      sender_id: alice.id,
      room_id: room.id,
      body: 'valid body',
      accepted_at: '2026-05-30T11:00:00.000Z',
    },
    {
      message_id: 'msg-existing-conflict',
      request_id: 'req-existing-conflict',
      sender_id: alice.id,
      room_id: room.id,
      body: 'different body',
      accepted_at: '2026-05-30T11:01:00.000Z',
    },
  ])).rejects.toThrow('message write command does not match existing request');
  expect(await prisma.message.findUnique({ where: { id: 'msg-valid-in-rolled-back-batch' } })).toBeNull();
  expect(await prisma.messageWrite.findUnique({ where: { id: 'msg-valid-in-rolled-back-batch' } })).toBeNull();
});
