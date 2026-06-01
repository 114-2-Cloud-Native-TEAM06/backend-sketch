import { fileURLToPath } from 'url';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { startWebSocketServer } from './modules/realtime/realtime.server.js';
import {
  connectNats,
  createJetStreamMessageWritePublisher,
} from '../../../packages/shared-nats/src/index.js';
import {
  createRedisClients,
  disconnectRedisClients,
} from '../../../packages/shared-redis/src/index.js';

export async function startRealtimeService(): Promise<ReturnType<typeof startWebSocketServer>> {
  const prisma = createPrismaClient();
  const redisClients = await createRedisClients();
  const nats = await connectNats();
  const messageWritePublisher = await createJetStreamMessageWritePublisher(nats);
  const wss = startWebSocketServer(Number(process.env.WS_PORT || 8081), prisma, {
    redis: redisClients.app,
    publisher: redisClients.publisher,
    subscriber: redisClients.subscriber,
    messageWritePublisher,
  });
  wss.on('close', () => {
    void disconnectRedisClients(redisClients);
    void nats.drain();
    void prisma.$disconnect();
  });
  return wss;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startRealtimeService();
}
