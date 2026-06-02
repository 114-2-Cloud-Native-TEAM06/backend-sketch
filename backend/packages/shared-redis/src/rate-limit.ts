import type { NextFunction, Request, Response } from 'express';
import type { RedisLike } from './redis.js';

export interface RateLimitOptions {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

export async function checkRateLimit(
  redis: RedisLike | undefined,
  key: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!redis) return { allowed: true, count: 0 };

  const redisKey = `rate:${options.keyPrefix}:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) await redis.expire(redisKey, options.windowSeconds);
    return { allowed: count <= options.limit, count };
  } catch {
    return { allowed: true, count: 0 };
  }
}

export function createRateLimitMiddleware(
  redis: RedisLike | undefined,
  options: RateLimitOptions & { key?: (req: Request) => string },
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = options.key?.(req) ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const result = await checkRateLimit(redis, key, options);
    if (!result.allowed) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    next();
  };
}
