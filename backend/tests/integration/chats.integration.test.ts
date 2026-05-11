import { afterAll, beforeEach, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createChatRouter } from '../../src/routes/chats.js';
import { requestJson } from '../helpers/request-json.js';
import { disconnectDatabase, prisma, resetDatabase } from '../helpers/db.js';

process.env.JWT_SECRET ??= 'unit-test-secret';

function authHeaders(userId: string, username: string): { authorization: string } {
  const token = jwt.sign({ userId, username }, process.env.JWT_SECRET!);
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectDatabase();
});

test('creates a direct chat and stores room memberships in PostgreSQL', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson<{ id: string; type: string; name: string }>(
    createChatRouter(prisma),
    '/',
    {
      method: 'POST',
      headers: authHeaders(alice.id, alice.username),
      body: JSON.stringify({ type: 'direct', member_ids: [bob.username] }),
    },
  );

  // Assert
  expect(res.status).toBe(201);
  expect(res.body.type).toBe('direct');
  expect(res.body.name).toBe('Bob');

  const members = await prisma.roomMember.findMany({
    where: { roomId: res.body.id },
    orderBy: { userId: 'asc' },
  });
  expect(members.map((member) => member.userId).sort()).toEqual([alice.id, bob.id].sort());
});

test('rejects unauthenticated direct chat creation and does not create a room', async () => {
  // Arrange
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson(createChatRouter(prisma), '/', {
    method: 'POST',
    body: JSON.stringify({ type: 'direct', member_ids: [bob.username] }),
  });

  // Assert
  const roomCount = await prisma.room.count();
  expect(res.status).toBe(401);
  expect(roomCount).toBe(0);
});

test('rejects an empty message body before creating a message row', async () => {
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

  // Act
  const res = await requestJson(createChatRouter(prisma), `/${room.id}/messages`, {
    method: 'POST',
    headers: authHeaders(alice.id, alice.username),
    body: JSON.stringify({ body: '   ' }),
  });

  // Assert
  const messageCount = await prisma.message.count({ where: { roomId: room.id } });
  expect(res.status).toBe(400);
  expect(messageCount).toBe(0);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'body is required',
    },
  });
});

test('rejects non-member message access without returning room messages', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }] },
      messages: {
        create: {
          content: 'private message',
          senderId: alice.id,
        },
      },
    },
  });

  // Act
  const res = await requestJson(createChatRouter(prisma), `/${room.id}/messages`, {
    headers: authHeaders(bob.id, bob.username),
  });

  // Assert
  expect(res.status).toBe(403);
  expect(JSON.stringify(res.body)).not.toContain('private message');
  expect(res.body).toEqual({
    error: {
      code: 'FORBIDDEN',
      message: 'Not a member of this chat',
    },
  });
});

test('stores a message and moves the room to the latest-message order', async () => {
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

  // Act
  const res = await requestJson<{ id: string; body: string; chat_id: string }>(
    createChatRouter(prisma),
    `/${room.id}/messages`,
    {
      method: 'POST',
      headers: authHeaders(alice.id, alice.username),
      body: JSON.stringify({ body: '  hello from integration  ' }),
    },
  );

  // Assert
  expect(res.status).toBe(201);
  expect(res.body.chat_id).toBe(room.id);
  expect(res.body.body).toBe('hello from integration');

  const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });

  expect(message.content).toBe('hello from integration');
  expect(message.senderId).toBe(alice.id);
  expect(updatedRoom.lastMessageAt.toISOString()).toBe(message.createdAt.toISOString());
});

test('lists chats with the asynchronously persisted latest message', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password: 'hashed-password',
    },
  });
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });

  await requestJson(createChatRouter(prisma), `/${room.id}/messages`, {
    method: 'POST',
    headers: authHeaders(alice.id, alice.username),
    body: JSON.stringify({ body: 'latest message' }),
  });

  // Act
  const res = await requestJson<Array<{ id: string; last_message?: { body: string } }>>(
    createChatRouter(prisma),
    '/',
    { headers: authHeaders(alice.id, alice.username) },
  );

  // Assert
  expect(res.status).toBe(200);
  expect(res.body[0]).toMatchObject({
    id: room.id,
    last_message: {
      body: 'latest message',
    },
  });
});
