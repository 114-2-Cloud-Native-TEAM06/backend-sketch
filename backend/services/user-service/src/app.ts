import 'express-async-errors';
import express, { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createUserRouter } from './modules/users/users.routes.js';
import { createPrismaClient } from '../../../packages/shared-db/src/prisma.js';
import { errorMiddleware } from '../../../packages/shared-errors/src/error-middleware.js';

function apiPrefix(): string {
  return `/api/v${process.env.API_VERSION || '1'}`;
}

export function createUserServiceApp(prisma: PrismaClient = createPrismaClient()): Express {
  const app: Express = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(`${apiPrefix()}/auth`, createAuthRouter(prisma));
  app.use(`${apiPrefix()}/users`, createUserRouter(prisma));
  app.use(errorMiddleware);

  return app;
}
