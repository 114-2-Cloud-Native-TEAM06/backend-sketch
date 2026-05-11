import { once } from 'events';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { afterEach, expect, test } from 'vitest';
import { startWebSocketServer } from '../../src/index.js';

process.env.JWT_SECRET ??= 'unit-test-secret';

let activeServer: ReturnType<typeof startWebSocketServer> | undefined;

function token(): string {
  return jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);
}

async function startServer(): Promise<number> {
  activeServer = startWebSocketServer(0);
  await once(activeServer, 'listening');
  return (activeServer.address() as AddressInfo).port;
}

function connect(port: number, query = `token=${token()}`): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/chat?${query}`);
}

async function waitForJsonMessage<T>(ws: WebSocket, timeoutMs = 250): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()) as T);
    });
  });
}

async function expectNoMessage(ws: WebSocket, timeoutMs = 50): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected WebSocket message: ${data.toString()}`));
    });
  });
}

afterEach(async () => {
  if (!activeServer) return;

  const server = activeServer;
  activeServer = undefined;
  server.clients.forEach((client) => client.close());
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

test('websocket rejects missing token connections', async () => {
  // Arrange
  const port = await startServer();
  const ws = connect(port, '');

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
  const ws = connect(port, `token=${badToken}`);

  // Act
  const [code, reason] = await once(ws, 'close') as [number, Buffer];

  // Assert
  expect(code).toBe(1008);
  expect(reason.toString()).toBe('auth_expired');
});

test('websocket responds asynchronously to ping frames', async () => {
  // Arrange
  const port = await startServer();
  const ws = connect(port);
  await once(ws, 'open');

  // Act
  ws.send(JSON.stringify({ type: 'ping' }));
  const frame = await waitForJsonMessage<{ type: string }>(ws);

  // Assert
  expect(frame).toEqual({ type: 'pong' });
});

test('websocket ignores malformed frames until timeout without closing the connection', async () => {
  // Arrange
  const port = await startServer();
  const ws = connect(port);
  await once(ws, 'open');

  // Act
  ws.send('{bad json');
  await expectNoMessage(ws);

  // Assert
  expect(ws.readyState).toBe(WebSocket.OPEN);
});
