import { fileURLToPath } from 'url';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import type { PrismaClient } from '@prisma/client';
import type { JsMsg, NatsConnection } from 'nats';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import {
  connectNats,
  decodeMessageWriteCommand,
  ensureMessageWriteConsumer,
  messageWriteShardForIndex,
  type MessageWriteCommand,
} from '../../../packages/shared-nats/src/index.js';
import {
  createRedisClients,
  disconnectRedisClients,
  type RedisClients,
} from '../../../packages/shared-redis/src/index.js';
import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
  startMetricsServer,
} from '../../../packages/shared-observability/src/metrics.js';
import {
  drainMessageOutbox,
  processMessageWriteCommand,
  processMessageWriteCommands,
} from './modules/message-writes/message-write.processor.js';

export interface MessageWriterDependencies {
  prisma: PrismaClient;
  nats: NatsConnection;
  redisClients?: RedisClients;
  batchSize?: number;
  batchFlushMs?: number;
  batchConcurrency?: number;
  maxDeliveryAttempts?: number;
  disableFanout?: boolean;
  shardIndex?: number;
}

export interface MessageWriterHandle {
  close(): Promise<void>;
}

export async function startMessageWriter({
  prisma,
  nats,
  redisClients,
  batchSize = Number(process.env.MESSAGE_WRITER_BATCH_SIZE || 250),
  batchFlushMs = Number(process.env.MESSAGE_WRITER_BATCH_FLUSH_MS || 50),
  batchConcurrency = Number(process.env.MESSAGE_WRITER_BATCH_CONCURRENCY || process.env.MESSAGE_WRITER_CONCURRENCY || 4),
  maxDeliveryAttempts = Number(process.env.MESSAGE_WRITE_MAX_DELIVER || 5),
  disableFanout = process.env.MESSAGE_WRITER_DISABLE_FANOUT === 'true',
  shardIndex = Number(process.env.MESSAGE_WRITE_SHARD_INDEX || 0),
}: MessageWriterDependencies): Promise<MessageWriterHandle> {
  const shard = messageWriteShardForIndex(shardIndex);
  await ensureMessageWriteConsumer(nats, shard);
  const metrics = createWriterMetrics();

  const maxBatchSize = Math.max(1, batchSize);
  const maxBatchConcurrency = Math.max(1, batchConcurrency);
  const flushDelayMs = Math.max(0, batchFlushMs);
  const js = nats.jetstream();
  const consumer = await js.consumers.get(shard.stream, shard.consumer);
  const messages = await consumer.consume({
    max_messages: Number(process.env.MESSAGE_WRITER_MAX_MESSAGES || 512),
    expires: Number(process.env.MESSAGE_WRITER_EXPIRES_MS || 1000),
  });
  const currentBatch: QueuedMessageWrite[] = [];
  const pendingBatches: QueuedMessageWrite[][] = [];
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let idleResolver: (() => void) | undefined;

  const notifyIdle = () => {
    if (pendingBatches.length || inFlight.size || currentBatch.length) return;
    idleResolver?.();
    idleResolver = undefined;
  };

  const pump = () => {
    metrics.setQueueState(currentBatch.length, pendingBatches.length, inFlight.size);
    while (inFlight.size < maxBatchConcurrency && pendingBatches.length) {
      const batch = pendingBatches.shift()!;
      const task = handleMessageBatch(batch, prisma, redisClients, maxDeliveryAttempts, disableFanout, metrics)
        .catch((err) => {
          console.error('message write batch failed:', err);
        })
        .finally(() => {
          inFlight.delete(task);
          metrics.setQueueState(currentBatch.length, pendingBatches.length, inFlight.size);
          pump();
          notifyIdle();
        });
      inFlight.add(task);
    }
    metrics.setQueueState(currentBatch.length, pendingBatches.length, inFlight.size);
  };

  const flushCurrentBatch = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!currentBatch.length) return;
    pendingBatches.push(currentBatch.splice(0, currentBatch.length));
    metrics.setQueueState(currentBatch.length, pendingBatches.length, inFlight.size);
    pump();
  };

  const scheduleFlush = () => {
    if (flushDelayMs <= 0) {
      flushCurrentBatch();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushCurrentBatch();
    }, flushDelayMs);
  };

  const loop = (async () => {
    for await (const msg of messages) {
      if (closing) break;

      while (pendingBatches.length >= maxBatchConcurrency * 2 && inFlight.size) {
        await Promise.race(inFlight);
      }

      const queued = decodeQueuedMessageWrite(msg, maxDeliveryAttempts);
      if (!queued) continue;

      currentBatch.push(queued);
      metrics.setQueueState(currentBatch.length, pendingBatches.length, inFlight.size);
      if (currentBatch.length >= maxBatchSize) {
        flushCurrentBatch();
      } else {
        scheduleFlush();
      }
    }
  })().catch((err) => {
    if (!closing) console.error('message writer loop failed:', err);
  });

  return {
    async close(): Promise<void> {
      closing = true;
      await messages.close();
      await loop;
      flushCurrentBatch();
      await waitForIdle();
      metrics.close();
    },
  };

  function waitForIdle(): Promise<void> {
    if (!pendingBatches.length && !inFlight.size && !currentBatch.length) return Promise.resolve();
    return new Promise((resolve) => {
      idleResolver = resolve;
      notifyIdle();
    });
  }
}

