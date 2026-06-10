import fs from 'fs/promises';
import path from 'path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const userCount = Number(process.env.LOAD_USER_COUNT || 100);
const jwtSecret = process.env.JWT_SECRET || 'dev_secret_change_in_prod';
const wsUrl = process.env.LOAD_WS_URL || 'ws://127.0.0.1:8081/ws/chat';
const roomStrategy = process.env.LOAD_ROOM_STRATEGY || 'paired';
const outputPath = path.resolve('load-tests/generated/ws-1000-msgs.json');

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const users = await Promise.all(Array.from({ length: userCount }, async (_, idx) => {
    const suffix = String(idx + 1).padStart(4, '0');
    const username = `load_user_${suffix}`;
    const user = await prisma.user.upsert({
      where: { username },
      update: {},
      create: {
        username,
        email: `${username}@example.com`,
        displayName: `Load User ${suffix}`,
        password: 'load-test-password', // NOSONAR seed-script test account password, not a production secret
      },
    });
    return {
      id: user.id,
      username: user.username,
      token: jwt.sign({ userId: user.id, username: user.username }, jwtSecret),
    };
  }));

  const rooms: Array<{ id: string; memberIds: string[] }> = [];
  const userRoomIndexes: number[] = [];
  if (roomStrategy === 'one-room-per-user') {
    const partners = await Promise.all(Array.from({ length: users.length }, async (_, idx) => {
      const suffix = String(idx + 1).padStart(4, '0');
      const username = `load_partner_${suffix}`;
      return prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          email: `${username}@example.com`,
          displayName: `Load Partner ${suffix}`,
          password: 'load-test-password', // NOSONAR seed-script test account password, not a production secret
        },
      });
    }));

    for (let idx = 0; idx < users.length; idx += 1) {
      const memberIds = [users[idx].id, partners[idx].id];
      const room = await prisma.room.create({
        data: {
          isGroup: false,
          members: { create: memberIds.map((userId) => ({ userId })) },
        },
      });
      userRoomIndexes[idx] = rooms.length;
      rooms.push({ id: room.id, memberIds });
    }
  } else {
    for (let idx = 0; idx < users.length; idx += 2) {
      const memberIds = [users[idx].id, users[(idx + 1) % users.length].id];
      const room = await prisma.room.create({
        data: {
          isGroup: false,
          members: { create: memberIds.map((userId) => ({ userId })) },
        },
      });
      userRoomIndexes[idx] = rooms.length;
      userRoomIndexes[(idx + 1) % users.length] = rooms.length;
      rooms.push({ id: room.id, memberIds });
    }
  }

  if (roomStrategy !== 'paired' && roomStrategy !== 'one-room-per-user') {
    throw new Error(`Unsupported LOAD_ROOM_STRATEGY: ${roomStrategy}`);
  }

  const usersWithRooms = users.map((user, idx) => ({
    ...user,
    roomId: rooms[userRoomIndexes[idx]].id,
  }));

  await fs.writeFile(outputPath, JSON.stringify({
    wsUrl,
    rooms,
    users: usersWithRooms,
  }, null, 2));

  console.log(`Wrote ${outputPath} with ${users.length} users and ${rooms.length} rooms`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
