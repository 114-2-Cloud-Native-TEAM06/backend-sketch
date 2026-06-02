import { createPrismaClient } from '../packages/shared-db/src/prisma.js';
import {
  connectNats,
  MESSAGE_WRITE_CONSUMER,
  MESSAGE_WRITE_STREAM,
} from '../packages/shared-nats/src/index.js';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const [messageCount, messageWriteStatusCounts, natsSnapshot, pgActivity] = await Promise.all([
      prisma.message.count(),
      prisma.messageWrite.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      readNatsSnapshot(),
      readPgActivity(prisma),
    ]);

    console.log(JSON.stringify({
      event: 'load_test_snapshot',
      ts: new Date().toISOString(),
      db: {
        messages: messageCount,
        message_writes: Object.fromEntries(
          messageWriteStatusCounts.map((row) => [row.status.toLowerCase(), row._count._all]),
        ),
      },
      nats: natsSnapshot,
      ...(pgActivity ? { pg_stat_activity: pgActivity } : {}),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

async function readNatsSnapshot(): Promise<Record<string, unknown>> {
  let nats;
  try {
    nats = await connectNats();
    const jsm = await nats.jetstreamManager();
    const [streamInfo, consumerInfo] = await Promise.all([
      jsm.streams.info(MESSAGE_WRITE_STREAM),
      jsm.consumers.info(MESSAGE_WRITE_STREAM, MESSAGE_WRITE_CONSUMER),
    ]);
    return {
      stream: MESSAGE_WRITE_STREAM,
      consumer: MESSAGE_WRITE_CONSUMER,
      messages: streamInfo.state.messages,
      bytes: streamInfo.state.bytes,
      first_seq: streamInfo.state.first_seq,
      last_seq: streamInfo.state.last_seq,
      num_pending: consumerInfo.num_pending,
      num_ack_pending: consumerInfo.num_ack_pending,
      num_redelivered: consumerInfo.num_redelivered,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await nats?.drain();
  }
}

async function readPgActivity(prisma: ReturnType<typeof createPrismaClient>): Promise<Array<Record<string, unknown>> | undefined> {
  if (process.env.LOAD_SNAPSHOT_INCLUDE_PG_ACTIVITY !== 'true') return undefined;

  const rows = await prisma.$queryRaw<Array<{ state: string | null; count: bigint }>>`
    SELECT state, count(*) AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
    ORDER BY state NULLS LAST
  `;

  return rows.map((row) => ({
    state: row.state,
    count: Number(row.count),
  }));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
