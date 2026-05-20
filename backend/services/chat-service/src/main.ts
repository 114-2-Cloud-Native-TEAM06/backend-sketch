import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import type { PrismaClient } from '@prisma/client';
import { createChatServiceApp } from './app.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';

export function startChatService(
  port = Number(process.env.CHAT_SERVICE_PORT || 8080),
  prisma: PrismaClient = createPrismaClient(),
): Server {
  const server = createServer(createChatServiceApp(prisma));
  server.listen(port, () => {
    console.log(`chat-service running on port ${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startChatService();
}
