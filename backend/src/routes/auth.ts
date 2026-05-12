import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import type { User, AuthResponse} from '../types/api-types.js';
import { AppError } from '../utils/errHandler.js';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signToken(userId: string, username: string): string {
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

export function createAuthRouter(prisma: PrismaClient = new PrismaClient()): Router {
  const router = Router();

  // POST /api/v1/auth/register
  // Body: { username, email, password, display_name }
  router.post('/register', async (req: Request, res: Response): Promise<void> => {
    const { username, email, password, display_name } = req.body;

    if (!username || !email || !password || !display_name)
      throw new AppError(400, 'VALIDATION_FAILED', 'username, email, password, display_name are required');
    if (!USERNAME_RE.test(username))
      throw new AppError(400, 'VALIDATION_FAILED', 'Username may only contain letters, numbers, _ and - (3–32 chars)');
    if (!EMAIL_RE.test(email))
      throw new AppError(400, 'VALIDATION_FAILED', 'Invalid email format');
    if (password.length < 8)
      throw new AppError(400, 'VALIDATION_FAILED', 'Password must be at least 8 characters');

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Email';
      throw new AppError(409, 'CONFLICT', `${field} already taken`);
    }

    const hashed = await bcrypt.hash(password, 10);
    const row = await prisma.user.create({
      data: { username, displayName: display_name, email, password: hashed },
      select: { id: true, username: true, email: true, displayName: true, createdAt: true },
    });

    const user  = toUserDto(row);
    const token = signToken(row.id, row.username);
    res.status(201).json({ token, user } satisfies AuthResponse);
  });

  // POST /api/v1/auth/login
  // Body: { email, password }
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    if (!email || !password)
      throw new AppError(400, 'VALIDATION_FAILED', 'email and password are required');

    const row = await prisma.user.findUnique({
      where: { email },
      select: { id: true, username: true, email: true, displayName: true, createdAt: true, password: true },
    });

    if (!row || !(await bcrypt.compare(password, row.password)))
      throw new AppError(401, 'AUTH_REQUIRED', 'Invalid email or password');

    const user  = toUserDto(row);
    const token = signToken(row.id, row.username);
    res.json({ token, user } satisfies AuthResponse);
  });

  return router;
}
