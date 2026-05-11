import { expect, test } from 'vitest';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import authMiddleware from '../../../src/middleware/auth.js';
import { requestJson } from '../../helpers/request-json.js';

process.env.JWT_SECRET = 'unit-test-secret';

function protectedRouter(): Router {
  const router = Router();
  router.get('/protected', authMiddleware, (req, res) => {
    res.json({ user: req.user });
  });
  return router;
}

test('auth middleware rejects missing bearer token', async () => {
  const res = await requestJson(protectedRouter(), '/protected');

  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Missing or invalid token',
    },
  });
});

test('auth middleware attaches verified jwt payload to request', async () => {
  const token = jwt.sign({ userId: 'user-1', username: 'alice' }, process.env.JWT_SECRET!);

  const res = await requestJson<{ user: { userId: string; username: string } }>(
    protectedRouter(),
    '/protected',
    { headers: { authorization: `Bearer ${token}` } },
  );

  expect(res.status).toBe(200);
  expect(res.body.user.userId).toBe('user-1');
  expect(res.body.user.username).toBe('alice');
});
