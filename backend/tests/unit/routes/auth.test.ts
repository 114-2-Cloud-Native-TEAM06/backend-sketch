import { expect, test } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../../../src/routes/auth.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const createdAt = new Date('2026-05-07T09:00:00.000Z');

test('register validates required fields', async () => {
  const prisma = {
    user: {
      findFirst: async () => null,
      create: async () => {
        throw new Error('create should not be called');
      },
    },
  };

  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({ username: 'alice' }),
  });

  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'username, email, password, display_name are required',
    },
  });
});

test('register hashes the password and returns a signed token with user dto', async () => {
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

test('login rejects an invalid password', async () => {
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

  const res = await requestJson(createAuthRouter(prisma as never), '/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password' }),
  });

  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Invalid email or password',
    },
  });
});
