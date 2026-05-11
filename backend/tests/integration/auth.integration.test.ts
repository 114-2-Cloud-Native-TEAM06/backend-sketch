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
  const res = await requestJson<{ token: string; user: { id: string; username: string; display_name: string } }>(
    createAuthRouter(prisma),
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
  expect(res.body.user.username).toBe('alice');
  expect(res.body.user.display_name).toBe('Alice');

  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
  expect(row.username).toBe('alice');
  expect(row.password).not.toBe('password123');

  const payload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as { userId: string; username: string };
  expect(payload.userId).toBe(row.id);
  expect(payload.username).toBe('alice');
});

test('login authenticates a user created in PostgreSQL', async () => {
  await requestJson(createAuthRouter(prisma), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  const res = await requestJson<{ token: string; user: { username: string } }>(
    createAuthRouter(prisma),
    '/login',
    {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
    },
  );

  expect(res.status).toBe(200);
  expect(res.body.user.username).toBe('alice');
  expect(typeof res.body.token).toBe('string');
});