interface QueuedMessageWrite {
  msg: JsMsg,
  command: MessageWriteCommand;
  deliveryAttempt: number;
}

function decodeQueuedMessageWrite(
  msg: JsMsg,
  maxDeliveryAttempts: number,
): QueuedMessageWrite | undefined {
  const deliveryAttempt = readDeliveryAttempt(msg);

  try {
    return {
      msg,
      command: decodeMessageWriteCommand(msg.data),
      deliveryAttempt,
    };
  } catch (err) {
    if (deliveryAttempt >= maxDeliveryAttempts) {
      msg.ack();
      return undefined;
    }

    try {
      msg.nak();
    } catch {
      // Leaving the message unacked still lets JetStream redeliver it.
    }
    console.error('message write command decode failed:', err);
    return undefined;
  }
}

async function handleMessageBatch(
  batch: QueuedMessageWrite[],
  prisma: PrismaClient,
  redisClients: RedisClients | undefined,
  maxDeliveryAttempts: number,
  disableFanout: boolean,
  metrics: WriterMetrics,
): Promise<void> {
  const startedAt = performance.now();

  try {
    const messages = await processMessageWriteCommands(prisma, batch.map((entry) => entry.command));
    if (!disableFanout) {
      await drainMessageOutbox(prisma, {
        publisher: redisClients?.publisher,
        limit: Math.max(batch.length, 100),
      });
    }

    for (const entry of batch) entry.msg.ack();
    metrics.recordBatchSuccess(batch.length, messages.length, performance.now() - startedAt);
    return;
  } catch (err) {
    if (batch.length > 1) {
      metrics.recordBatchSplit(batch.length);
      const midpoint = Math.ceil(batch.length / 2);
      await handleMessageBatch(
        batch.slice(0, midpoint),
        prisma,
        redisClients,
        maxDeliveryAttempts,
        disableFanout,
        metrics,
      );
      await handleMessageBatch(
        batch.slice(midpoint),
        prisma,
        redisClients,
        maxDeliveryAttempts,
        disableFanout,
        metrics,
      );
      return;
    }

    await handleSingleMessageWrite(batch[0], prisma, redisClients, maxDeliveryAttempts, disableFanout, metrics, startedAt);
  }
}

async function handleSingleMessageWrite(
  entry: QueuedMessageWrite,
  prisma: PrismaClient,
  redisClients: RedisClients | undefined,
  maxDeliveryAttempts: number,
  disableFanout: boolean,
  metrics: WriterMetrics,
  startedAt: number,
): Promise<void> {
  try {
    const message = await processMessageWriteCommand(prisma, entry.command, {
      originConnectionId: entry.command.origin_connection_id,
      deliveryAttempt: entry.deliveryAttempt,
      maxDeliveryAttempts,
    });
    if (!disableFanout) {
      await drainMessageOutbox(prisma, {
        publisher: redisClients?.publisher,
        limit: 100,
      });
    }
    entry.msg.ack();
    if (!message && entry.deliveryAttempt >= maxDeliveryAttempts) metrics.recordDeadCommand();
    metrics.recordBatchSuccess(1, message ? 1 : 0, performance.now() - startedAt);
  } catch (err) {
    metrics.recordBatchFailure(1, performance.now() - startedAt);

    try {
      entry.msg.nak();
    } catch {
      // Leaving the message unacked still lets JetStream redeliver it.
    }
    console.error('message write command failed:', err);
  }
}

