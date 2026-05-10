import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserPayload {
  id: string;
  username: string;
}

interface CreateUserResponse {
  id: string;
  username: string;
  displayName: string;
  email: string;
  createdAt: Date;
}

function signToken(user: UserPayload): string {
  return jwt.sign(
    { userId: user.id, username: user.username },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' },
  );
}

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, displayName, email, password } = req.body;

  if (!username || !displayName || !email || !password) {
    res.status(400).json({
      error: 'username, displayName, email, password are required',
    });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res
      .status(400)
      .json({
        error: 'Username may only contain letters, numbers, _ and - (3–32 chars)',
      });
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Email';
      res.status(409).json({ error: `${field} already taken` });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { username, displayName, email, password: hashedPassword },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        createdAt: true,
      },
    });

    const token = signToken(user);

    res.status(201).json({ user, token });
  } catch (err) {
    console.error('[register]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = signToken(user);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
      },
      token,
    });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
