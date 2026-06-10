import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../../../../../packages/shared-auth/src/auth-middleware.js';
import { getUserById, updateMe } from './users.service.js';

export function createUserRouter(prisma: PrismaClient = new PrismaClient()): Router {
  const router = Router();

  router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const user = await getUserById(prisma, req.user!.userId);
    res.json(user);
  });

  router.patch('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const user = await updateMe(prisma, req.user!.userId, req.body);
    res.json(user);
  });

  router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const user = await getUserById(prisma, req.params.id);
    res.json(user);
  });

  return router;
}
