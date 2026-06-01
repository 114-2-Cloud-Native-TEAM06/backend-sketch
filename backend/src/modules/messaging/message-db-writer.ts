import type { PrismaClient } from '@prisma/client';
import { createMessage } from '../chats/chats.service.js';
import {
  CHAT_MESSAGES_STREAM,
  MESSAGE_ACCEPTED_SUBJECT,
} from './message-events.js';
import {
  decodeAcceptedMessage,
  ensureJetStream,
  getJetStream,
  getJetStreamManager,
  isNatsEnabled,
  messageDbWriterConsumerConfig,
  publishFailedMessage,
  publishPersistedMessage,
} from './nats-client.js';

const MESSAGE_DB_WRITER_DURABLE = 'message-db-writer';

export async function startMessageDbWriter(prisma: PrismaClient): Promise<void> {
  if (!isNatsEnabled()) {
    console.log('NATS_URL is not set; message DB writer is disabled.');
    return;
  }

  await ensureJetStream();
  const js = await getJetStream();
  const jsm = await getJetStreamManager();

  try {
    await jsm.consumers.info(CHAT_MESSAGES_STREAM, MESSAGE_DB_WRITER_DURABLE);
  } catch {
    await jsm.consumers.add(CHAT_MESSAGES_STREAM, messageDbWriterConsumerConfig);
  }

  const consumer = await js.consumers.get(CHAT_MESSAGES_STREAM, MESSAGE_DB_WRITER_DURABLE);
  const messages = await consumer.consume({ max_messages: 100 });

  console.log('NATS message DB writer started.');

  void (async () => {
    for await (const msg of messages) {
      const event = decodeAcceptedMessage(msg.data);

      try {
        const persisted = await createMessage(prisma, {
          messageId: event.message_id,
          senderId: event.sender_id,
          chatId: event.room_id,
          body: event.body,
          requestId: event.request_id,
          createdAt: new Date(event.accepted_at),
        });

        await publishPersistedMessage({
          event_version: 1,
          message_id: persisted.id,
          request_id: event.request_id,
          room_id: event.room_id,
          sender_id: event.sender_id,
          persisted_at: persisted.created_at,
        });

        msg.ack();
      } catch (err) {
        console.error('NATS message DB write failed:', err);

        if (msg.info.redeliveryCount < 5) {
          msg.nak();
          continue;
        }

        msg.ack();

        await publishFailedMessage({
          event_version: 1,
          message_id: event.message_id,
          request_id: event.request_id,
          room_id: event.room_id,
          sender_id: event.sender_id,
          reason: err instanceof Error ? err.message : 'unknown_error',
        });
      }
    }
  })().catch((err) => {
    console.error('NATS message DB writer stopped:', err);
  });
}
