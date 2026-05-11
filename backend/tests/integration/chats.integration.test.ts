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

  const res = await requestJson<{ id: string; type: string; name: string }>(
    createChatRouter(prisma),
    '/',
    {
      method: 'POST',
      headers: authHeaders(alice.id, alice.username),
      body: JSON.stringify({ type: 'direct', member_ids: [bob.username] }),
    },
  );

  expect(res.status).toBe(201);
  expect(res.body.type).toBe('direct');
  expect(res.body.name).toBe('Bob');

  const members = await prisma.roomMember.findMany({
    where: { roomId: res.body.id },
    orderBy: { userId: 'asc' },
  });
  expect(members.map((member) => member.userId).sort()).toEqual([alice.id, bob.id].sort());
});

test('stores a message and moves the room to the latest-message order', async () => {
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

  const res = await requestJson<{ id: string; body: string; chat_id: string }>(
    createChatRouter(prisma),
    `/${room.id}/messages`,
    {
      method: 'POST',
      headers: authHeaders(alice.id, alice.username),
      body: JSON.stringify({ body: '  hello from integration  ' }),
    },
  );

  expect(res.status).toBe(201);
  expect(res.body.chat_id).toBe(room.id);
  expect(res.body.body).toBe('hello from integration');

  const message = await prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });

  expect(message.content).toBe('hello from integration');
  expect(message.senderId).toBe(alice.id);
  expect(updatedRoom.lastMessageAt.toISOString()).toBe(message.createdAt.toISOString());
});
