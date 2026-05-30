import 'express-async-errors';
import express, { Express } from 'express';
import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createChatRouter } from './modules/chats/chats.routes.js';
import { createUserRouter } from './modules/users/users.routes.js';
import { createWebSocketServer, startWebSocketServer } from './modules/realtime/realtime.server.js';
import { errorMiddleware } from './utils/errHandler.js';
import { logger, shutdownLogger } from './modules/shared/observability/logger.js';

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
    logger.info({ port }, 'REST server running');
  });
  return server;
}

export { createWebSocketServer, startWebSocketServer };

function closeServer(server: { close(cb: (err?: Error) => void): void }): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const restServer = startRestServer();
  const wsServer = startWebSocketServer();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Hard ceiling: a stuck close must never block the process forever.
    const hardTimeout = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    hardTimeout.unref();

    try {
      // Force-close live WebSocket clients so wsServer.close() can resolve
      // (long-lived sockets would otherwise keep it open indefinitely).
      for (const client of wsServer.clients) client.terminate();
      await Promise.all([closeServer(wsServer), closeServer(restServer)]);
      // Flush telemetry, then logs, before exiting.
      const { shutdownTelemetry } = await import('./instrumentation.js');
      await shutdownTelemetry();
      await shutdownLogger();
      clearTimeout(hardTimeout);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown error');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
