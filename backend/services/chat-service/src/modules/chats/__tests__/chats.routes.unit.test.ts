import { expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createChatRouter } from '../chats.routes.js';
import { requestJson } from '../../../../../../tests/helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const token = jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);
const authHeaders = { authorization: `Bearer ${token}` };

test('POST / creates a direct chat with the current user and resolved target user', async () => {
  // Arrange
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
        return { id: 'room-1', createdAt: new Date('2024-01-01T00:00:00.000Z') };
      },
    },
  };

  // Act
  const res = await requestJson<{ id: string; type: string; name: string; unread_count: number }>(
    createChatRouter(prisma as never),
    '/',
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ type: 'direct', member_ids: ['bob'] }),
    },
  );

  // Assert
  expect(res.status).toBe(201);
  expect(res.body).toEqual({
    id: 'room-1',
    type: 'direct',
    name: 'Bob',
    member_ids: ['user-1', 'user-2'],
    unread_count: 0,
    created_at: '2024-01-01T00:00:00.000Z',
  });
  expect(createdMembers).toEqual([{ userId: 'user-1' }, { userId: 'user-2' }]);
});

test('POST / rejects unauthenticated chat creation before touching persistence', async () => {
  // Arrange
  let queriedUser = false;
  const prisma = {
    user: {
      findFirst: async () => {
        queriedUser = true;
        return null;
      },
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/', {
    method: 'POST',
    body: JSON.stringify({ type: 'direct', member_ids: ['bob'] }),
  });

  // Assert
  expect(res.status).toBe(401);
  expect(queriedUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Missing or invalid token',
    },
  });
});

test('POST / rejects direct chat creation with the current user', async () => {
  // Arrange
  const prisma = {
    user: {
      findFirst: async () => ({ id: 'user-1', displayName: 'Alice' }),
    },
    room: {
      findMany: async () => {
        throw new Error('room lookup should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'direct', member_ids: ['alice'] }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'cannot create a direct chat with yourself',
    },
  });
});

test('POST / rejects null member_ids before resolving users', async () => {
  // Arrange
  let resolvedUser = false;
  const prisma = {
    user: {
      findFirst: async () => {
        resolvedUser = true;
        return null;
      },
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'direct', member_ids: null }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(resolvedUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'type and member_ids are required',
    },
  });
});

test('POST / rejects unsupported chat type', async () => {
  // Arrange
  const prisma = {
    user: {
      findFirst: async () => {
        throw new Error('user lookup should not be called for unsupported type');
      },
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'broadcast', member_ids: ['bob'] }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'type must be "direct" or "group"',
    },
  });
});

test('POST / creates a group chat with special characters in the name', async () => {
  // Arrange
  let createdMembers: Array<{ userId: string }> = [];
  const prisma = {
    user: {
      findFirst: async (args: { where: { OR: Array<{ id?: string; username?: string }> } }) => ({
        id: args.where.OR[0].id === 'bob' ? 'user-2' : 'user-3',
        displayName: 'Member',
      }),
    },
    room: {
      create: async (args: { data: { name: string; members: { create: Array<{ userId: string }> } } }) => {
        createdMembers = args.data.members.create;
        return { id: 'room-1', name: args.data.name, createdAt: new Date('2024-01-01T00:00:00.000Z') };
      },
    },
  };

  // Act
  const res = await requestJson<{ name: string; type: string }>(createChatRouter(prisma as never), '/', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ type: 'group', name: '工程 🚀 <team>', member_ids: ['bob', 'carol'] }),
  });

  // Assert
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ type: 'group', name: '工程 🚀 <team>' });
  expect(createdMembers).toEqual([{ userId: 'user-1' }, { userId: 'user-2' }, { userId: 'user-3' }]);
});

test('GET /:chatId/messages rejects non-members before querying messages', async () => {
  // Arrange
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

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/room-1/messages', {
    headers: authHeaders,
  });

  // Assert
  expect(res.status).toBe(403);
  expect(queriedMessages).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'FORBIDDEN',
      message: 'Not a member of this chat',
    },
  });
});

test('GET /:chatId/messages caps requested page size at 100', async () => {
  // Arrange
  let capturedTake = 0;
  const prisma = {
    roomMember: {
      findUnique: async () => ({ userId: 'user-1', roomId: 'room-1' }),
    },
    message: {
      findMany: async (args: { take: number }) => {
        capturedTake = args.take;
        return [];
      },
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/room-1/messages?limit=500', {
    headers: authHeaders,
  });

  // Assert
  expect(res.status).toBe(200);
  expect(capturedTake).toBe(100);
  expect(res.body).toEqual([]);
});

test('POST /:chatId/messages trims content, persists the message, and updates room order timestamp', async () => {
  // Arrange
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

  // Act
  const res = await requestJson<{ id: string; body: string; created_at: string }>(
    createChatRouter(prisma as never),
    '/room-1/messages',
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ body: '  hello  ' }),
    },
  );

  // Assert
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

test('POST /:chatId/messages waits for asynchronous room timestamp update before responding', async () => {
  // Arrange
  const createdAt = new Date('2026-05-07T10:00:00.000Z');
  let updateFinished = false;
  const prisma = {
    roomMember: {
      findUnique: async () => ({ userId: 'user-1', roomId: 'room-1' }),
    },
    message: {
      create: async () => ({
        id: 'msg-1',
        content: 'hello',
        createdAt,
        senderId: 'user-1',
        roomId: 'room-1',
      }),
    },
    room: {
      update: async () => new Promise((resolve) => {
        setTimeout(() => {
          updateFinished = true;
          resolve({});
        }, 10);
      }),
    },
  };

  // Act
  const res = await requestJson(createChatRouter(prisma as never), '/room-1/messages', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ body: 'hello' }),
  });

  // Assert
  expect(res.status).toBe(201);
  expect(updateFinished).toBe(true);
});
