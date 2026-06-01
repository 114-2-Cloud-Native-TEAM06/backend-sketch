import {
  AckPolicy,
  connect,
  DeliverPolicy,
  headers,
  JSONCodec,
  ReplayPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  RetentionPolicy,
  StorageType,
} from 'nats';
import {
  CHAT_MESSAGES_STREAM,
  CHAT_MESSAGE_STATUS_STREAM,
  MESSAGE_ACCEPTED_SUBJECT,
  MESSAGE_FAILED_SUBJECT,
  MESSAGE_PERSISTED_SUBJECT,
  type ChatMessageAcceptedEvent,
  type ChatMessageFailedEvent,
  type ChatMessagePersistedEvent,
} from './message-events.js';

type JsonMessage = ChatMessageAcceptedEvent | ChatMessagePersistedEvent | ChatMessageFailedEvent;

const jc = JSONCodec<JsonMessage>();

let connectionPromise: Promise<NatsConnection> | null = null;
let streamsReadyPromise: Promise<void> | null = null;

export function isNatsEnabled(): boolean {
  return Boolean(process.env.NATS_URL);
}

export async function getNatsConnection(): Promise<NatsConnection> {
  if (!process.env.NATS_URL) throw new Error('NATS_URL is not configured');

  connectionPromise ??= connect({
    name: 'im-backend',
    servers: process.env.NATS_URL,
    timeout: 5_000,
  });

  return connectionPromise;
}

export async function getJetStream(): Promise<JetStreamClient> {
  const nc = await getNatsConnection();
  await ensureJetStream();
  return nc.jetstream();
}

export async function getJetStreamManager(): Promise<JetStreamManager> {
  const nc = await getNatsConnection();
  return nc.jetstreamManager();
}

export async function ensureJetStream(): Promise<void> {
  streamsReadyPromise ??= (async () => {
    const jsm = await getJetStreamManager();

    await ensureStream(jsm, CHAT_MESSAGES_STREAM, [`${MESSAGE_ACCEPTED_SUBJECT}.*`]);
    await ensureStream(jsm, CHAT_MESSAGE_STATUS_STREAM, [
      `${MESSAGE_PERSISTED_SUBJECT}.*`,
      `${MESSAGE_FAILED_SUBJECT}.*`,
    ]);
  })();

  return streamsReadyPromise;
}

async function ensureStream(jsm: JetStreamManager, name: string, subjects: string[]): Promise<void> {
  try {
    await jsm.streams.info(name);
  } catch {
    await jsm.streams.add({
      name,
      subjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
    });
  }
}

export async function publishAcceptedMessage(event: ChatMessageAcceptedEvent): Promise<void> {
  const js = await getJetStream();
  const h = headers();
  h.set('Nats-Msg-Id', `${event.sender_id}:${event.request_id}`);

  await js.publish(
    `${MESSAGE_ACCEPTED_SUBJECT}.${event.room_id}`,
    jc.encode(event),
    { headers: h },
  );
}

export async function publishPersistedMessage(event: ChatMessagePersistedEvent): Promise<void> {
  const js = await getJetStream();
  await js.publish(`${MESSAGE_PERSISTED_SUBJECT}.${event.room_id}`, jc.encode(event));
}

export async function publishFailedMessage(event: ChatMessageFailedEvent): Promise<void> {
  const js = await getJetStream();
  await js.publish(`${MESSAGE_FAILED_SUBJECT}.${event.room_id}`, jc.encode(event));
}

export function encodeMessage(event: JsonMessage): Uint8Array {
  return jc.encode(event);
}

export function decodeAcceptedMessage(data: Uint8Array): ChatMessageAcceptedEvent {
  return jc.decode(data) as ChatMessageAcceptedEvent;
}

export const messageDbWriterConsumerConfig = {
  durable_name: 'message-db-writer',
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
  filter_subject: `${MESSAGE_ACCEPTED_SUBJECT}.*`,
  max_deliver: 5,
};
