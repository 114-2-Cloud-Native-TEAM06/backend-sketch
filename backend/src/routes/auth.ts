import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import type { User, AuthResponse, ApiError, ErrorCode } from '../types/api-types.js';

const router = Router();
const prisma = new PrismaClient();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(userId: string, username: string): string {
  return jwt.sign(
    { userId, username },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' },
  );
}

function toUserDto(row: {
  id: string;
  username: string;
  email: string;
  displayName: string;
  createdAt: Date;
}): User {
  return {
    id:           row.id,
    username:     row.username,
    email:        row.email,
    display_name: row.displayName,
    avatar_url:   undefined,
    created_at:   row.createdAt.toISOString(),
  };
}

function apiError(code: ErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

// POST /api/v1/auth/register
// Body: { username, email, password, display_name }
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password, display_name } = req.body;

  if (!username || !email || !password || !display_name) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'username, email, password, display_name are required'));
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'Username may only contain letters, numbers, _ and - (3–32 chars)'));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'Invalid email format'));
    return;
  }
  if (password.length < 8) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'Password must be at least 8 characters'));
    return;
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Email';
      res.status(409).json(apiError('CONFLICT', `${field} already taken`));
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const row = await prisma.user.create({
      data: { username, displayName: display_name, email, password: hashed },
      select: { id: true, username: true, email: true, displayName: true, createdAt: true },
    });

    const user  = toUserDto(row);
    const token = signToken(row.id, row.username);
    res.status(201).json({ token, user } satisfies AuthResponse);
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// POST /api/v1/auth/login
// Body: { email, password }
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'email and password are required'));
    return;
  }

  try {
    const row = await prisma.user.findUnique({
      where: { email },
      select: { id: true, username: true, email: true, displayName: true, createdAt: true, password: true },
    });

    if (!row || !(await bcrypt.compare(password, row.password))) {
      res.status(401).json(apiError('AUTH_REQUIRED', 'Invalid email or password'));
      return;
    }

    const user  = toUserDto(row);
    const token = signToken(row.id, row.username);
    res.json({ token, user } satisfies AuthResponse);
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

export default router;
