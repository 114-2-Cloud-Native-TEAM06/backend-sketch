import { once } from 'events';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
import { startWebSocketServer } from '../../services/realtime-service/src/modules/realtime/realtime.server.js';
import { disconnectDatabase, prisma, resetDatabase } from '../helpers/db.js';
import { FakeRedis, roomEventChannel } from '../../packages/shared-redis/src/index.js';
import { InMemoryMessageWriteBuffer } from '../../packages/shared-nats/src/index.js';
import {
  connectWs,
  expectNoMessage,
  openWs,
  sendJson,
  waitForJsonFrame,
  waitForJsonMessage,
} from '../helpers/ws-client.js';
import type { WsServerFrame } from '../../packages/shared-types/src/api-types.js';

process.env.JWT_SECRET ??= 'unit-test-secret';

let activeServers: Array<ReturnType<typeof startWebSocketServer>> = [];
const originalRateLimitMode = process.env.WS_RATE_LIMIT_MODE;
const originalSendRateLimit = process.env.WS_SEND_RATE_LIMIT_PER_SEC;

function token(userId = 'user-1', username = 'alice'): string {
  return jwt.sign({ userId, username }, process.env.JWT_SECRET!);
}

async function startServer(): Promise<number> {
  const server = startWebSocketServer(0, prisma);
  activeServers.push(server);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function startServerWithRedis(redis: FakeRedis): Promise<number> {
  const server = startWebSocketServer(0, prisma, {
    redis,
    publisher: redis.duplicate(),
    subscriber: redis.duplicate(),
  });
  activeServers.push(server);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function startServerWithBuffer(buffer: InMemoryMessageWriteBuffer): Promise<number> {
  const server = startWebSocketServer(0, prisma, { messageWritePublisher: buffer });
  activeServers.push(server);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
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
  const servers = activeServers;
  activeServers = [];
  restoreRateLimitEnv();
  await Promise.all(servers.map(async (server) => {
    server.clients.forEach((client) => client.close());
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }));
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

test('send publishes a buffered write command and returns ack without writing PostgreSQL first', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const buffer = new InMemoryMessageWriteBuffer();
  const port = await startServerWithBuffer(buffer);
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

  const messageCount = await prisma.message.count({ where: { id: ack.message_id } });
  const writeCount = await prisma.messageWrite.count({ where: { id: ack.message_id } });
  expect(writeCount).toBe(0);
  expect(messageCount).toBe(0);
  expect(buffer.commands).toEqual([
    expect.objectContaining({
      message_id: ack.message_id,
      request_id: 'req-1',
      sender_id: alice.id,
      room_id: room.id,
      body: 'hello ws',
      accepted_at: ack.accepted_at,
    }),
  ]);
});

test('send returns buffer_unavailable when no message write publisher is configured', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const port = await startServer();
  const ws = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  sendJson(ws, { type: 'send', request_id: 'req-no-buffer', chat_id: room.id, body: 'ingress only' });
  const frame = await waitForJsonFrame<WsServerFrame>(
    ws,
    (msg) => msg.type === 'error' && msg.request_id === 'req-no-buffer',
  );

  // Assert
  expect(frame).toMatchObject({
    type: 'error',
    reason: 'buffer_unavailable',
    request_id: 'req-no-buffer',
  });
  expect(await prisma.message.count()).toBe(0);
  expect(await prisma.messageWrite.count()).toBe(0);
});

test('send is idempotent for duplicate request_id from the same sender', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const buffer = new InMemoryMessageWriteBuffer();
  const port = await startServerWithBuffer(buffer);
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
  const writes = await prisma.messageWrite.findMany({ where: { senderId: alice.id, requestId: 'req-duplicate' } });
  expect(writes).toHaveLength(0);
  expect(buffer.commands).toHaveLength(2);
  expect(buffer.commands.map((command) => command.message_id)).toEqual([firstAck.message_id, firstAck.message_id]);
});

test('send returns rate_limited when the local websocket limit is exceeded', async () => {
  // Arrange
  process.env.WS_RATE_LIMIT_MODE = 'local';
  process.env.WS_SEND_RATE_LIMIT_PER_SEC = '1';
  const { alice, room } = await seedUsersAndRooms();
  const buffer = new InMemoryMessageWriteBuffer();
  const port = await startServerWithBuffer(buffer);
  const ws = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  sendJson(ws, { type: 'send', request_id: 'req-rate-1', chat_id: room.id, body: 'first' });
  const ack = await waitForJsonFrame<WsServerFrame>(
    ws,
    (frame) => frame.type === 'ack' && frame.request_id === 'req-rate-1',
  );
  sendJson(ws, { type: 'send', request_id: 'req-rate-2', chat_id: room.id, body: 'second' });
  const error = await waitForJsonFrame<WsServerFrame>(
    ws,
    (frame) => frame.type === 'error' && frame.reason === 'rate_limited',
  );

  // Assert
  expect(ack).toMatchObject({ type: 'ack', request_id: 'req-rate-1' });
  expect(error).toMatchObject({ type: 'error', reason: 'rate_limited' });
  expect(buffer.commands).toHaveLength(1);
});

