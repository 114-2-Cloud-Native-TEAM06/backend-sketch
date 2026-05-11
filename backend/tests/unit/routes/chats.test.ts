import { expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createChatRouter } from '../../../src/routes/chats.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const token = jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);
const authHeaders = { authorization: `Bearer ${token}` };

test('POST / creates a direct chat with the current user and resolved target user', async () => {
  let createdMembers: Array<{ userId: string }> = [];
  const prisma = {
    user: {
      findFirst: async (args: { where: { OR: Array<{ id?: string; username?: string }> } }) => {
        expect(args.where.OR).toEqual([{ id: 'bob' }, { username: 'bob' }]);
        return { id: 'user-2', displayName: 'Bob' };
      },
    },
    room: {
      findMany: async () => [],
      create: async (args: { data: { members: { create: Array<{ userId: string }> } } }) => {
        createdMembers = args.data.members.create;
        return { id: 'room-1' };
      },
    },
  };

  const res = await requestJson<{ id: string; type: string; name: string; unread_count: number }>(
    createChatRouter(prisma as never),
    '/',
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'direct', member_ids: ['bob'] }),
    },
  );

  expect(res.status).toBe(201);
  expect(res.body).toEqual({
    id: 'room-1',
    type: 'direct',
    name: 'Bob',
    unread_count: 0,
  });
  expect(createdMembers).toEqual([{ userId: 'user-1' }, { userId: 'user-2' }]);
});

test('GET /:chatId/messages rejects non-members before querying messages', async () => {
  let queriedMessages = false;
  const prisma = {
    roomMember: {
      findUnique: async () => null,
    },
    message: {
      findMany: async () => {
        queriedMessages = true;
        return [];
      },
    },
  };

  const res = await requestJson(createChatRouter(prisma as never), '/room-1/messages', {
    headers: authHeaders,
  });

  expect(res.status).toBe(403);
  expect(queriedMessages).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'FORBIDDEN',
      message: 'Not a member of this chat',
    },
  });
});

test('POST /:chatId/messages trims content, persists the message, and updates room order timestamp', async () => {
  const createdAt = new Date('2026-05-07T10:00:00.000Z');
  let createdMessageData: { content: string; senderId: string; roomId: string } | undefined;
  let roomUpdateData: { lastMessageAt: Date } | undefined;

  const prisma = {
    roomMember: {
      findUnique: async (args: { where: { userId_roomId: { userId: string; roomId: string } } }) => {
        expect(args.where.userId_roomId).toEqual({ userId: 'user-1', roomId: 'room-1' });
        return { userId: 'user-1', roomId: 'room-1' };
      },
    },
    message: {
      create: async (args: { data: { content: string; senderId: string; roomId: string } }) => {
        createdMessageData = args.data;
        return {
          id: 'msg-1',
          content: args.data.content,
          createdAt,
          senderId: args.data.senderId,
          roomId: args.data.roomId,
        };
      },
    },
    room: {
      update: async (args: { data: { lastMessageAt: Date } }) => {
        roomUpdateData = args.data;
        return {};
      },
    },
  };

  const res = await requestJson<{ id: string; body: string; created_at: string }>(
    createChatRouter(prisma as never),
    '/room-1/messages',
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ body: '  hello  ' }),
    },
  );

  expect(res.status).toBe(201);
  expect(createdMessageData).toEqual({ content: 'hello', senderId: 'user-1', roomId: 'room-1' });
  expect(roomUpdateData).toEqual({ lastMessageAt: createdAt });
  expect(res.body).toEqual({
    id: 'msg-1',
    chat_id: 'room-1',
    sender_id: 'user-1',
    type: 'TEXT',
    body: 'hello',
    created_at: createdAt.toISOString(),
  });
});
