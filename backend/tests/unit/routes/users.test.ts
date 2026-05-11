import { expect, test } from 'vitest';
import jwt from 'jsonwebtoken';
import { createUserRouter } from '../../../src/routes/users.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

const createdAt = new Date('2026-05-07T09:00:00.000Z');
const token = jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);
const authHeaders = { authorization: `Bearer ${token}` };

test('GET /me returns the current user dto', async () => {
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

  const res = await requestJson<{ id: string; display_name: string; created_at: string }>(
    createUserRouter(prisma as never),
    '/me',
    { headers: authHeaders },
  );

  expect(res.status).toBe(200);
  expect(res.body.id).toBe('user-1');
  expect(res.body.display_name).toBe('Alice');
  expect(res.body.created_at).toBe(createdAt.toISOString());
});

test('PATCH /me requires at least one supported profile field', async () => {
  const prisma = {
    user: {
      update: async () => {
        throw new Error('update should not be called');
      },
    },
  };

  const res = await requestJson(createUserRouter(prisma as never), '/me', {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(400);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'At least one of display_name or avatar_url is required',
    },
  });
});
