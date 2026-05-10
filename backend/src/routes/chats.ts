import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../middleware/auth.js';
import type { Chat, Message, User, ApiError, CreateChatRequest } from '../types/api-types.js';

const router = Router();
const prisma = new PrismaClient();

function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

function toMessageDto(msg: {
  id: string;
  content: string;
  createdAt: Date;
  senderId: string;
  roomId: string;
}): Message {
  return {
    id:         msg.id,
    chat_id:    msg.roomId,
    sender_id:  msg.senderId,
    type:       'TEXT',
    body:       msg.content,
    created_at: msg.createdAt.toISOString(),
  };
}

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

// GET /api/v1/chats  — 我的 chat 列表，按最後訊息時間排序
router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  try {
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
        last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
        unread_count: 0,
      };
    });

    res.json(chats);
  } catch (err) {
    console.error('[GET /chats]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// POST /api/v1/chats  — 建立 direct 或 group chat
router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const { type, name, member_ids } = req.body as CreateChatRequest;

  if (!type || !member_ids || !Array.isArray(member_ids)) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'type and member_ids are required'));
    return;
  }

  try {
    if (type === 'direct') {
      if (member_ids.length !== 1) {
        res.status(400).json(apiError('VALIDATION_FAILED', 'direct chat requires exactly 1 member_id'));
        return;
      }
      const targetId = member_ids[0];
      if (targetId === userId) {
        res.status(400).json(apiError('VALIDATION_FAILED', 'cannot create a direct chat with yourself'));
        return;
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, displayName: true },
      });
      if (!targetUser) {
        res.status(404).json(apiError('NOT_FOUND', 'User not found'));
        return;
      }

      // 找已存在的 1-1 聊天室（兩人都是成員且只有兩個成員）
      const candidates = await prisma.room.findMany({
        where: {
          isGroup: false,
          AND: [
            { members: { some: { userId } } },
            { members: { some: { userId: targetId } } },
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
          last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
          unread_count: 0,
        } satisfies Chat);
        return;
      }

      const room = await prisma.room.create({
        data: {
          isGroup: false,
          members: { create: [{ userId }, { userId: targetId }] },
        },
      });

      res.status(201).json({
        id:           room.id,
        type:         'direct',
        name:         targetUser.displayName,
        unread_count: 0,
      } satisfies Chat);
      return;
    }

    if (type === 'group') {
      if (!name) {
        res.status(400).json(apiError('VALIDATION_FAILED', 'group chat requires a name'));
        return;
      }
      if (!member_ids.length) {
        res.status(400).json(apiError('VALIDATION_FAILED', 'group chat requires at least 1 member_id'));
        return;
      }

      const allIds = [...new Set([userId, ...member_ids])];
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
        unread_count: 0,
      } satisfies Chat);
      return;
    }

    res.status(400).json(apiError('VALIDATION_FAILED', 'type must be "direct" or "group"'));
  } catch (err) {
    console.error('[POST /chats]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// GET /api/v1/chats/:chatId
router.get('/:chatId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId  = req.user!.userId;
  const { chatId } = req.params;

  try {
    const room = await prisma.room.findFirst({
      where: { id: chatId, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, displayName: true } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!room) {
      res.status(404).json(apiError('NOT_FOUND', 'Chat not found'));
      return;
    }

    const otherMember = room.isGroup
      ? undefined
      : room.members.find((m) => m.userId !== userId)?.user;
    const lastMsg = room.messages[0];

    res.json({
      id:           room.id,
      type:         room.isGroup ? 'group' : 'direct',
      name:         room.isGroup ? (room.name ?? 'Group Chat') : (otherMember?.displayName ?? 'Unknown'),
      last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
      unread_count: 0,
    } satisfies Chat);
  } catch (err) {
    console.error('[GET /chats/:id]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// GET /api/v1/chats/:chatId/members
router.get('/:chatId/members', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId  = req.user!.userId;
  const { chatId } = req.params;

  try {
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

    if (!room) {
      res.status(404).json(apiError('NOT_FOUND', 'Chat not found'));
      return;
    }

    res.json(room.members.map((m) => toUserDto(m.user)));
  } catch (err) {
    console.error('[GET /chats/:id/members]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// GET /api/v1/chats/:chatId/messages?before_message_id=&limit=50
// 回傳舊→新倒序（最新在前），前端 prepend 到頂部
router.get('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId  = req.user!.userId;
  const { chatId } = req.params;
  const { before_message_id, limit = '50' } = req.query;

  const pageSize = Math.min(Number(limit) || 50, 100);

  try {
    const isMember = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId, roomId: chatId } },
    });
    if (!isMember) {
      res.status(403).json(apiError('FORBIDDEN', 'Not a member of this chat'));
      return;
    }

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
  } catch (err) {
    console.error('[GET /chats/:id/messages]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// POST /api/v1/chats/:chatId/messages
router.post('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId  = req.user!.userId;
  const { chatId } = req.params;
  const { body } = req.body;

  if (!body || typeof body !== 'string' || !body.trim()) {
    res.status(400).json(apiError('VALIDATION_FAILED', 'body is required'));
    return;
  }

  try {
    const isMember = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId, roomId: chatId } },
    });
    if (!isMember) {
      res.status(403).json(apiError('FORBIDDEN', 'Not a member of this chat'));
      return;
    }

    const msg = await prisma.message.create({
      data: { content: body.trim(), senderId: userId, roomId: chatId },
      select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
    });

    await prisma.room.update({
      where: { id: chatId },
      data: { lastMessageAt: msg.createdAt },
    });

    res.status(201).json(toMessageDto(msg));
  } catch (err) {
    console.error('[POST /chats/:id/messages]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

// POST /api/v1/chats/:chatId/typing  — 204 No Content（WebSocket 廣播留後端 TODO）
router.post('/:chatId/typing', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId  = req.user!.userId;
  const { chatId } = req.params;

  try {
    const isMember = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId, roomId: chatId } },
    });
    if (!isMember) {
      res.status(403).json(apiError('FORBIDDEN', 'Not a member of this chat'));
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('[POST /chats/:id/typing]', err);
    res.status(500).json(apiError('INTERNAL', 'Internal server error'));
  }
});

export default router;
