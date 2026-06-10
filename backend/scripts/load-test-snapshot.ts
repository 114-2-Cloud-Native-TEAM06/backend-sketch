import { createPrismaClient } from '../packages/shared-db/src/prisma.js';
import {
  connectNats,
  messageWriteShardForIndex,
  messageWriteShardCount,
  messageWriteShards,
  natsShardUrls,
} from '../packages/shared-nats/src/index.js';

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const [messageCount, messageStatusCounts, natsSnapshot, pgActivity] = await Promise.all([
      prisma.message.count(),
      prisma.message.groupBy({
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
        message_statuses: Object.fromEntries(
          messageStatusCounts.map((row) => [row.status.toLowerCase(), row._count._all]),
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
  const configuredShardUrls = process.env.NATS_SHARD_URLS ? natsShardUrls() : undefined;
  if (configuredShardUrls) return readPhysicalNatsShardSnapshot(configuredShardUrls);

  let nats;
  try {
    nats = await connectNats();
    const jsm = await nats.jetstreamManager();
    const shards = await Promise.all(messageWriteShards().map(async (shard) => {
      const [streamInfo, consumerInfo] = await Promise.all([
        jsm.streams.info(shard.stream),
        jsm.consumers.info(shard.stream, shard.consumer),
      ]);
      return {
        index: shard.index,
        stream: shard.stream,
        consumer: shard.consumer,
        messages: streamInfo.state.messages,
        bytes: streamInfo.state.bytes,
        first_seq: streamInfo.state.first_seq,
        last_seq: streamInfo.state.last_seq,
        num_pending: consumerInfo.num_pending,
        num_ack_pending: consumerInfo.num_ack_pending,
        num_redelivered: consumerInfo.num_redelivered,
      };
    }));
    return {
      shards,
      totals: {
        messages: shards.reduce((sum, shard) => sum + shard.messages, 0),
        bytes: shards.reduce((sum, shard) => sum + shard.bytes, 0),
        num_pending: shards.reduce((sum, shard) => sum + shard.num_pending, 0),
        num_ack_pending: shards.reduce((sum, shard) => sum + shard.num_ack_pending, 0),
        num_redelivered: shards.reduce((sum, shard) => sum + shard.num_redelivered, 0),
      },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await nats?.drain();
  }
}

async function readPhysicalNatsShardSnapshot(urls: string[]): Promise<Record<string, unknown>> {
  const shardCount = messageWriteShardCount();
  if (urls.length !== shardCount) {
    return {
      error: `NATS_SHARD_URLS count (${urls.length}) must match MESSAGE_WRITE_SHARD_COUNT (${shardCount})`,
    };
  }

  const connections = [];
  try {
    const shards = [];
    for (let index = 0; index < urls.length; index += 1) {
      const nats = await connectNats(urls[index]);
      connections.push(nats);
      const jsm = await nats.jetstreamManager();
      const shard = messageWriteShardForIndex(index, shardCount);
      const [streamInfo, consumerInfo] = await Promise.all([
        jsm.streams.info(shard.stream),
        jsm.consumers.info(shard.stream, shard.consumer),
      ]);
      shards.push({
        index: shard.index,
        url: urls[index],
        stream: shard.stream,
        consumer: shard.consumer,
        messages: streamInfo.state.messages,
        bytes: streamInfo.state.bytes,
        first_seq: streamInfo.state.first_seq,
        last_seq: streamInfo.state.last_seq,
        num_pending: consumerInfo.num_pending,
        num_ack_pending: consumerInfo.num_ack_pending,
        num_redelivered: consumerInfo.num_redelivered,
      });
    }

    return {
      shards,
      totals: {
        messages: shards.reduce((sum, shard) => sum + shard.messages, 0),
        bytes: shards.reduce((sum, shard) => sum + shard.bytes, 0),
        num_pending: shards.reduce((sum, shard) => sum + shard.num_pending, 0),
        num_ack_pending: shards.reduce((sum, shard) => sum + shard.num_ack_pending, 0),
        num_redelivered: shards.reduce((sum, shard) => sum + shard.num_redelivered, 0),
      },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await Promise.all(connections.map((nats) => nats.drain()));
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
