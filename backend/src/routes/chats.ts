import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../middleware/auth.js';
import type { Chat, User, CreateChatRequest } from '../types/api-types.js';
import { AppError } from '../utils/errHandler.js';
import { createMessage, toMessageDto } from '../services/messageService.js';

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

// Accepts either a DB id (cuid/uuid) or a username — returns null if not found.
async function resolveUser(prisma: PrismaClient, identifier: string) {
  return prisma.user.findFirst({
    where: { OR: [{ id: identifier }, { username: identifier }] },
    select: { id: true, displayName: true },
  });
}

export function createChatRouter(prisma: PrismaClient = new PrismaClient()): Router {
  const router = Router();

  // GET /api/v1/chats  — 我的 chat 列表，按最後訊息時間排序
  router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;

    const memberships = await prisma.roomMember.findMany({
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

    const chats: Chat[] = memberships.map((m) => {
      const room = m.room;
      const otherMember = room.isGroup
        ? undefined
        : room.members.find((rm) => rm.userId !== userId)?.user;
      const lastMsg = room.messages[0];

      return {
        id:           room.id,
        type:         room.isGroup ? 'group' : 'direct',
        name:         room.isGroup ? (room.name ?? 'Group Chat') : (otherMember?.displayName ?? 'Unknown'),
        member_ids:   room.members.map((rm) => rm.userId),
        last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
        unread_count: 0,
        created_at:   room.createdAt.toISOString(),
      };
    });

    res.json(chats);
  });

  // POST /api/v1/chats  — 建立 direct 或 group chat
  router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const { type, name, member_ids } = req.body as CreateChatRequest;

    if (!type || !member_ids || !Array.isArray(member_ids))
      throw new AppError(400, 'VALIDATION_FAILED', 'type and member_ids are required');

    if (type === 'direct') {
      if (member_ids.length !== 1)
        throw new AppError(400, 'VALIDATION_FAILED', 'direct chat requires exactly 1 member_id');

      const rawTarget = member_ids[0];
      const targetUser = await resolveUser(prisma, rawTarget);
      if (!targetUser)
        throw new AppError(422, 'VALIDATION_FAILED', `member_ids[0]: user "${rawTarget}" not found`);

      if (targetUser.id === userId)
        throw new AppError(400, 'VALIDATION_FAILED', 'cannot create a direct chat with yourself');

      // 找已存在的 1-1 聊天室（兩人都是成員且只有兩個成員）
      const candidates = await prisma.room.findMany({
        where: {
          isGroup: false,
          AND: [
            { members: { some: { userId } } },
            { members: { some: { userId: targetUser.id } } },
          ],
        },
        include: {
          members: true,
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      const existing = candidates.find((r) => r.members.length === 2);

      if (existing) {
        const lastMsg = existing.messages[0];
        res.json({
          id:           existing.id,
          type:         'direct',
          name:         targetUser.displayName,
          member_ids:   existing.members.map((m) => m.userId),
          last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
          unread_count: 0,
          created_at:   existing.createdAt.toISOString(),
        } satisfies Chat);
        return;
      }

      const room = await prisma.room.create({
        data: {
          isGroup: false,
          members: { create: [{ userId }, { userId: targetUser.id }] },
        },
      });

      res.status(201).json({
        id:           room.id,
        type:         'direct',
        name:         targetUser.displayName,
        member_ids:   [userId, targetUser.id],
        unread_count: 0,
        created_at:   room.createdAt.toISOString(),
      } satisfies Chat);
      return;
    }

    if (type === 'group') {
      if (!name)
        throw new AppError(400, 'VALIDATION_FAILED', 'group chat requires a name');
      if (!member_ids.length)
        throw new AppError(400, 'VALIDATION_FAILED', 'group chat requires at least 1 member_id');

      const resolvedMembers = await Promise.all(member_ids.map((id) => resolveUser(prisma, id)));
      const badIdx = resolvedMembers.findIndex((u) => u === null);
      if (badIdx !== -1)
        throw new AppError(422, 'VALIDATION_FAILED', `member_ids[${badIdx}]: user "${member_ids[badIdx]}" not found`);

      const resolvedIds = resolvedMembers.map((u) => u!.id);
      const allIds = [...new Set([userId, ...resolvedIds])];
      const room = await prisma.room.create({
        data: {
          isGroup: true,
          name,
          members: { create: allIds.map((id) => ({ userId: id })) },
        },
      });

      res.status(201).json({
        id:           room.id,
        type:         'group',
        name:         room.name ?? name,
        member_ids:   allIds,
        unread_count: 0,
        created_at:   room.createdAt.toISOString(),
      } satisfies Chat);
      return;
    }

    throw new AppError(400, 'VALIDATION_FAILED', 'type must be "direct" or "group"');
  });

  // GET /api/v1/chats/:chatId
  router.get('/:chatId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId  = req.user!.userId;
    const { chatId } = req.params;

    const room = await prisma.room.findFirst({
      where: { id: chatId, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, displayName: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!room) throw new AppError(404, 'NOT_FOUND', 'Chat not found');

    const otherMember = room.isGroup
      ? undefined
      : room.members.find((m) => m.userId !== userId)?.user;
    const lastMsg = room.messages[0];

    res.json({
      id:           room.id,
      type:         room.isGroup ? 'group' : 'direct',
      name:         room.isGroup ? (room.name ?? 'Group Chat') : (otherMember?.displayName ?? 'Unknown'),
      member_ids:   room.members.map((m) => m.userId),
      last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
      unread_count: 0,
      created_at:   room.createdAt.toISOString(),
    } satisfies Chat);
  });

  // GET /api/v1/chats/:chatId/members
  router.get('/:chatId/members', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId  = req.user!.userId;
    const { chatId } = req.params;

    const room = await prisma.room.findFirst({
      where: { id: chatId, members: { some: { userId } } },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, email: true, displayName: true, createdAt: true } },
          },
        },
      },
    });

    if (!room) throw new AppError(404, 'NOT_FOUND', 'Chat not found');

    res.json(room.members.map((m) => toUserDto(m.user)));
  });

  // GET /api/v1/chats/:chatId/messages?before_message_id=&limit=50
  // 回傳舊→新倒序（最新在前），前端 prepend 到頂部
  router.get('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId  = req.user!.userId;
    const { chatId } = req.params;
    const { before_message_id, limit = '50' } = req.query;

    const pageSize = Math.min(Number(limit) || 50, 100);

    const isMember = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId, roomId: chatId } },
    });
    if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');

    // cursor 分頁：找到游標訊息的 createdAt，拿比它更早的
    let cursorCreatedAt: Date | undefined;
    if (before_message_id && typeof before_message_id === 'string') {
      const cursorMsg = await prisma.message.findUnique({
        where: { id: before_message_id },
        select: { createdAt: true },
      });
      if (cursorMsg) cursorCreatedAt = cursorMsg.createdAt;
    }

    const messages = await prisma.message.findMany({
      where: {
        roomId: chatId,
        ...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
    });

    res.json(messages.map(toMessageDto));
  });

  // POST /api/v1/chats/:chatId/messages
  router.post('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId  = req.user!.userId;
    const { chatId } = req.params;
    const { body } = req.body;

    const msg = await createMessage(prisma, { senderId: userId, chatId, body });
    res.status(201).json(msg);
  });

  // POST /api/v1/chats/:chatId/typing  — 204 No Content（WebSocket 廣播留後端 TODO）
  router.post('/:chatId/typing', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const userId  = req.user!.userId;
    const { chatId } = req.params;

    const isMember = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId, roomId: chatId } },
    });
    if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');

    res.status(204).send();
  });

  return router;
}
