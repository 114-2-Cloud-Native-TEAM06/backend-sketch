import type { Message } from '../../shared-types/src/api-types.js';
import type { RedisLike } from './redis.js';

const TTL_SECONDS = 5 * 60;

export function messageIdempotencyKey(senderId: string, requestId: string): string {
  return `idempotency:message:${senderId}:${requestId}`;
}

export async function getCachedMessage(
  redis: RedisLike | undefined,
  senderId: string,
  requestId: string | undefined,
): Promise<Message | null> {
  if (!redis || !requestId) return null;

  try {
    const cached = await redis.get(messageIdempotencyKey(senderId, requestId));
    return cached ? JSON.parse(cached) as Message : null;
  } catch {
    return null;
  }
}

export async function cacheMessage(
  redis: RedisLike | undefined,
  senderId: string,
  requestId: string | undefined,
  message: Message,
): Promise<void> {
  if (!redis || !requestId) return;

  try {
    await redis.set(messageIdempotencyKey(senderId, requestId), JSON.stringify(message), { EX: TTL_SECONDS });
  } catch {
    // DB unique requestId remains the durable idempotency guard.
  }
}
