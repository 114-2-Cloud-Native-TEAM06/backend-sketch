import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../shared/auth/auth-middleware.js';
import { createPrismaClient } from '../shared/db/prisma.js';
import { login, refresh, register } from './auth.service.js';

export function createAuthRouter(prisma: PrismaClient = createPrismaClient()): Router {
  const router = Router();

  router.post('/register', async (req: Request, res: Response): Promise<void> => {
    const result = await register(prisma, req.body);
    res.status(201).json(result);
  });

  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const result = await login(prisma, req.body);
    res.json(result);
  });

  router.post('/refresh', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const result = await refresh(prisma, req.user);
    res.json(result);
  });

  return router;
}
