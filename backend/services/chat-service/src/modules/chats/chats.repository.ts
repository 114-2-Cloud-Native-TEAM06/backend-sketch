import type { PrismaClient } from '@prisma/client';

export function findMembershipsForUser(prisma: PrismaClient, userId: string) {
  return prisma.roomMember.findMany({
    where: { userId },
    include: {
      room: {
        include: {
          members: {
            include: { user: { select: { id: true, displayName: true } } },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
    orderBy: { room: { lastMessageAt: 'desc' } },
  });
}

export function findRoomMembership(prisma: PrismaClient, input: { userId: string; roomId: string }) {
  return prisma.roomMember.findUnique({
    where: { userId_roomId: input },
  });
}

export function findUserForChatMember(prisma: PrismaClient, identifier: string) {
  return prisma.user.findFirst({
    where: { OR: [{ id: identifier }, { username: identifier }] },
    select: { id: true, displayName: true },
  });
}

export function findDirectRoomCandidates(
  prisma: PrismaClient,
  input: { userId: string; targetUserId: string },
) {
  return prisma.room.findMany({
    where: {
      isGroup: false,
      AND: [
        { members: { some: { userId: input.userId } } },
        { members: { some: { userId: input.targetUserId } } },
      ],
    },
    include: {
      members: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

export function createDirectRoom(
  prisma: PrismaClient,
  input: { userId: string; targetUserId: string },
) {
  return prisma.room.create({
    data: {
      isGroup: false,
      members: { create: [{ userId: input.userId }, { userId: input.targetUserId }] },
    },
  });
}

export function createGroupRoom(
  prisma: PrismaClient,
  input: { name: string; memberIds: string[] },
) {
  return prisma.room.create({
    data: {
      isGroup: true,
      name: input.name,
      members: { create: input.memberIds.map((userId) => ({ userId })) },
    },
  });
}

export function findRoomForUser(
  prisma: PrismaClient,
  input: { userId: string; roomId: string },
) {
  return prisma.room.findFirst({
    where: { id: input.roomId, members: { some: { userId: input.userId } } },
    include: {
      members: { include: { user: { select: { id: true, displayName: true } } } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}

export function findRoomMembersForUser(
  prisma: PrismaClient,
  input: { userId: string; roomId: string },
) {
  return prisma.room.findFirst({
    where: { id: input.roomId, members: { some: { userId: input.userId } } },
    include: {
      members: {
        include: {
          user: { select: { id: true, username: true, email: true, displayName: true, createdAt: true } },
        },
      },
    },
  });
}

export function findMessageCursor(prisma: PrismaClient, messageId: string) {
  return prisma.message.findUnique({
    where: { id: messageId },
    select: { createdAt: true },
  });
}

export function findMessages(
  prisma: PrismaClient,
  input: { roomId: string; before?: Date; limit: number },
) {
  return prisma.message.findMany({
    where: {
      roomId: input.roomId,
      ...(input.before ? { createdAt: { lt: input.before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit,
    select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
  });
}

export function createMessageRow(
  prisma: PrismaClient,
  input: { id?: string; senderId: string; roomId: string; content: string; requestId?: string; createdAt?: Date },
) {
  return prisma.$transaction(async (tx) => {
    const [lockedRoom] = await tx.$queryRaw<Array<{ nextMessageSeq: bigint }>>`
      SELECT "nextMessageSeq"
      FROM "Room"
      WHERE "id" = ${input.roomId}
      FOR UPDATE
    `;
    if (!lockedRoom) {
      throw new Error('room not found');
    }

    await tx.room.update({
      where: { id: input.roomId },
      data: { nextMessageSeq: { increment: 1 } },
    });

    return tx.message.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        content: input.content,
        senderId: input.senderId,
        roomId: input.roomId,
        roomSequence: lockedRoom.nextMessageSeq,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
      select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
    });
  });
}

export function findMessageByRequestId(
  prisma: PrismaClient,
  input: { senderId: string; requestId: string },
) {
  return prisma.message.findFirstOrThrow({
    where: { senderId: input.senderId, requestId: input.requestId },
    select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
  });
}

export function updateLastMessageAt(prisma: PrismaClient, input: { roomId: string; lastMessageAt: Date }) {
  return prisma.$executeRaw`
    UPDATE "Room"
    SET "lastMessageAt" = GREATEST("lastMessageAt", ${input.lastMessageAt})
    WHERE "id" = ${input.roomId}
  `;
}
