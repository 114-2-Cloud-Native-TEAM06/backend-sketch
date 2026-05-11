import { expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createUserRouter } from '../../../src/routes/users.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const createdAt = new Date('2026-05-07T09:00:00.000Z');
const token = jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);
const authHeaders = { authorization: `Bearer ${token}` };

test('GET /me returns the current user dto', async () => {
  // Arrange
  const prisma = {
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        expect(args.where.id).toBe('user-1');
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
  const res = await requestJson<{ id: string; display_name: string; created_at: string }>(
    createUserRouter(prisma as never),
    '/me',
    { headers: authHeaders },
  );

  // Assert
  expect(res.status).toBe(200);
  expect(res.body.id).toBe('user-1');
  expect(res.body.display_name).toBe('Alice');
  expect(res.body.created_at).toBe(createdAt.toISOString());
});

test('GET /me rejects requests without a bearer token', async () => {
  // Arrange
  let queriedUser = false;
  const prisma = {
    user: {
      findUnique: async () => {
        queriedUser = true;
        return null;
      },
    },
  };

  // Act
  const res = await requestJson(createUserRouter(prisma as never), '/me');

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

test('PATCH /me requires at least one supported profile field', async () => {
  // Arrange
  const prisma = {
    user: {
      update: async () => {
        throw new Error('update should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createUserRouter(prisma as never), '/me', {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({}),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'At least one of display_name or avatar_url is required',
    },
  });
});

test('PATCH /me updates display name asynchronously and returns the updated dto', async () => {
  // Arrange
  const prisma = {
    user: {
      update: async (args: { where: { id: string }; data: { displayName?: string } }) => new Promise((resolve) => {
        setTimeout(() => resolve({
          id: args.where.id,
          username: 'alice',
          email: 'alice@example.com',
          displayName: args.data.displayName,
          createdAt,
        }), 10);
      }),
    },
  };

  // Act
  const res = await requestJson<{ display_name: string }>(createUserRouter(prisma as never), '/me', {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ display_name: 'Alice Updated' }),
  });

  // Assert
  expect(res.status).toBe(200);
  expect(res.body.display_name).toBe('Alice Updated');
});
