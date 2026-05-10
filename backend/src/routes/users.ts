import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../middleware/auth.js';
import type { User, ApiError, ErrorCode } from '../types/api-types.js';

const router = Router();
const prisma = new PrismaClient();

function apiError(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

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

// GET /api/v1/users/me
router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: USER_SELECT,
    });
    if (!user) {
      res.status(404).json(apiError('NOT_FOUND', 'User not found'));
      return;
    }
    res.json(toUserDto(user));
  } catch (err) {
    console.error('[GET /users/me]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// PATCH /api/v1/users/me
router.patch('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { display_name, avatar_url } = req.body;

  if (!display_name && !avatar_url) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'At least one of display_name or avatar_url is required'));
    return;
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { ...(display_name ? { displayName: display_name } : {}) },
      select: USER_SELECT,
    });
    res.json(toUserDto(user));
  } catch (err) {
    console.error('[PATCH /users/me]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// GET /api/v1/users/:id  — 建立 chat 前確認對方存在
router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: USER_SELECT,
    });
    if (!user) {
      res.status(404).json(apiError('NOT_FOUND', 'User not found'));
      return;
    }
    res.json(toUserDto(user));
  } catch (err) {
    console.error('[GET /users/:id]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

export default router;