function readDeliveryAttempt(msg: JsMsg): number {
  const info = msg.info as unknown as { deliveryCount?: number };
  return Math.max(1, Number(info.deliveryCount ?? 1));
}

async function main(): Promise<void> {
  const metricsServer = startMetricsServer('message-writer-service', Number(process.env.MESSAGE_WRITER_METRICS_PORT || process.env.METRICS_PORT || 9092));
  const prisma = createPrismaClient();
  const nats = await connectNats();
  const redisClients = await createRedisClients();
  const writer = await startMessageWriter({ prisma, nats, redisClients });
  const shard = messageWriteShardForIndex(Number(process.env.MESSAGE_WRITE_SHARD_INDEX || 0));
  console.log(`message-writer-service consuming ${shard.stream}/${shard.consumer} from ${process.env.NATS_URL || 'nats://localhost:4222'}`);

  const shutdown = async (): Promise<void> => {
    await writer.close();
    metricsServer?.close();
    await disconnectRedisClients(redisClients);
    await nats.drain();
    await prisma.$disconnect();
  };

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error('message-writer-service failed:', err);
    process.exitCode = 1;
  });
}

type WriterMetrics = ReturnType<typeof createWriterMetrics>;

function createWriterMetrics() {
  const intervalMs = Number(process.env.LOAD_METRICS_LOG_INTERVAL_MS || 5000);
  const prometheus = createWriterPrometheusMetrics();
  const batchDuration = createLatencyTracker();
  const batchSize = createLatencyTracker();
  const state = {
    current_batch_size: 0,
    pending_batches: 0,
    in_flight_batches: 0,
  };
  const counters = {
    batch_success: 0,
    batch_failure: 0,
    batch_split: 0,
    batch_split_commands: 0,
    commands_persisted: 0,
    messages_created: 0,
    dead_commands: 0,
  };
  let lastCommandsPersisted = 0;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  const timer = intervalMs > 0
    ? setInterval(() => {
      const commandsSinceLast = counters.commands_persisted - lastCommandsPersisted;
      lastCommandsPersisted = counters.commands_persisted;
      const snapshot = {
        event: 'message_writer_metrics',
        ts: new Date().toISOString(),
        ...counters,
        commands_persisted_per_sec: Math.round((commandsSinceLast / (intervalMs / 1000)) * 100) / 100,
        ...state,
        batch_size: batchSize.snapshotAndReset(),
        batch_duration_ms: batchDuration.snapshotAndReset(),
        event_loop_lag_ms: {
          avg: roundMs(eventLoopDelay.mean / 1_000_000),
          max: roundMs(eventLoopDelay.max / 1_000_000),
        },
      };
      prometheus.setEventLoopLag(snapshot.event_loop_lag_ms.avg, snapshot.event_loop_lag_ms.max);
      eventLoopDelay.reset();
      console.log(JSON.stringify(snapshot));
    }, intervalMs)
    : undefined;
  timer?.unref();

  return {
    setQueueState(currentBatchSize: number, pendingBatches: number, inFlightBatches: number): void {
      state.current_batch_size = currentBatchSize;
      state.pending_batches = pendingBatches;
      state.in_flight_batches = inFlightBatches;
      prometheus.setQueueState(currentBatchSize, pendingBatches, inFlightBatches);
    },
    recordBatchSuccess(commands: number, createdMessages: number, durationMs: number): void {
      counters.batch_success += 1;
      counters.commands_persisted += commands;
      counters.messages_created += createdMessages;
      batchSize.add(commands);
      batchDuration.add(durationMs);
      prometheus.recordBatchSuccess(commands, createdMessages, durationMs);
    },
    recordBatchFailure(commands: number, durationMs: number): void {
      counters.batch_failure += 1;
      batchSize.add(commands);
      batchDuration.add(durationMs);
      prometheus.recordBatchFailure(commands, durationMs);
    },
    recordBatchSplit(commands: number): void {
      counters.batch_split += 1;
      counters.batch_split_commands += commands;
      prometheus.recordBatchSplit(commands);
    },
    recordDeadCommand(): void {
      counters.dead_commands += 1;
      prometheus.recordDeadCommand();
    },
    close(): void {
      if (timer) clearInterval(timer);
      eventLoopDelay.disable();
    },
  };
}

