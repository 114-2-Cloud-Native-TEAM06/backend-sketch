import 'express-async-errors';
import express, { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createUserRouter } from './modules/users/users.routes.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { errorMiddleware } from '../../../packages/shared-errors/src/error-middleware.js';
import {
  createRateLimitMiddleware,
  type RedisLike,
} from '../../../packages/shared-redis/src/index.js';

function apiPrefix(): string {
  return `/api/v${process.env.API_VERSION || '1'}`;
}

export interface UserServiceDependencies {
  redis?: RedisLike;
}

export function createUserServiceApp(
  prisma: PrismaClient = createPrismaClient(),
  deps: UserServiceDependencies = {},
): Express {
  const app: Express = express();
  app.disable('x-powered-by'); // don't leak framework/version info
  app.use(express.json());

  app.get('/health', (_req, res) => {
    if (deps.redis?.isOpen === false) {
      res.status(503).json({ status: 'degraded', redis: 'down' });
      return;
    }
    res.json({ status: 'ok' });
  });

  app.use(
    `${apiPrefix()}/auth`,
    createRateLimitMiddleware(deps.redis, {
      keyPrefix: 'rest:auth',
      limit: Number(process.env.REST_AUTH_RATE_LIMIT_PER_MINUTE || 20),
      windowSeconds: 60,
    }),
    createAuthRouter(prisma),
  );
  app.use(
    `${apiPrefix()}/users`,
    createRateLimitMiddleware(deps.redis, {
      keyPrefix: 'rest:user',
      limit: Number(process.env.REST_RATE_LIMIT_PER_MINUTE || 120),
      windowSeconds: 60,
    }),
    createUserRouter(prisma),
  );
  app.use(errorMiddleware);

  return app;
}
