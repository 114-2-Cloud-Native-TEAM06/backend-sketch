import { once } from 'events';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { startWebSocketServer } from '../../src/index.js';
import { disconnectDatabase, prisma, resetDatabase } from '../helpers/db.js';
import {
  connectWs,
  expectNoMessage,
  openWs,
  sendJson,
  waitForJsonFrame,
  waitForJsonMessage,
} from '../helpers/ws-client.js';
import type { WsServerFrame } from '../../src/types/api-types.js';

process.env.JWT_SECRET ??= 'unit-test-secret';

let activeServer: ReturnType<typeof startWebSocketServer> | undefined;

function token(userId = 'user-1', username = 'alice'): string {
  return jwt.sign({ userId, username }, process.env.JWT_SECRET!);
}

async function startServer(): Promise<number> {
  activeServer = startWebSocketServer(0, prisma);
  await once(activeServer, 'listening');
  return (activeServer.address() as AddressInfo).port;
}

async function seedUsersAndRooms(): Promise<{
  alice: { id: string; username: string };
  bob: { id: string; username: string };
  carol: { id: string; username: string };
  room: { id: string };
  otherRoom: { id: string };
}> {
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
  const room = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });
  const otherRoom = await prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: carol.id }] },
    },
  });

  return { alice, bob, carol, room, otherRoom };
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  if (!activeServer) return;

  const server = activeServer;
  activeServer = undefined;
  server.clients.forEach((client) => client.close());
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

afterAll(async () => {
  await resetDatabase();
  await disconnectDatabase();
});

test('websocket rejects missing token connections', async () => {
  // Arrange
  const port = await startServer();
  const ws = connectWs(port, '');

  // Act
  const [code, reason] = await once(ws, 'close') as [number, Buffer];

  // Assert
  expect(code).toBe(1008);
  expect(reason.toString()).toBe('auth_expired');
});

test('websocket rejects tampered token connections', async () => {
  // Arrange
  const port = await startServer();
  const badToken = jwt.sign({ userId: 'user-1', username: 'alice' }, 'wrong-secret');
  const ws = connectWs(port, `token=${badToken}`);

  // Act
  const [code, reason] = await once(ws, 'close') as [number, Buffer];

  // Assert
  expect(code).toBe(1008);
  expect(reason.toString()).toBe('auth_expired');
});

test('websocket responds asynchronously to ping frames', async () => {
  // Arrange
  const port = await startServer();
  const ws = await openWs(port, `token=${token()}`);

  // Act
  sendJson(ws, { type: 'ping' });
  const frame = await waitForJsonMessage<{ type: string }>(ws);

  // Assert
  expect(frame).toEqual({ type: 'pong' });
});

test('websocket ignores malformed frames until timeout without closing the connection', async () => {
  // Arrange
  const port = await startServer();
  const ws = await openWs(port, `token=${token()}`);

  // Act
  ws.send('{bad json');
  await expectNoMessage(ws);

  // Assert
  expect(ws.readyState).toBe(WebSocket.OPEN);
});

test('send persists a message, updates room lastMessageAt, and returns ack', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const port = await startServer();
  const ws = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  sendJson(ws, { type: 'send', request_id: 'req-1', chat_id: room.id, body: '  hello ws  ' });
  const ack = await waitForJsonFrame<WsServerFrame>(
    ws,
    (frame) => frame.type === 'ack' && frame.request_id === 'req-1',
  );

  // Assert
  expect(ack).toMatchObject({ type: 'ack', request_id: 'req-1' });
  if (ack.type !== 'ack') throw new Error('expected ack');

  const message = await prisma.message.findUniqueOrThrow({ where: { id: ack.message_id } });
  const updatedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  expect(message.content).toBe('hello ws');
  expect(message.senderId).toBe(alice.id);
  expect(message.roomId).toBe(room.id);
  expect(message.requestId).toBe('req-1');
  expect(updatedRoom.lastMessageAt.toISOString()).toBe(message.createdAt.toISOString());
  expect(ack.persisted_at).toBe(message.createdAt.toISOString());
});

