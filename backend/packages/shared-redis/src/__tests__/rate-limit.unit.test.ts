import { expect, test } from 'vitest';
import { FakeRedis, checkRateLimit } from '../index.js';

test('allows requests inside the configured fixed window limit', async () => {
  // Arrange
  const redis = new FakeRedis();

  // Act
  const first = await checkRateLimit(redis, 'user-1', {
    keyPrefix: 'unit',
    limit: 2,
    windowSeconds: 60,
  });
  const second = await checkRateLimit(redis, 'user-1', {
    keyPrefix: 'unit',
    limit: 2,
    windowSeconds: 60,
  });

  // Assert
  expect(first.allowed).toBe(true);
  expect(second.allowed).toBe(true);
});

test('rejects requests after the configured fixed window limit', async () => {
  // Arrange
  const redis = new FakeRedis();
  const options = { keyPrefix: 'unit', limit: 1, windowSeconds: 60 };

  // Act
  const first = await checkRateLimit(redis, 'user-1', options);
  const second = await checkRateLimit(redis, 'user-1', options);

  // Assert
  expect(first.allowed).toBe(true);
  expect(second.allowed).toBe(false);
  expect(second.count).toBe(2);
});
