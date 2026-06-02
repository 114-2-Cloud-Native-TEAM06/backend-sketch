import { expect, test } from 'vitest';
import { FakeRedis, cacheMessage, getCachedMessage } from '../index.js';

test('returns the cached message for a repeated sender request id', async () => {
  // Arrange
  const redis = new FakeRedis();
  const message = {
    id: 'msg-1',
    chat_id: 'room-1',
    sender_id: 'user-1',
    type: 'TEXT' as const,
    body: 'hello',
    created_at: '2026-05-26T00:00:00.000Z',
  };

  // Act
  await cacheMessage(redis, 'user-1', 'req-1', message);
  const cached = await getCachedMessage(redis, 'user-1', 'req-1');

  // Assert
  expect(cached).toEqual(message);
});
