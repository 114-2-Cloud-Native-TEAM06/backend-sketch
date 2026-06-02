import { describe, expect, test } from 'vitest';
import { FakeRedis } from '../../../../../../packages/shared-redis/src/index.js';
import {
  createRealtimeRateLimiter,
  parseRealtimeRateLimitMode,
} from '../realtime-rate-limit.js';

describe('parseRealtimeRateLimitMode', () => {
  test('defaults to local when mode is not recognized', () => {
    expect(parseRealtimeRateLimitMode(undefined)).toBe('local');
    expect(parseRealtimeRateLimitMode('invalid')).toBe('local');
  });
});

describe('createRealtimeRateLimiter', () => {
  test('allows requests until the local window limit is exceeded', async () => {
    // Arrange
    let now = 1_000;
    const limiter = createRealtimeRateLimiter(undefined, {
      mode: 'local',
      nowMs: () => now,
    });
    const options = { keyPrefix: 'ws:send', limit: 2, windowSeconds: 1 };

    // Act
    const first = await limiter.check('user-1', options);
    const second = await limiter.check('user-1', options);
    const third = await limiter.check('user-1', options);
    now = 2_001;
    const afterReset = await limiter.check('user-1', options);

    // Assert
    expect(limiter.mode).toBe('local');
    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second).toEqual({ allowed: true, count: 2 });
    expect(third).toEqual({ allowed: false, count: 3 });
    expect(afterReset).toEqual({ allowed: true, count: 1 });
  });

  test('keeps local windows isolated by prefix and user', async () => {
    // Arrange
    const limiter = createRealtimeRateLimiter(undefined, { mode: 'local', nowMs: () => 1_000 });

    // Act
    await limiter.check('user-1', { keyPrefix: 'ws:send', limit: 1, windowSeconds: 1 });
    const sameUserDifferentPrefix = await limiter.check('user-1', {
      keyPrefix: 'ws:typing',
      limit: 1,
      windowSeconds: 1,
    });
    const differentUserSamePrefix = await limiter.check('user-2', {
      keyPrefix: 'ws:send',
      limit: 1,
      windowSeconds: 1,
    });

    // Assert
    expect(sameUserDifferentPrefix).toEqual({ allowed: true, count: 1 });
    expect(differentUserSamePrefix).toEqual({ allowed: true, count: 1 });
  });

  test('uses Redis rate-limit keys when redis mode is configured', async () => {
    // Arrange
    const redis = new FakeRedis();
    const limiter = createRealtimeRateLimiter(redis, { mode: 'redis' });

    // Act
    const result = await limiter.check('user-1', {
      keyPrefix: 'ws:send',
      limit: 1,
      windowSeconds: 1,
    });
    const redisValue = await redis.get('rate:ws:send:user-1');

    // Assert
    expect(limiter.mode).toBe('redis');
    expect(result).toEqual({ allowed: true, count: 1 });
    expect(redisValue).toBe('1');
  });

  test('off mode always allows requests without touching Redis', async () => {
    // Arrange
    const redis = new FakeRedis();
    const limiter = createRealtimeRateLimiter(redis, { mode: 'off' });

    // Act
    const result = await limiter.check('user-1', {
      keyPrefix: 'ws:send',
      limit: 0,
      windowSeconds: 1,
    });

    // Assert
    expect(limiter.mode).toBe('off');
    expect(result).toEqual({ allowed: true, count: 0 });
    expect(await redis.get('rate:ws:send:user-1')).toBeNull();
  });
});
