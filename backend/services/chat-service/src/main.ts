import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import type { PrismaClient } from '@prisma/client';
import { createChatServiceApp, type ChatServiceDependencies } from './app.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { createRedisClients, disconnectRedisClients } from '../../../packages/shared-redis/src/index.js';

export function startChatService(
  port = Number(process.env.CHAT_SERVICE_PORT || 8080),
  prisma: PrismaClient = createPrismaClient(),
  deps: ChatServiceDependencies = {},
): Server {
  const server = createServer(createChatServiceApp(prisma, deps));
  server.listen(port, () => {
    console.log(`chat-service running on port ${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const redisClients = await createRedisClients();
  const server = startChatService(Number(process.env.CHAT_SERVICE_PORT || 8080), createPrismaClient(), {
    redis: redisClients.app,
    publisher: redisClients.publisher,
  });
  server.on('close', () => {
    void disconnectRedisClients(redisClients);
  });
}
