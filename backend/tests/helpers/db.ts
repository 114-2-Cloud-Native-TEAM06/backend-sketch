import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

function assertTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing to reset database unless NODE_ENV=test');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for integration tests');
  }

  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, '');
  if (!url.hostname.includes('test') && !databaseName.includes('test')) {
    throw new Error('Refusing to reset database unless DATABASE_URL points to a test database');
  }
}

export async function resetDatabase(): Promise<void> {
  assertTestDatabase();

  await prisma.message.deleteMany();
  await prisma.roomMember.deleteMany();
  await prisma.room.deleteMany();
  await prisma.user.deleteMany();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
