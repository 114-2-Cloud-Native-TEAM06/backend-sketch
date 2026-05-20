import type { PrismaClient } from '@prisma/client';

const USER_SELECT = { id: true, username: true, email: true, displayName: true, createdAt: true } as const;

export function findUserByEmailOrUsername(
  prisma: PrismaClient,
  input: { email: string; username: string },
) {
  return prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
  });
}

export function findUserByEmail(prisma: PrismaClient, email: string) {
  return prisma.user.findUnique({
    where: { email },
    select: { ...USER_SELECT, password: true },
  });
}

export function findUserById(prisma: PrismaClient, id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: USER_SELECT,
  });
}

export function createUser(
  prisma: PrismaClient,
  input: { username: string; email: string; password: string; displayName: string },
) {
  return prisma.user.create({
    data: input,
    select: USER_SELECT,
  });
}

