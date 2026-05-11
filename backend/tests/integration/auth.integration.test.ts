import { afterAll, beforeEach, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../../src/routes/auth.js';
import { requestJson } from '../helpers/request-json.js';
import { disconnectDatabase, prisma, resetDatabase } from '../helpers/db.js';

process.env.JWT_SECRET ??= 'unit-test-secret';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await disconnectDatabase();
});

test('register persists a user in PostgreSQL and returns a valid JWT', async () => {
  // Arrange
  const payload = {
    username: 'alice',
    email: 'alice@example.com',
    password: 'password123',
    display_name: 'Alice',
  };

  // Act
  const res = await requestJson<{ token: string; user: { id: string; username: string; display_name: string } }>(
    createAuthRouter(prisma),
    '/register',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );

  // Assert
  expect(res.status).toBe(201);
  expect(res.body.user.username).toBe('alice');
  expect(res.body.user.display_name).toBe('Alice');

  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
  expect(row.username).toBe('alice');
  expect(row.password).not.toBe('password123');

  const tokenPayload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as { userId: string; username: string };
  expect(tokenPayload.userId).toBe(row.id);
  expect(tokenPayload.username).toBe('alice');
});

test('register rejects duplicate username and leaves only one persisted user', async () => {
  // Arrange
  const payload = {
    username: 'alice',
    email: 'alice@example.com',
    password: 'password123',
    display_name: 'Alice',
  };
  await requestJson(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  // Act
  const res = await requestJson(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      email: 'alice2@example.com',
    }),
  });

  // Assert
  const users = await prisma.user.findMany({ where: { username: 'alice' } });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({
    error: {
      code: 'CONFLICT',
      message: 'Username already taken',
    },
  });
  expect(users).toHaveLength(1);
});

test('login authenticates a user created in PostgreSQL', async () => {
  // Arrange
  await requestJson(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  // Act
  const res = await requestJson<{ token: string; user: { username: string } }>(
    createAuthRouter(prisma),
    '/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    },
  );

  // Assert
  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe('alice');
  expect(typeof res.body.token).toBe('string');
});

test('login rejects an invalid password without leaking stored password details', async () => {
  // Arrange
  await requestJson(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  // Act
  const res = await requestJson(createAuthRouter(prisma), '/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' }),
  });

  // Assert
  expect(res.status).toBe(401);
  expect(JSON.stringify(res.body)).not.toContain('password123');
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Invalid email or password',
    },
  });
});
