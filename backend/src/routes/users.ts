import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../middleware/auth.js';
import type { User } from '../types/api-types.js';
import { AppError } from '../utils/errHandler.js';

function toUserDto(row: {
  id: string; username: string; email: string; displayName: string; createdAt: Date;
}): User {
  return {
    id:           row.id,
    username:     row.username,
    email:        row.email,
    display_name: row.displayName,
    created_at:   row.createdAt.toISOString(),
  };
}

const USER_SELECT = { id: true, username: true, email: true, displayName: true, createdAt: true } as const;

export function createUserRouter(prisma: PrismaClient = new PrismaClient()): Router {
  const router = Router();

  // GET /api/v1/users/me
  router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: USER_SELECT,
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(toUserDto(user));
  });

  // PATCH /api/v1/users/me
  router.patch('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { display_name, avatar_url } = req.body;

    if (!display_name && !avatar_url)
      throw new AppError(400, 'VALIDATION_FAILED', 'At least one of display_name or avatar_url is required');

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { ...(display_name ? { displayName: display_name } : {}) },
      select: USER_SELECT,
    });
    res.json(toUserDto(user));
  });

  // GET /api/v1/users/:id  — 建立 chat 前確認對方存在
  router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: USER_SELECT,
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(toUserDto(user));
  });

  return router;
}