test('send is idempotent for duplicate request_id from the same sender', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const port = await startServer();
  const ws = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  sendJson(ws, { type: 'send', request_id: 'req-duplicate', chat_id: room.id, body: 'first' });
  const firstAck = await waitForJsonFrame<WsServerFrame>(
    ws,
    (frame) => frame.type === 'ack' && frame.request_id === 'req-duplicate',
  );
  sendJson(ws, { type: 'send', request_id: 'req-duplicate', chat_id: room.id, body: 'second' });
  const secondAck = await waitForJsonFrame<WsServerFrame>(
    ws,
    (frame) => frame.type === 'ack' && frame.request_id === 'req-duplicate',
  );

  // Assert
  if (firstAck.type !== 'ack' || secondAck.type !== 'ack') throw new Error('expected ack frames');
  expect(secondAck.message_id).toBe(firstAck.message_id);
  const messages = await prisma.message.findMany({ where: { senderId: alice.id, requestId: 'req-duplicate' } });
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe('first');
});

test('send broadcasts msg to same-room clients only', async () => {
  // Arrange
  const { alice, bob, carol, room } = await seedUsersAndRooms();
  const port = await startServer();
  const aliceWs = await openWs(port, `token=${token(alice.id, alice.username)}`);
  const bobWs = await openWs(port, `token=${token(bob.id, bob.username)}`);
  const carolWs = await openWs(port, `token=${token(carol.id, carol.username)}`);

  // Act
  sendJson(aliceWs, { type: 'send', request_id: 'req-broadcast', chat_id: room.id, body: 'fan out' });
  const bobFrame = await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (frame) => frame.type === 'msg' && frame.message.body === 'fan out',
  );
  await waitForJsonFrame<WsServerFrame>(
    aliceWs,
    (frame) => frame.type === 'ack' && frame.request_id === 'req-broadcast',
  );

  // Assert
  expect(bobFrame).toMatchObject({
    type: 'msg',
    message: {
      chat_id: room.id,
      sender_id: alice.id,
      body: 'fan out',
    },
  });
  await expectNoMessage(carolWs);
});

test('send from a non-member returns forbidden and does not persist a message', async () => {
  // Arrange
  const { carol, room } = await seedUsersAndRooms();
  const port = await startServer();
  const carolWs = await openWs(port, `token=${token(carol.id, carol.username)}`);

  // Act
  sendJson(carolWs, { type: 'send', request_id: 'req-forbidden', chat_id: room.id, body: 'no access' });
  const frame = await waitForJsonFrame<WsServerFrame>(carolWs, (msg) => msg.type === 'error');

  // Assert
  expect(frame).toMatchObject({ type: 'error', reason: 'forbidden' });
  const messageCount = await prisma.message.count({ where: { roomId: room.id } });
  expect(messageCount).toBe(0);
});

test('typing is relayed to room members only', async () => {
  // Arrange
  const { alice, bob, carol, room } = await seedUsersAndRooms();
  const port = await startServer();
  const aliceWs = await openWs(port, `token=${token(alice.id, alice.username)}`);
  const bobWs = await openWs(port, `token=${token(bob.id, bob.username)}`);
  const carolWs = await openWs(port, `token=${token(carol.id, carol.username)}`);

  // Act
  sendJson(aliceWs, { type: 'typing', chat_id: room.id, is_typing: true });
  const frame = await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (msg) => msg.type === 'typing' && msg.user_id === alice.id,
  );

  // Assert
  expect(frame).toEqual({
    type: 'typing',
    chat_id: room.id,
    user_id: alice.id,
    is_typing: true,
  });
  await expectNoMessage(carolWs);
});

test('presence online and offline frames reach contacts in shared rooms', async () => {
  // Arrange
  const { alice, bob } = await seedUsersAndRooms();
  const port = await startServer();
  const aliceWs = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  const bobWs = await openWs(port, `token=${token(bob.id, bob.username)}`);
  const onlineFrame = await waitForJsonFrame<WsServerFrame>(
    aliceWs,
    (frame) => frame.type === 'presence' && frame.user_id === bob.id && frame.online,
  );
  bobWs.close();
  const offlineFrame = await waitForJsonFrame<WsServerFrame>(
    aliceWs,
    (frame) => frame.type === 'presence' && frame.user_id === bob.id && !frame.online,
  );

  // Assert
  expect(onlineFrame).toEqual({ type: 'presence', user_id: bob.id, online: true });
  expect(offlineFrame).toEqual({ type: 'presence', user_id: bob.id, online: false });
});
