import type { PrismaClient } from '@prisma/client';

const USER_SELECT = { id: true, username: true, email: true, displayName: true, createdAt: true } as const;

export function findUserById(prisma: PrismaClient, id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: USER_SELECT,
  });
}

export function updateUser(
  prisma: PrismaClient,
  id: string,
  input: { displayName?: string },
) {
  return prisma.user.update({
    where: { id },
    data: input,
    select: USER_SELECT,
  });
}

