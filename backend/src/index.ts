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

// Single-port mode for PaaS (one public port): REST on / and WebSocket on
// /ws/chat share the same HTTP server, so HTTPS/wss work over one domain.
export function startCombinedServer(
  port = Number(process.env.PORT || process.env.REST_PORT || 8080),
): Server {
  const server = createServer(createRestApp());
  createWebSocketServer(server);
  server.listen(port, () => {
    console.log(`REST + WebSocket running on port ${port} (REST: /api, WS: /ws/chat)`);
  });
  return server;
}

export { createWebSocketServer, startWebSocketServer };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // PaaS sets PORT → serve REST + WS on one port; otherwise keep the local
  // two-port layout (REST 8080 / WS 8081) used by docker-compose and tests.
  if (process.env.PORT) {
    startCombinedServer();
  } else {
    startRestServer();
    startWebSocketServer();
  }
  void startMessageDbWriter(new PrismaClient());
}
