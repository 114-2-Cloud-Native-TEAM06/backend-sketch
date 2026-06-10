import { expect, test } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createAuthRouter } from '../auth.routes.js';
import { requestJson } from '../../../../../../tests/helpers/request-json.js';

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
      message: 'username must be 3-32 characters and contain only letters, numbers, "_" or "-"',
    },
  });
});

test('register rejects extreme length username before querying the database', async () => {
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
      username: 'a'.repeat(1000),
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
      message: 'username must be 3-32 characters and contain only letters, numbers, "_" or "-"',
    },
  });
});

test('register rejects null password values before persistence', async () => {
  // Arrange
  let createdUser = false;
  const prisma = {
    user: {
      create: async () => {
        createdUser = true;
        return {};
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'not-an-email',
      password: null,
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(createdUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'username, email, password, display_name are required',
    },
  });
});

test('register rejects non-string password values before persistence', async () => {
  // Arrange
  let createdUser = false;
  const prisma = {
    user: {
      create: async () => {
        createdUser = true;
        return {};
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 12345678,
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(createdUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'username, email, password, display_name are required',
    },
  });
});

test('register rejects invalid email format before persistence', async () => {
  // Arrange
  let createdUser = false;
  const prisma = {
    user: {
      create: async () => {
        createdUser = true;
        return {};
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'not-an-email',
      password: 'password123',
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(createdUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'email must be a valid email address',
    },
  });
});

test('register rejects short passwords before persistence', async () => {
  // Arrange
  let createdUser = false;
  const prisma = {
    user: {
      create: async () => {
        createdUser = true;
        return {};
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'alice',
      email: 'alice@example.com',
      password: 'short',
      display_name: 'Alice',
    }),
  });

  // Assert
  expect(res.status).toBe(400);
  expect(createdUser).toBe(false);
  expect(res.body).toEqual({
    error: {
      code: 'VALIDATION_FAILED',
      message: 'password must be at least 8 characters',
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
      message: 'username already taken',
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

test('refresh returns a token for a valid bearer token and current persisted user', async () => {
  // Arrange
  const token = jwt.sign({ userId: 'user-1', username: 'stale-alice' }, process.env.JWT_SECRET!);
  let capturedUserId = '';
  const prisma = {
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        capturedUserId = args.where.id;
        return {
          id: 'user-1',
          username: 'alice',
          email: 'alice@example.com',
          displayName: 'Alice',
          createdAt,
        };
      },
      findFirst: async () => {
        throw new Error('user conflict lookup should not be called');
      },
      create: async () => {
        throw new Error('user create should not be called');
      },
    },
  };

  // Act
  const res = await requestJson<{ token: string }>(createAuthRouter(prisma as never), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  // Assert
  expect(res.status).toBe(200);
  expect(capturedUserId).toBe('user-1');
  expect(Object.keys(res.body)).toEqual(['token']);
  expect(jwt.verify(res.body.token, process.env.JWT_SECRET!)).toMatchObject({
    userId: 'user-1',
    username: 'alice',
  });
});

test('refresh rejects signed tokens with incomplete auth payload before persistence', async () => {
  // Arrange
  const token = jwt.sign({ username: 'alice' }, process.env.JWT_SECRET!);
  const prisma = {
    user: {
      findUnique: async () => {
        throw new Error('user lookup should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  // Assert
  expect(res.status).toBe(401);
  expect(res.body).toEqual({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Invalid token payload',
    },
  });
});

test('refresh rejects tokens for users that no longer exist', async () => {
  // Arrange
  const token = jwt.sign({ userId: 'deleted-user', username: 'alice' }, process.env.JWT_SECRET!);
  const prisma = {
    user: {
      findUnique: async () => null,
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
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

test('refresh rejects missing bearer token', async () => {
  // Arrange
  const prisma = {
    user: {
      findUnique: async () => {
        throw new Error('user lookup should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/refresh', {
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
  const prisma = {
    user: {
      findUnique: async () => {
        throw new Error('user lookup should not be called');
      },
    },
  };

  // Act
  const res = await requestJson(createAuthRouter(prisma as never), '/refresh', {
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
