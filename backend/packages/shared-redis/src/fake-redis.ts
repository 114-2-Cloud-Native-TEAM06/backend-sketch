import type { RedisLike } from './redis.js';

type PatternListener = (message: string, channel: string) => void;

interface Entry {
  value: string | Set<string>;
  expiresAt?: number;
}

export class FakeRedis implements RedisLike {
  private readonly store: Map<string, Entry>;
  private readonly listeners: Map<string, Set<PatternListener>>;

  constructor(
    store = new Map<string, Entry>(),
    listeners = new Map<string, Set<PatternListener>>(),
  ) {
    this.store = store;
    this.listeners = listeners;
  }

  duplicate(): RedisLike {
    return new FakeRedis(this.store, this.listeners);
  }

  async connect(): Promise<void> {}

  async quit(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    const entry = this.getEntry(key);
    return typeof entry?.value === 'string' ? entry.value : null;
  }

  async set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null> {
    if (options?.NX && this.getEntry(key)) return null;

    this.store.set(key, {
      value,
      ...(options?.EX ? { expiresAt: Date.now() + options.EX * 1000 } : {}),
    });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const current = Number(await this.get(key) ?? '0') + 1;
    const existing = this.getEntry(key);
    this.store.set(key, {
      value: String(current),
      ...(existing?.expiresAt ? { expiresAt: existing.expiresAt } : {}),
    });
    return current;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const entry = this.getEntry(key);
    if (!entry) return false;
    entry.expiresAt = Date.now() + seconds * 1000;
    return true;
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;
    for (const item of keys) {
      if (this.store.delete(item)) removed += 1;
    }
    return removed;
  }

  async sAdd(key: string, members: string | string[]): Promise<number> {
    const set = this.getSet(key);
    let added = 0;
    for (const member of Array.isArray(members) ? members : [members]) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    this.store.set(key, { value: set });
    return added;
  }

  async sRem(key: string, members: string | string[]): Promise<number> {
    const entry = this.getEntry(key);
    if (!(entry?.value instanceof Set)) return 0;

    let removed = 0;
    for (const member of Array.isArray(members) ? members : [members]) {
      if (entry.value.delete(member)) removed += 1;
    }
    if (!entry.value.size) this.store.delete(key);
    return removed;
  }

  async sMembers(key: string): Promise<string[]> {
    const entry = this.getEntry(key);
    return entry?.value instanceof Set ? [...entry.value] : [];
  }

  async publish(channel: string, message: string): Promise<number> {
    let delivered = 0;
    for (const [pattern, listeners] of this.listeners.entries()) {
      if (!matchesPattern(pattern, channel)) continue;
      for (const listener of listeners) {
        delivered += 1;
        queueMicrotask(() => listener(message, channel));
      }
    }
    return delivered;
  }

  async pSubscribe(pattern: string, listener: PatternListener): Promise<void> {
    const listeners = this.listeners.get(pattern) ?? new Set<PatternListener>();
    listeners.add(listener);
    this.listeners.set(pattern, listeners);
  }

  private getEntry(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private getSet(key: string): Set<string> {
    const entry = this.getEntry(key);
    if (entry?.value instanceof Set) return entry.value;
    return new Set<string>();
  }
}

function matchesPattern(pattern: string, channel: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(channel);
}
