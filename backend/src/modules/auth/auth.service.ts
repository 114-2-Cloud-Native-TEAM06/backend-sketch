import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import type { AuthResponse, User } from '../shared/types/api-types.js';
import { AppError } from '../shared/errors/app-error.js';
import { signToken, type JwtPayload } from '../shared/auth/jwt.js';
import {
  createUser,
  findUserByEmail,
  findUserByEmailOrUsername,
  findUserById,
} from './auth.repository.js';

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGISTER_REQUIRED_MESSAGE = 'username, email, password, display_name are required';
const USERNAME_RULE_MESSAGE = 'username must be 3-32 characters and contain only letters, numbers, "_" or "-"';
const EMAIL_RULE_MESSAGE = 'email must be a valid email address';
const PASSWORD_RULE_MESSAGE = 'password must be at least 8 characters';

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function register(prisma: PrismaClient, body: unknown): Promise<AuthResponse> {
  const { username, email, password, display_name } = body as Record<string, unknown>;

  if (
    !isNonEmptyString(username) ||
    !isNonEmptyString(email) ||
    !isNonEmptyString(password) ||
    !isNonEmptyString(display_name)
  )
    throw new AppError(400, 'VALIDATION_FAILED', REGISTER_REQUIRED_MESSAGE);
  if (!USERNAME_RE.test(username))
    throw new AppError(400, 'VALIDATION_FAILED', USERNAME_RULE_MESSAGE);
  if (!EMAIL_RE.test(email))
    throw new AppError(400, 'VALIDATION_FAILED', EMAIL_RULE_MESSAGE);
  if (password.length < 8)
    throw new AppError(400, 'VALIDATION_FAILED', PASSWORD_RULE_MESSAGE);

  const existing = await findUserByEmailOrUsername(prisma, { email, username });
  if (existing) {
    const field = existing.username === username ? 'username' : 'email';
    throw new AppError(409, 'CONFLICT', `${field} already taken`);
  }

  const hashed = await bcrypt.hash(password, 10);
  const row = await createUser(prisma, {
    username,
    displayName: display_name,
    email,
    password: hashed,
  });

  const user  = toUserDto(row);
  const token = signToken(row.id, row.username);
  return { token, user };
}

export async function login(prisma: PrismaClient, body: unknown): Promise<AuthResponse> {
  const { email, password } = body as Record<string, unknown>;

  if (!email || !password)
    throw new AppError(400, 'VALIDATION_FAILED', 'email and password are required');

  const row = typeof email === 'string' ? await findUserByEmail(prisma, email) : null;

  if (!row || typeof password !== 'string' || !(await bcrypt.compare(password, row.password)))
    throw new AppError(401, 'AUTH_REQUIRED', 'Invalid email or password');

  const user  = toUserDto(row);
  const token = signToken(row.id, row.username);
  return { token, user };
}

export async function refresh(
  prisma: PrismaClient,
  user: JwtPayload | undefined,
): Promise<{ token: string }> {
  const { userId, username } = user ?? {};

  if (!userId || !username) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Invalid token payload');
  }

  const row = await findUserById(prisma, userId);

  if (!row) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }

  return { token: signToken(row.id, row.username) };
}