function createWriterPrometheusMetrics() {
  const batchesTotal = getOrCreateCounter({
    name: 'backend_message_writer_batches_total',
    help: 'Total message writer batches by result.',
    labelNames: ['result'],
  });
  const batchSplitCommandsTotal = getOrCreateCounter({
    name: 'backend_message_writer_batch_split_commands_total',
    help: 'Total commands in message writer batches that were split.',
  });
  const commandsPersistedTotal = getOrCreateCounter({
    name: 'backend_message_writer_commands_persisted_total',
    help: 'Total message write commands persisted by the writer.',
  });
  const messagesCreatedTotal = getOrCreateCounter({
    name: 'backend_message_writer_messages_created_total',
    help: 'Total Message rows created by the writer.',
  });
  const deadCommandsTotal = getOrCreateCounter({
    name: 'backend_message_writer_dead_commands_total',
    help: 'Total message write commands discarded after max delivery attempts.',
  });
  const currentBatchSize = getOrCreateGauge({
    name: 'backend_message_writer_current_batch_size',
    help: 'Current open message writer batch size.',
  });
  const pendingBatches = getOrCreateGauge({
    name: 'backend_message_writer_pending_batches',
    help: 'Message writer batches waiting for processing.',
  });
  const inFlightBatches = getOrCreateGauge({
    name: 'backend_message_writer_in_flight_batches',
    help: 'Message writer batches currently being processed.',
  });
  const batchSize = getOrCreateHistogram({
    name: 'backend_message_writer_batch_size',
    help: 'Message writer batch sizes.',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  });
  const batchDuration = getOrCreateHistogram({
    name: 'backend_message_writer_batch_duration_ms',
    help: 'Message writer batch processing duration in milliseconds.',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  });
  const eventLoopLag = getOrCreateGauge({
    name: 'backend_message_writer_event_loop_lag_ms',
    help: 'Message writer event loop lag in milliseconds.',
    labelNames: ['stat'],
  });

  return {
    setQueueState(currentBatch: number, pending: number, inFlight: number): void {
      currentBatchSize.set(currentBatch);
      pendingBatches.set(pending);
      inFlightBatches.set(inFlight);
    },
    recordBatchSuccess(commands: number, createdMessages: number, durationMs: number): void {
      batchesTotal.labels('success').inc();
      commandsPersistedTotal.inc(commands);
      messagesCreatedTotal.inc(createdMessages);
      batchSize.observe(commands);
      batchDuration.observe(Math.max(0, durationMs));
    },
    recordBatchFailure(commands: number, durationMs: number): void {
      batchesTotal.labels('failure').inc();
      batchSize.observe(commands);
      batchDuration.observe(Math.max(0, durationMs));
    },
    recordBatchSplit(commands: number): void {
      batchesTotal.labels('split').inc();
      batchSplitCommandsTotal.inc(commands);
    },
    recordDeadCommand(): void {
      deadCommandsTotal.inc();
    },
    setEventLoopLag(avgMs: number, maxMs: number): void {
      eventLoopLag.labels('avg').set(avgMs);
      eventLoopLag.labels('max').set(maxMs);
    },
  };
}

type LatencySnapshot = {
  count: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
};

function createLatencyTracker(maxSamples = Number(process.env.LOAD_METRICS_MAX_LATENCY_SAMPLES || 20_000)) {
  const samples: number[] = [];
  let count = 0;
  let sum = 0;
  let max = 0;

  return {
    add(value: number): void {
      const normalized = Math.max(0, value);
      count += 1;
      sum += normalized;
      max = Math.max(max, normalized);
      if (samples.length < maxSamples) samples.push(normalized);
    },
    snapshotAndReset(): LatencySnapshot {
      const sorted = [...samples].sort((a, b) => a - b);
      const p95Index = sorted.length ? Math.ceil(sorted.length * 0.95) - 1 : 0;
      const snapshot = {
        count,
        avg_ms: count ? roundMs(sum / count) : 0,
        p95_ms: sorted.length ? roundMs(sorted[p95Index]) : 0,
        max_ms: roundMs(max),
      };
      samples.length = 0;
      count = 0;
      sum = 0;
      max = 0;
      return snapshot;
    },
  };
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
