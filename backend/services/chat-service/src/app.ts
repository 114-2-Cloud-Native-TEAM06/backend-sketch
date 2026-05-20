import 'express-async-errors';
import express, { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createChatRouter } from './modules/chats/chats.routes.js';
import { errorMiddleware } from '../../../packages/shared-errors/src/error-middleware.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';

function apiPrefix(): string {
  return `/api/v${process.env.API_VERSION || '1'}`;
}

export function createChatServiceApp(prisma: PrismaClient = createPrismaClient()): Express {
  const app: Express = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(`${apiPrefix()}/chats`, createChatRouter(prisma));
  app.use(errorMiddleware);

  return app;
}
