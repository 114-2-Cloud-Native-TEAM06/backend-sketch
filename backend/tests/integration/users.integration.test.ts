import jwt from 'jsonwebtoken';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { createUserRouter } from '../../src/routes/users.js';
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

test('returns the authenticated user profile from PostgreSQL', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice 測試',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson<{ id: string; display_name: string }>(createUserRouter(prisma), '/me', {
    headers: authHeaders(alice.id, alice.username),
  });

  // Assert
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    id: alice.id,
    display_name: 'Alice 測試',
  });
});

test('rejects unauthenticated profile access', async () => {
  // Arrange
  await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson(createUserRouter(prisma), '/me');

  // Assert
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Missing or invalid token',
    },
  });
});

test('updates the authenticated user display name in PostgreSQL', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });
  const displayName = 'Alice Updated 🚀';

  // Act
  const res = await requestJson<{ display_name: string }>(createUserRouter(prisma), '/me', {
    method: 'PATCH',
    headers: authHeaders(alice.id, alice.username),
    body: JSON.stringify({ display_name: displayName }),
  });

  // Assert
  const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
  expect(res.status).toBe(200);
  expect(res.body.display_name).toBe(displayName);
  expect(row.displayName).toBe(displayName);
});

test('rejects null profile updates without changing the user row', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson(createUserRouter(prisma), '/me', {
    method: 'PATCH',
    headers: authHeaders(alice.id, alice.username),
    body: JSON.stringify({ display_name: null, avatar_url: null }),
  });

  // Assert
  const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
  expect(res.status).toBe(400);
  expect(row.displayName).toBe('Alice');
});

test('returns another user by id without exposing password data', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password-alice',
    },
  });
  const bob = await prisma.user.create({
    data: {
      username: 'bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      password: 'hashed-password-bob',
    },
  });

  // Act
  const res = await requestJson(createUserRouter(prisma), `/${bob.id}`, {
    headers: authHeaders(alice.id, alice.username),
  });

  // Assert
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain('hashed-password-bob');
  expect(res.body).toMatchObject({
    id: bob.id,
    username: 'bob',
    display_name: 'Bob',
  });
});

test('returns not found for an unknown user id', async () => {
  // Arrange
  const alice = await prisma.user.create({
    data: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'hashed-password',
    },
  });

  // Act
  const res = await requestJson(createUserRouter(prisma), '/missing-user', {
    headers: authHeaders(alice.id, alice.username),
  });

  // Assert
  expect(res.status).toBe(404);
  expect(res.body).toEqual({
    error: {
      code: 'NOT_FOUND',
      message: 'User not found',
    },
  });
});
