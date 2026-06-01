import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import {
  connectNats,
  createJetStreamMessageWritePublisher,
  type MessageWriteCommand,
} from '../packages/shared-nats/src/index.js';

type LoadData = {
  users: Array<{ id: string; username: string; roomId: string }>;
  rooms: Array<{ id: string; memberIds: string[] }>;
};

const totalMessages = Number(process.env.NATS_LOAD_MESSAGES || 50_000);
const concurrency = Math.max(1, Number(process.env.NATS_LOAD_CONCURRENCY || 100));
const roomCount = Number(process.env.NATS_LOAD_ROOM_COUNT || 0);
const userCount = Number(process.env.NATS_LOAD_USER_COUNT || 0);
const progressEvery = Number(process.env.NATS_LOAD_PROGRESS_EVERY || 10_000);
const dataPath = path.resolve(process.env.NATS_LOAD_DATA_PATH || 'load-tests/generated/ws-1000-msgs.json');
const runId = process.env.NATS_LOAD_RUN_ID || String(Date.now());

async function main(): Promise<void> {
  const data = JSON.parse(await fs.readFile(dataPath, 'utf8')) as LoadData;
  const roomIds = new Set(
    (roomCount > 0 ? data.rooms.slice(0, roomCount) : data.rooms).map((room) => room.id),
  );
  const users = (userCount > 0 ? data.users.slice(0, userCount) : data.users)
    .filter((user) => !roomIds.size || roomIds.has(user.roomId));

  if (!users.length) {
    throw new Error(`No load-test users found in ${dataPath}; run npm run load:seed first`);
  }

  const nats = await connectNats();
  const publisher = await createJetStreamMessageWritePublisher(nats);
  const startedAt = performance.now();
  const acceptedAtBase = Date.now();
  let nextIndex = 0;
  let succeeded = 0;
  let failed = 0;
  let latencySumMs = 0;
  let latencyMaxMs = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= totalMessages) return;

      const command = createCommand(index, users[index % users.length], acceptedAtBase + index);
      const publishStartedAt = performance.now();
      try {
        await publisher.publishMessageWrite(command);
        const latencyMs = performance.now() - publishStartedAt;
        latencySumMs += latencyMs;
        latencyMaxMs = Math.max(latencyMaxMs, latencyMs);
        succeeded += 1;
        if (progressEvery > 0 && succeeded % progressEvery === 0) {
          console.log(JSON.stringify({
            event: 'nats_load_progress',
            ts: new Date().toISOString(),
            succeeded,
            failed,
          }));
        }
      } catch (err) {
        failed += 1;
        console.error(JSON.stringify({
          event: 'nats_load_publish_failed',
          ts: new Date().toISOString(),
          index,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    event: 'nats_load_summary',
    ts: new Date().toISOString(),
    run_id: runId,
    requested: totalMessages,
    succeeded,
    failed,
    concurrency,
    users: users.length,
    duration_ms: roundMs(durationMs),
    publish_per_sec: roundMs(succeeded / (durationMs / 1000)),
    publish_latency_ms: {
      avg: succeeded ? roundMs(latencySumMs / succeeded) : 0,
      max: roundMs(latencyMaxMs),
    },
  }));

  await nats.drain();
}

function createCommand(index: number, user: { id: string; roomId: string }, acceptedAtMs: number): MessageWriteCommand {
  const requestId = `nats-load-${runId}-${index}`;
  return {
    message_id: stableMessageId(user.id, requestId),
    request_id: requestId,
    sender_id: user.id,
    room_id: user.roomId,
    body: `nats load message ${runId}-${index}`,
    accepted_at: new Date(acceptedAtMs).toISOString(),
  };
}

function stableMessageId(senderId: string, requestId: string): string {
  const digest = createHash('sha256')
    .update(senderId)
    .update(':')
    .update(requestId)
    .digest('hex')
    .slice(0, 32);
  return `msg_${digest}`;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
