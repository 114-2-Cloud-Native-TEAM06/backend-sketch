import { fileURLToPath } from 'url';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { startWebSocketServer } from './modules/realtime/realtime.server.js';
import {
  connectNatsShards,
  connectNats,
  createJetStreamMessageWritePublisher,
  natsShardUrls,
} from '../../../packages/shared-nats/src/index.js';
import {
  createRedisClients,
  disconnectRedisClients,
} from '../../../packages/shared-redis/src/index.js';
import { startMetricsServer } from '../../../packages/shared-observability/src/metrics.js';

export async function startRealtimeService(): Promise<ReturnType<typeof startWebSocketServer>> {
  const metricsServer = startMetricsServer('realtime-service', Number(process.env.REALTIME_METRICS_PORT || process.env.METRICS_PORT || 9091));
  const prisma = createPrismaClient();
  const redisClients = await createRedisClients();
  const natsShardUrlList = natsShardUrls();
  const natsConnections = process.env.NATS_SHARD_URLS
    ? await connectNatsShards(natsShardUrlList)
    : [await connectNats()];
  const messageWritePublisher = await createJetStreamMessageWritePublisher(natsConnections);
  const wss = startWebSocketServer(Number(process.env.WS_PORT || 8081), prisma, {
    redis: redisClients.app,
    publisher: redisClients.publisher,
    subscriber: redisClients.subscriber,
    messageWritePublisher,
  });
  wss.on('close', () => {
    void disconnectRedisClients(redisClients);
    for (const nats of natsConnections) void nats.drain();
    void prisma.$disconnect();
  });
  wss.on('close', () => {
    metricsServer?.close();
  });
  return wss;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startRealtimeService();
}
