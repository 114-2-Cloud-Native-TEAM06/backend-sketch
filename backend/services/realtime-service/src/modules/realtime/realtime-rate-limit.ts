import {
  checkRateLimit,
  type RateLimitOptions,
  type RateLimitResult,
  type RedisLike,
} from '../../../../../packages/shared-redis/src/index.js';

export type RealtimeRateLimitMode = 'local' | 'redis' | 'off';

export interface RealtimeRateLimiter {
  readonly mode: RealtimeRateLimitMode;
  check(key: string, options: RateLimitOptions): Promise<RateLimitResult>;
}

interface LocalWindow {
  count: number;
  expiresAtMs: number;
}

export interface RealtimeRateLimiterOptions {
  mode?: string;
  nowMs?: () => number;
  maxEntries?: number;
}

export function createRealtimeRateLimiter(
  redis: RedisLike | undefined,
  options: RealtimeRateLimiterOptions = {},
): RealtimeRateLimiter {
  const mode = parseRealtimeRateLimitMode(options.mode ?? process.env.WS_RATE_LIMIT_MODE);
  if (mode === 'redis') {
    return {
      mode,
      check(key, rateLimitOptions) {
        return checkRateLimit(redis, key, rateLimitOptions);
      },
    };
  }

  if (mode === 'off') {
    return {
      mode,
      async check(): Promise<RateLimitResult> {
        return { allowed: true, count: 0 };
      },
    };
  }

  return createLocalRealtimeRateLimiter(options);
}

export function parseRealtimeRateLimitMode(value: string | undefined): RealtimeRateLimitMode {
  if (value === 'redis' || value === 'off') return value;
  return 'local';
}

function createLocalRealtimeRateLimiter(options: RealtimeRateLimiterOptions): RealtimeRateLimiter {
  const nowMs = options.nowMs ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? 50_000);
  const windows = new Map<string, LocalWindow>();
  let checksSinceCleanup = 0;

  return {
    mode: 'local',
    async check(key, rateLimitOptions): Promise<RateLimitResult> {
      const now = nowMs();
      const windowKey = `${rateLimitOptions.keyPrefix}:${key}`;
      const current = windows.get(windowKey);
      const windowMs = Math.max(1, rateLimitOptions.windowSeconds * 1000);
      const window = current && current.expiresAtMs > now
        ? current
        : { count: 0, expiresAtMs: now + windowMs };

      window.count += 1;
      windows.set(windowKey, window);
      cleanupExpiredWindows(windows, now, maxEntries, ++checksSinceCleanup);

      return {
        allowed: window.count <= rateLimitOptions.limit,
        count: window.count,
      };
    },
  };
}

function cleanupExpiredWindows(
  windows: Map<string, LocalWindow>,
  nowMs: number,
  maxEntries: number,
  checksSinceCleanup: number,
): void {
  if (windows.size <= maxEntries && checksSinceCleanup % 1000 !== 0) return;

  for (const [key, window] of windows.entries()) {
    if (window.expiresAtMs <= nowMs) windows.delete(key);
  }
}
