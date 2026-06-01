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

const codec = JSONCodec<MessageWriteCommand>();

export function natsUrl(): string {
  return process.env.NATS_URL || 'nats://localhost:4222';
}

export async function connectNats(url = natsUrl()): Promise<NatsConnection> {
  return connect({
    servers: url,
    maxReconnectAttempts: -1,
    reconnect: true,
    name: process.env.NATS_CLIENT_NAME || 'im-backend',
  });
}

export async function ensureMessageWriteStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();

  try {
    await jsm.streams.info(MESSAGE_WRITE_STREAM);
    return;
  } catch {
    await jsm.streams.add({
      name: MESSAGE_WRITE_STREAM,
      subjects: [MESSAGE_WRITE_SUBJECT],
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

export async function ensureMessageWriteConsumer(nc: NatsConnection): Promise<void> {
  await ensureMessageWriteStream(nc);
  const jsm = await nc.jetstreamManager();
  const maxDeliver = Number(process.env.MESSAGE_WRITE_MAX_DELIVER || 5);
  const ackWaitMs = Number(process.env.MESSAGE_WRITE_ACK_WAIT_MS || 30_000);
  const maxAckPending = Number(process.env.MESSAGE_WRITE_MAX_ACK_PENDING || 4096);
  const config = {
    durable_name: MESSAGE_WRITE_CONSUMER,
    name: MESSAGE_WRITE_CONSUMER,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: MESSAGE_WRITE_SUBJECT,
    max_deliver: maxDeliver,
    ack_wait: ackWaitMs * 1_000_000,
    max_ack_pending: maxAckPending,
  };

  try {
    await jsm.consumers.info(MESSAGE_WRITE_STREAM, MESSAGE_WRITE_CONSUMER);
    await jsm.consumers.update(MESSAGE_WRITE_STREAM, MESSAGE_WRITE_CONSUMER, config);
  } catch {
    await jsm.consumers.add(MESSAGE_WRITE_STREAM, config);
  }
}

export class JetStreamMessageWritePublisher implements MessageWritePublisher {
  constructor(private readonly js: JetStreamClient) {}

  async publishMessageWrite(command: MessageWriteCommand): Promise<void> {
    await this.js.publish(MESSAGE_WRITE_SUBJECT, codec.encode(command), {
      msgID: command.message_id,
    });
  }
}

export async function createJetStreamMessageWritePublisher(
  nc: NatsConnection,
): Promise<JetStreamMessageWritePublisher> {
  await ensureMessageWriteStream(nc);
  return new JetStreamMessageWritePublisher(nc.jetstream());
}

export function decodeMessageWriteCommand(data: Uint8Array): MessageWriteCommand {
  return codec.decode(data);
}
