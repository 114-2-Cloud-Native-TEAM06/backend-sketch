import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import type { PrismaClient } from '@prisma/client';
import { createUserServiceApp, type UserServiceDependencies } from './app.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { createRedisClients, disconnectRedisClients } from '../../../packages/shared-redis/src/index.js';

export function startUserService(
  port = Number(process.env.USER_SERVICE_PORT || 8082),
  prisma: PrismaClient = createPrismaClient(),
  deps: UserServiceDependencies = {},
): Server {
  const server = createServer(createUserServiceApp(prisma, deps));
  server.listen(port, () => {
    console.log(`user-service running on port ${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const redisClients = await createRedisClients();
  const server = startUserService(Number(process.env.USER_SERVICE_PORT || 8082), createPrismaClient(), {
    redis: redisClients.app,
  });
  server.on('close', () => {
    void disconnectRedisClients(redisClients);
  });
}
