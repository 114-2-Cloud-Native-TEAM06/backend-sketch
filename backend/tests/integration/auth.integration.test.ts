import { afterAll, beforeEach, expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../../services/user-service/src/modules/auth/auth.routes.js';
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
      message: 'username already taken',
    },
  });
  expect(users).toHaveLength(1);
});

test('register persists special characters in display name without altering password hashing', async () => {
  // Arrange
  const displayName = 'Alice 測試 🚀 <script>';

  // Act
  const res = await requestJson<{ user: { display_name: string } }>(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: displayName,
    }),
  });

  // Assert
  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
  expect(res.status).toBe(201);
  expect(res.body.user.display_name).toBe(displayName);
  expect(row.displayName).toBe(displayName);
  expect(row.password).not.toBe('password123');
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

test('refresh exchanges a valid jwt for a new valid token', async () => {
  // Arrange
  const registerRes = await requestJson<{ token: string }>(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });
  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });

  // Act
  const res = await requestJson<{ token: string }>(createAuthRouter(prisma), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${registerRes.body.token}` },
  });

  // Assert
  expect(res.status).toBe(200);
  expect(Object.keys(res.body)).toEqual(['token']);
  const tokenPayload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as { userId: string; username: string };
  expect(tokenPayload.userId).toBe(row.id);
  expect(tokenPayload.username).toBe('alice');
});

test('refresh rejects tokens whose user no longer exists', async () => {
  // Arrange
  const registerRes = await requestJson<{ token: string }>(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });
  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
  await prisma.user.delete({ where: { id: row.id } });

  // Act
  const res = await requestJson(createAuthRouter(prisma), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${registerRes.body.token}` },
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

test('refresh rejects requests without a bearer token', async () => {
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
  const res = await requestJson(createAuthRouter(prisma), '/refresh', {
    method: 'POST',
  });

  // Assert
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Missing or invalid token',
    },
  });
});

test('refresh rejects tampered bearer tokens', async () => {
  // Arrange
  const token = jwt.sign({ userId: 'user-1', username: 'alice' }, 'wrong-secret'); // NOSONAR test fixture: deliberately-wrong secret in a negative auth test, not a production credential

  // Act
  const res = await requestJson(createAuthRouter(prisma), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  // Assert
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Token expired or invalid',
    },
  });
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
