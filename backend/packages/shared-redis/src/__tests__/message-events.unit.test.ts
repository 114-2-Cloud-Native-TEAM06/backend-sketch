import { expect, test } from 'vitest';
import { FakeRedis, ROOM_EVENT_PATTERN, parseRoomEvent, publishRoomMessage } from '../index.js';

test('publishes message created events to matching room subscribers', async () => {
  // Arrange
  const redis = new FakeRedis();
  const received: Array<{ message: string; channel: string }> = [];
  await redis.pSubscribe(ROOM_EVENT_PATTERN, (message, channel) => {
    received.push({ message, channel });
  });

  // Act
  await publishRoomMessage(redis, {
    id: 'msg-1',
    chat_id: 'room-1',
    sender_id: 'user-1',
    type: 'TEXT',
    body: 'hello',
    created_at: '2026-05-26T00:00:00.000Z',
  }, 'conn-1');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Assert
  expect(received).toHaveLength(1);
  expect(received[0].channel).toBe('room:room-1:events');
  expect(parseRoomEvent(received[0].message)).toMatchObject({
    type: 'message.created',
    room_id: 'room-1',
    origin_connection_id: 'conn-1',
    message: { id: 'msg-1', body: 'hello' },
  });
});
