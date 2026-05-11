import { expect, test } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../../../src/routes/auth.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const createdAt = new Date('2026-05-07T09:00:00.000Z');

test('register validates required fields', async () => {
  // Arrange
  const prisma = {
    user: {
      findFirst: async () => null,
      create: async () => {
        throw new Error('create should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'alice' }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'username, email, password, display_name are required',
    },
  });
});

test('register rejects invalid username format before querying the database', async () => {
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
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'a',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(queriedUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'Username may only contain letters, numbers, _ and - (3–32 chars)',
    },
  });
});

test('register hashes the password and returns a signed token with user dto', async () => {
  // Arrange
  let capturedPassword = '';
  const prisma = {
    user: {
      findFirst: async () => null,
      create: async (args: { data: { password: string } }) => {
        capturedPassword = args.data.password;
        return {
          id: 'user-1',
          username: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt,
        };
      },
    },
  };

  // Act
  const res = await requestJson<{ token: string; user: { id: string; display_name: string; created_at: string } }>(
    createAuthRouter(prisma as never),
    '/register',
    {
      method: 'POST',
      body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.com',
        password: 'password123',
        display_name: 'Alice',
      }),
    },
  );

  // Assert
  expect(res.status).toBe(201);
  expect(res.body.user.id).toBe('user-1');
  expect(res.body.user.display_name).toBe('Alice');
  expect(res.body.user.created_at).toBe(createdAt.toISOString());
  expect(capturedPassword).not.toBe('password123');
  expect(await bcrypt.compare('password123', capturedPassword)).toBe(true);

  const payload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as { userId: string; username: string };
  expect(payload.userId).toBe('user-1');
  expect(payload.username).toBe('alice');
});

test('register returns conflict without exposing existing password data', async () => {
  // Arrange
  const prisma = {
    user: {
      findFirst: async () => ({
        id: 'user-1',
        username: 'alice',
        email: 'alice@example.com',
        password: 'hashed-secret',
      }),
      create: async () => {
        throw new Error('create should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(409);
  expect(JSON.stringify(res.body)).not.toContain('hashed-secret');
  expect(res.body).toEqual({
    error: {
      code: 'CONFLICT',
      message: 'Username already taken',
    },
  });
});

test('login rejects an invalid password', async () => {
  // Arrange
  const password = await bcrypt.hash('password123', 10);
  const prisma = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'alice',
        email: 'alice@example.com',
        displayName: 'Alice',
        createdAt,
        password,
      }),
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' }),
  });

  // Assert
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Invalid email or password',
    },
  });
});

test('login waits for asynchronous password comparison before returning success', async () => {
  // Arrange
  const password = await bcrypt.hash('password123', 10);
  const prisma = {
    user: {
      findUnique: async () => new Promise((resolve) => {
        setTimeout(() => resolve({
          id: 'user-1',
          username: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt,
          password,
        }), 10);
      }),
    },
  };

  // Act
  const res = await requestJson<{ token: string; user: { username: string } }>(
    createAuthRouter(prisma as never),
    '/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    },
  );

  // Assert
  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe('alice');
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET!)).toMatchObject({
    userId: 'user-1',
    username: 'alice',
  });
});
