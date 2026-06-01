import { randomUUID } from 'crypto';
import os from 'os';
import type { RedisLike } from './redis.js';

export const PRESENCE_CHANNEL = 'presence:events';
export const PRESENCE_TTL_SECONDS = 30;

export interface PresenceEvent {
  type: 'presence';
  user_id: string;
  online: boolean;
}

export interface PresenceConnection {
  id: string;
  userId: string;
}

export function instanceId(): string {
  return process.env.INSTANCE_ID || `${os.hostname()}:${process.pid}`;
}

export function createConnectionId(prefix = instanceId()): string {
  return `${prefix}:${randomUUID()}`;
}

export async function registerPresence(
  redis: RedisLike | undefined,
  userId: string,
  connectionId: string,
): Promise<boolean> {
  if (!redis) return false;

  try {
    const wasOnline = await isUserOnline(redis, userId);
    await redis.set(connectionKey(connectionId), userId, { EX: PRESENCE_TTL_SECONDS });
    await redis.sAdd(userConnectionsKey(userId), connectionId);
    if (!wasOnline) await publishPresence(redis, { type: 'presence', user_id: userId, online: true });
    return !wasOnline;
  } catch {
    return false;
  }
}

export async function refreshPresence(
  redis: RedisLike | undefined,
  connectionId: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.expire(connectionKey(connectionId), PRESENCE_TTL_SECONDS);
  } catch {
    // Presence is best-effort and will recover on next reconnect.
  }
}

export async function unregisterPresence(
  redis: RedisLike | undefined,
  userId: string,
  connectionId: string,
): Promise<boolean> {
  if (!redis) return false;

  try {
    await redis.del(connectionKey(connectionId));
    await redis.sRem(userConnectionsKey(userId), connectionId);
    const stillOnline = await isUserOnline(redis, userId);
    if (!stillOnline) await publishPresence(redis, { type: 'presence', user_id: userId, online: false });
    return !stillOnline;
  } catch {
    return false;
  }
}

export async function isUserOnline(redis: RedisLike | undefined, userId: string): Promise<boolean> {
  if (!redis) return false;

  const connections = await redis.sMembers(userConnectionsKey(userId));
  let online = false;
  await Promise.all(connections.map(async (connectionId) => {
    const exists = await redis.get(connectionKey(connectionId));
    if (exists) online = true;
    else await redis.sRem(userConnectionsKey(userId), connectionId);
  }));
  return online;
}

export async function publishPresence(redis: RedisLike, event: PresenceEvent): Promise<void> {
  await redis.publish(PRESENCE_CHANNEL, JSON.stringify(event));
}

export function parsePresenceEvent(raw: string): PresenceEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PresenceEvent>;
    if (parsed.type !== 'presence') return null;
    if (typeof parsed.user_id !== 'string' || typeof parsed.online !== 'boolean') return null;
    return parsed as PresenceEvent;
  } catch {
    return null;
  }
}

function connectionKey(connectionId: string): string {
  return `presence:conn:${connectionId}`;
}

function userConnectionsKey(userId: string): string {
  return `presence:user:${userId}:connections`;
}
