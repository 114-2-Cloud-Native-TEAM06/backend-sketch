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

test('creates a group chat and returns its members from PostgreSQL', async () => {
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
  const carol = await prisma.user.create({
    data: {
      username: 'carol',
      email: 'carol@example.com',
      displayName: 'Carol',
      password: 'hashed-password',
    },
  });

  // Act
  const createRes = await requestJson<{ id: string; type: string; name: string }>(
    createChatRouter(prisma),
    '/',
    {
      method: 'POST',
      headers: authHeaders(alice.id, alice.username),
      body: JSON.stringify({ type: 'group', name: 'Study Group', member_ids: [bob.username, carol.username] }),
    },
  );
  const membersRes = await requestJson<Array<{ username: string }>>(
    createChatRouter(prisma),
    `/${createRes.body.id}/members`,
    { headers: authHeaders(alice.id, alice.username) },
  );

  // Assert
  expect(createRes.status).toBe(201);
  expect(createRes.body).toMatchObject({ type: 'group', name: 'Study Group' });
  expect(membersRes.status).toBe(200);
  expect(membersRes.body.map((user) => user.username).sort()).toEqual(['alice', 'bob', 'carol']);
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

test('rejects access to another user chat detail', async () => {
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
    },
  });

  // Act
  const res = await requestJson(createChatRouter(prisma), `/${room.id}`, {
    headers: authHeaders(bob.id, bob.username),
  });

  // Assert
  expect(res.status).toBe(404);
  expect(res.body).toEqual({
    error: {
      code: 'NOT_FOUND',
      message: 'Chat not found',
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

test('stores a long message with special characters without truncation', async () => {
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
  const body = `${'x'.repeat(5000)} 測試 <script>alert("x")</script>`;

  // Act
  const res = await requestJson<{ id: string; body: string }>(createChatRouter(prisma), `/${room.id}/messages`, {
    method: 'POST',
    headers: authHeaders(alice.id, alice.username),
    body: JSON.stringify({ body }),
  });

  // Assert
  const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
  expect(res.status).toBe(201);
  expect(res.body.body).toBe(body);
  expect(message.content).toBe(body);
});

test('reads older messages using before_message_id cursor pagination', async () => {
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
  const older = await prisma.message.create({
    data: {
      roomId: room.id,
      senderId: alice.id,
      content: 'older',
      createdAt: new Date('2026-05-07T10:00:00.000Z'),
    },
  });
  const newer = await prisma.message.create({
    data: {
      roomId: room.id,
      senderId: alice.id,
      content: 'newer',
      createdAt: new Date('2026-05-07T10:01:00.000Z'),
    },
  });

  // Act
  const res = await requestJson<Array<{ id: string; body: string }>>(
    createChatRouter(prisma),
    `/${room.id}/messages?before_message_id=${newer.id}`,
    { headers: authHeaders(alice.id, alice.username) },
  );

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toEqual([
    expect.objectContaining({ id: older.id, body: 'older' }),
  ]);
});

test('accepts typing event from a room member without response body', async () => {
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
  const res = await requestJson(createChatRouter(prisma), `/${room.id}/typing`, {
    method: 'POST',
    headers: authHeaders(alice.id, alice.username),
  });

  // Assert
  expect(res.status).toBe(204);
  expect(res.body).toBeUndefined();
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
