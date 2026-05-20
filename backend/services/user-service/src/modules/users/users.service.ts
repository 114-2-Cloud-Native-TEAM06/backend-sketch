import type { PrismaClient } from '@prisma/client';
import type { User } from '../../../../../packages/shared-types/src/api-types.js';
import { AppError } from '../../../../../packages/shared-errors/src/app-error.js';
import { findUserById, updateUser } from './users.repository.js';

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

export async function getMe(prisma: PrismaClient, userId: string): Promise<User> {
  const user = await findUserById(prisma, userId);
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return toUserDto(user);
}

export async function updateMe(
  prisma: PrismaClient,
  userId: string,
  body: unknown,
): Promise<User> {
  const { display_name, avatar_url } = body as Record<string, unknown>;

  if (!display_name && !avatar_url)
    throw new AppError(400, 'VALIDATION_FAILED', 'At least one of display_name or avatar_url is required');

  const user = await updateUser(prisma, userId, {
    ...(display_name ? { displayName: String(display_name) } : {}),
  });
  return toUserDto(user);
}

export async function getUserById(prisma: PrismaClient, userId: string): Promise<User> {
  const user = await findUserById(prisma, userId);
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return toUserDto(user);
}
