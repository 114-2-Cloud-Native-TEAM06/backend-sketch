import 'express-async-errors';
import express, { Express } from 'express';
import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createChatRouter } from './modules/chats/chats.routes.js';
import { createUserRouter } from './modules/users/users.routes.js';
import { createWebSocketServer, startWebSocketServer } from './modules/realtime/realtime.server.js';
import { startMessageDbWriter } from './modules/messaging/message-db-writer.js';
import { errorMiddleware } from './utils/errHandler.js';

// ─── REST server (port 8080) ─────────────────────────────────────────────────

export function createRestApp(): Express {
  const app: Express = express();
  app.use(express.json());

  const API_VERSION = process.env.API_VERSION || '1';
  app.use(`/api/v${API_VERSION}/auth`, createAuthRouter());
  app.use(`/api/v${API_VERSION}/chats`, createChatRouter());
  app.use(`/api/v${API_VERSION}/users`, createUserRouter());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(errorMiddleware);

  return app;
}

export function startRestServer(port = Number(process.env.REST_PORT || 8080)): Server {
  const server = createServer(createRestApp());
  server.listen(port, () => {
    console.log(`REST server running on port ${port}`);
  });
  return server;
}

export { createWebSocketServer, startWebSocketServer };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRestServer();
  startWebSocketServer();
  void startMessageDbWriter(new PrismaClient());
}