test('redis room events broadcast msg to same-room clients only', async () => {
  // Arrange
  const { alice, bob, carol, room } = await seedUsersAndRooms();
  const redis = new FakeRedis();
  const port = await startServerWithRedis(redis);
  const aliceWs = await openWs(port, `token=${token(alice.id, alice.username)}`);
  const bobWs = await openWs(port, `token=${token(bob.id, bob.username)}`);
  const carolWs = await openWs(port, `token=${token(carol.id, carol.username)}`);

  // Act
  await redis.publish(roomEventChannel(room.id), JSON.stringify({
    type: 'message.created',
    room_id: room.id,
    message: {
      id: 'msg-broadcast',
      chat_id: room.id,
      sender_id: alice.id,
      type: 'TEXT',
      body: 'fan out',
      created_at: '2026-05-30T11:00:00.000Z',
    },
  }));
  const bobFrame = await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (frame) => frame.type === 'msg' && frame.message.body === 'fan out',
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

function restoreRateLimitEnv(): void {
  if (originalRateLimitMode === undefined) {
    delete process.env.WS_RATE_LIMIT_MODE;
  } else {
    process.env.WS_RATE_LIMIT_MODE = originalRateLimitMode;
  }

  if (originalSendRateLimit === undefined) {
    delete process.env.WS_SEND_RATE_LIMIT_PER_SEC;
  } else {
    process.env.WS_SEND_RATE_LIMIT_PER_SEC = originalSendRateLimit;
  }
}

test('send from a non-member returns forbidden and does not persist a message', async () => {
  // Arrange
  const { carol, room } = await seedUsersAndRooms();
  const port = await startServer();
  const carolWs = await openWs(port, `token=${token(carol.id, carol.username)}`);

  // Act
  sendJson(carolWs, { type: 'send', request_id: 'req-forbidden', chat_id: room.id, body: 'no access' });
  const frame = await waitForJsonFrame<WsServerFrame>(carolWs, (msg) => msg.type === 'error');

  // Assert
  expect(frame).toMatchObject({ type: 'error', reason: 'forbidden', request_id: 'req-forbidden' });
  const messageCount = await prisma.message.count({ where: { roomId: room.id } });
  expect(messageCount).toBe(0);
});

test('send returns a request-scoped error when buffer enqueue fails', async () => {
  // Arrange
  const { alice, room } = await seedUsersAndRooms();
  const failingBuffer = new InMemoryMessageWriteBuffer(() => {
    throw new Error('jetstream unavailable');
  });
  const port = await startServerWithBuffer(failingBuffer);
  const ws = await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Act
  sendJson(ws, { type: 'send', request_id: 'req-buffer-fail', chat_id: room.id, body: 'will fail' });
  const frame = await waitForJsonFrame<WsServerFrame>(
    ws,
    (msg) => msg.type === 'error' && msg.request_id === 'req-buffer-fail',
  );

  // Assert
  expect(frame).toMatchObject({
    type: 'error',
    reason: 'buffer_unavailable',
    request_id: 'req-buffer-fail',
  });
  const writeCount = await prisma.messageWrite.count({
    where: { senderId: alice.id, requestId: 'req-buffer-fail' },
  });
  expect(writeCount).toBe(0);
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

test('newly connected client receives presence for already-online room members', async () => {
  const { alice, bob } = await seedUsersAndRooms();
  const port = await startServer();

  // Alice connects first and waits for setup to complete
  await openWs(port, `token=${token(alice.id, alice.username)}`);

  // Bob connects after — should immediately receive Alice's online presence
  const bobWs = await openWs(port, `token=${token(bob.id, bob.username)}`);
  const frame = await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (f) => f.type === 'presence' && f.user_id === alice.id && f.online,
  );

  expect(frame).toEqual({ type: 'presence', user_id: alice.id, online: true });
});

test('redis pubsub relays messages between websocket server instances', async () => {
  // Arrange
  const { alice, bob, room } = await seedUsersAndRooms();
  const redis = new FakeRedis();
  const alicePort = await startServerWithRedis(redis);
  const bobPort = await startServerWithRedis(redis);
  const bobWs = await openWs(bobPort, `token=${token(bob.id, bob.username)}`);
  await openWs(alicePort, `token=${token(alice.id, alice.username)}`);
  await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (frame) => frame.type === 'presence' && frame.user_id === alice.id && frame.online,
    'bob indexed before cross-instance message',
    1000,
  );

  // Act
  await redis.publish(roomEventChannel(room.id), JSON.stringify({
    type: 'message.created',
    room_id: room.id,
    message: {
      id: 'msg-cross-instance',
      chat_id: room.id,
      sender_id: alice.id,
      type: 'TEXT',
      body: 'cross instance',
      created_at: '2026-05-30T11:00:00.000Z',
    },
  }));
  const bobFrame = await waitForJsonFrame<WsServerFrame>(
    bobWs,
    (frame) => frame.type === 'msg' && frame.message.body === 'cross instance',
    'cross instance msg',
    1000,
  );

  // Assert
  expect(bobFrame).toMatchObject({
    type: 'msg',
    message: {
      chat_id: room.id,
      sender_id: alice.id,
      body: 'cross instance',
    },
  });
});

test('redis presence relays online and offline frames between websocket server instances', async () => {
  // Arrange
  const { alice, bob } = await seedUsersAndRooms();
  const redis = new FakeRedis();
  const alicePort = await startServerWithRedis(redis);
  const bobPort = await startServerWithRedis(redis);
  const aliceWs = await openWs(alicePort, `token=${token(alice.id, alice.username)}`);

  // Act
  const bobWs = await openWs(bobPort, `token=${token(bob.id, bob.username)}`);
  const onlineFrame = await waitForJsonFrame<WsServerFrame>(
    aliceWs,
    (frame) => frame.type === 'presence' && frame.user_id === bob.id && frame.online,
    'cross instance online',
    1000,
  );
  bobWs.close();
  const offlineFrame = await waitForJsonFrame<WsServerFrame>(
    aliceWs,
    (frame) => frame.type === 'presence' && frame.user_id === bob.id && !frame.online,
    'cross instance offline',
    1000,
  );

  // Assert
  expect(onlineFrame).toEqual({ type: 'presence', user_id: bob.id, online: true });
  expect(offlineFrame).toEqual({ type: 'presence', user_id: bob.id, online: false });
});
