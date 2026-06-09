import {
  AckPolicy,
  DeliverPolicy,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  connect,
  type JetStreamClient,
  type NatsConnection,
} from 'nats';
import type { MessageWriteCommand, MessageWritePublisher } from './message-write-buffer.js';

export const MESSAGE_WRITE_STREAM = process.env.MESSAGE_WRITE_STREAM || 'MESSAGE_WRITES';
export const MESSAGE_WRITE_SUBJECT = process.env.MESSAGE_WRITE_SUBJECT || 'messages.write';
export const MESSAGE_WRITE_CONSUMER = process.env.MESSAGE_WRITE_CONSUMER || 'message-writer';
export const MESSAGE_WRITE_SHARD_COUNT = readPositiveInteger(process.env.MESSAGE_WRITE_SHARD_COUNT, 1);

const codec = JSONCodec<MessageWriteCommand>();

export interface MessageWriteShard {
  index: number;
  stream: string;
  subject: string;
  consumer: string;
}

export function natsUrl(): string {
  return process.env.NATS_URL || 'nats://localhost:4222';
}

export function natsShardUrls(): string[] {
  const configured = process.env.NATS_SHARD_URLS;
  if (!configured) return [natsUrl()];

  const urls = configured.split(',').map((url) => url.trim()).filter(Boolean);
  return urls.length ? urls : [natsUrl()];
}

export async function connectNats(url = natsUrl()): Promise<NatsConnection> {
  return connectNatsWithName(url, 'im-backend');
}

export async function connectNatsShards(urls = natsShardUrls()): Promise<NatsConnection[]> {
  return Promise.all(urls.map((url, index) => connectNatsWithName(url, `im-backend-nats-shard-${index}`)));
}

export function messageWriteShardCount(): number {
  return readPositiveInteger(process.env.MESSAGE_WRITE_SHARD_COUNT, MESSAGE_WRITE_SHARD_COUNT);
}

export function normalizeMessageWriteShardIndex(index: number, shardCount = messageWriteShardCount()): number {
  const count = Math.max(1, shardCount);
  const normalized = Math.trunc(index);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized >= count) {
    throw new Error(`message write shard index must be between 0 and ${count - 1}`);
  }
  return normalized;
}

export function messageWriteShardForIndex(index: number, shardCount = messageWriteShardCount()): MessageWriteShard {
  const count = Math.max(1, shardCount);
  const normalized = normalizeMessageWriteShardIndex(index, count);
  if (count === 1) {
    return {
      index: 0,
      stream: MESSAGE_WRITE_STREAM,
      subject: MESSAGE_WRITE_SUBJECT,
      consumer: MESSAGE_WRITE_CONSUMER,
    };
  }

  return {
    index: normalized,
    stream: `${MESSAGE_WRITE_STREAM}_${normalized}`,
    subject: `${MESSAGE_WRITE_SUBJECT}.${normalized}`,
    consumer: `${MESSAGE_WRITE_CONSUMER}-${normalized}`,
  };
}

export function messageWriteShardForRoom(roomId: string, shardCount = messageWriteShardCount()): MessageWriteShard {
  return messageWriteShardForIndex(hashRoomId(roomId) % Math.max(1, shardCount), shardCount);
}

export function messageWriteShards(shardCount = messageWriteShardCount()): MessageWriteShard[] {
  const count = Math.max(1, shardCount);
  return Array.from({ length: count }, (_, index) => messageWriteShardForIndex(index, count));
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

function hashRoomId(roomId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < roomId.length; i += 1) {
    hash ^= roomId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export async function ensureMessageWriteStream(
  nc: NatsConnection,
  shard: MessageWriteShard = messageWriteShardForIndex(0),
): Promise<void> {
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.info(shard.stream);
    return;
  } catch {
    await jsm.streams.add({
      name: shard.stream,
      subjects: [shard.subject],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_msgs: Number(process.env.MESSAGE_WRITE_STREAM_MAX_MSGS || 1_000_000),
      max_age: 0,
      max_bytes: -1,
      max_msg_size: -1,
      duplicate_window: 120_000_000_000,
      num_replicas: 1,
    });
  }
}

export async function ensureMessageWriteConsumer(
  nc: NatsConnection,
  shard: MessageWriteShard = messageWriteShardForIndex(0),
): Promise<void> {
  await ensureMessageWriteStream(nc, shard);
  const jsm = await nc.jetstreamManager();
  const maxDeliver = Number(process.env.MESSAGE_WRITE_MAX_DELIVER || 5);
  const ackWaitMs = Number(process.env.MESSAGE_WRITE_ACK_WAIT_MS || 30_000);
  const maxAckPending = Number(process.env.MESSAGE_WRITE_MAX_ACK_PENDING || 4096);
  const config = {
    durable_name: shard.consumer,
    name: shard.consumer,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: shard.subject,
    max_deliver: maxDeliver,
    ack_wait: ackWaitMs * 1_000_000,
    max_ack_pending: maxAckPending,
  };

  try {
    await jsm.consumers.info(shard.stream, shard.consumer);
    await jsm.consumers.update(shard.stream, shard.consumer, config);
  } catch {
    await jsm.consumers.add(shard.stream, config);
  }
}

export class JetStreamMessageWritePublisher implements MessageWritePublisher {
  constructor(
    private readonly jsByShard: JetStreamClient[],
    private readonly shardCount = messageWriteShardCount(),
  ) {}

  async publishMessageWrite(command: MessageWriteCommand): Promise<void> {
    const shard = messageWriteShardForRoom(command.room_id, this.shardCount);
    const js = this.jsByShard[shard.index];
    if (!js) {
      throw new Error(`message write publisher missing NATS shard ${shard.index}`);
    }
    await js.publish(shard.subject, codec.encode(command), {
      msgID: command.message_id,
    });
  }
}

export async function createJetStreamMessageWritePublisher(
  nc: NatsConnection | NatsConnection[],
): Promise<JetStreamMessageWritePublisher> {
  const connections = Array.isArray(nc) ? nc : [nc];
  const shardCount = messageWriteShardCount();

  if (connections.length === 1) {
    await Promise.all(messageWriteShards(shardCount).map((shard) => ensureMessageWriteStream(connections[0], shard)));
    const js = connections[0].jetstream();
    return new JetStreamMessageWritePublisher(Array.from({ length: shardCount }, () => js), shardCount);
  }

  if (connections.length !== shardCount) {
    throw new Error(`NATS shard connection count (${connections.length}) must match MESSAGE_WRITE_SHARD_COUNT (${shardCount})`);
  }

  await Promise.all(connections.map((connection, index) => ensureMessageWriteStream(
    connection,
    messageWriteShardForIndex(index, shardCount),
  )));
  return new JetStreamMessageWritePublisher(connections.map((connection) => connection.jetstream()), shardCount);
}

export function decodeMessageWriteCommand(data: Uint8Array): MessageWriteCommand {
  return codec.decode(data);
}

function connectNatsWithName(url: string, fallbackName: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    maxReconnectAttempts: -1,
    reconnect: true,
    name: process.env.NATS_CLIENT_NAME || fallbackName,
  });
}
