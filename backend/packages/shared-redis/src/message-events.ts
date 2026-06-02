import type { Message } from '../../shared-types/src/api-types.js';
import type { RedisLike } from './redis.js';

export const ROOM_EVENT_PATTERN = 'room:*:events';

export interface RoomMessageCreatedEvent {
  type: 'message.created';
  room_id: string;
  message: Message;
  origin_connection_id?: string;
}

export type RoomEvent = RoomMessageCreatedEvent;

export function roomEventChannel(roomId: string): string {
  return `room:${roomId}:events`;
}

export async function publishRoomMessage(
  redis: RedisLike | undefined,
  message: Message,
  originConnectionId?: string,
): Promise<void> {
  if (!redis) return;

  const event: RoomMessageCreatedEvent = {
    type: 'message.created',
    room_id: message.chat_id,
    message,
    ...(originConnectionId ? { origin_connection_id: originConnectionId } : {}),
  };

  try {
    await redis.publish(roomEventChannel(message.chat_id), JSON.stringify(event));
  } catch {
    // Message persistence is the source of truth; realtime fanout can recover on refresh.
  }
}

export function parseRoomEvent(raw: string): RoomEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RoomEvent>;
    if (parsed.type !== 'message.created') return null;
    if (!parsed.message || typeof parsed.room_id !== 'string') return null;
    return parsed as RoomEvent;
  } catch {
    return null;
  }
}
