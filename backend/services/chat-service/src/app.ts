import 'express-async-errors';
import express, { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createChatRouter } from './modules/chats/chats.routes.js';
import { errorMiddleware } from '../../../packages/shared-errors/src/error-middleware.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import {
  createRateLimitMiddleware,
  type RedisLike,
} from '../../../packages/shared-redis/src/index.js';

function apiPrefix(): string {
  return `/api/v${process.env.API_VERSION || '1'}`;
}

export interface ChatServiceDependencies {
  redis?: RedisLike;
  publisher?: RedisLike;
}

export function createChatServiceApp(
  prisma: PrismaClient = createPrismaClient(),
  deps: ChatServiceDependencies = {},
): Express {
  const app: Express = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    if (deps.redis?.isOpen === false) {
      res.status(503).json({ status: 'degraded', redis: 'down' });
      return;
    }
    res.json({ status: 'ok' });
  });

  app.use(
    `${apiPrefix()}/chats`,
    createRateLimitMiddleware(deps.redis, {
      keyPrefix: 'rest:chat',
      limit: Number(process.env.REST_RATE_LIMIT_PER_MINUTE || 120),
      windowSeconds: 60,
    }),
    createChatRouter(prisma, deps),
  );
  app.use(errorMiddleware);

  return app;
}
