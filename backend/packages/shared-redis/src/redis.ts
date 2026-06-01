import { createClient } from 'redis';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  del(key: string | string[]): Promise<number>;
  sAdd(key: string, members: string | string[]): Promise<number>;
  sRem(key: string, members: string | string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  publish(channel: string, message: string): Promise<number>;
  pSubscribe(pattern: string, listener: (message: string, channel: string) => void): Promise<void>;
  quit(): Promise<string | void>;
  duplicate?(): RedisLike;
  connect?(): Promise<unknown>;
  isOpen?: boolean;
}

export interface RedisClients {
  app: RedisLike;
  publisher: RedisLike;
  subscriber: RedisLike;
}

export function redisUrl(): string {
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

export function createRedisClient(url = redisUrl()): RedisLike {
  return createClient({ url }) as unknown as RedisLike;
}

export async function connectRedisClient(client: RedisLike): Promise<void> {
  if (client.isOpen || !client.connect) return;
  await client.connect();
}

export async function createRedisClients(url = redisUrl()): Promise<RedisClients> {
  const app = createRedisClient(url);
  const publisher = app.duplicate ? app.duplicate() : createRedisClient(url);
  const subscriber = app.duplicate ? app.duplicate() : createRedisClient(url);

  await Promise.all([
    connectRedisClient(app),
    connectRedisClient(publisher),
    connectRedisClient(subscriber),
  ]);

  return { app, publisher, subscriber };
}

export async function disconnectRedisClients(clients: Partial<RedisClients>): Promise<void> {
  const uniqueClients = new Set(Object.values(clients).filter(Boolean) as RedisLike[]);
  await Promise.all([...uniqueClients].map(async (client) => {
    try {
      await client.quit();
    } catch {
      // Shutdown paths should not hide the original process exit.
    }
  }));
}
