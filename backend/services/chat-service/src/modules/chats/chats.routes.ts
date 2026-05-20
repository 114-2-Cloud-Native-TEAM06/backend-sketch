import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authMiddleware from '../../../../../packages/shared-auth/src/auth-middleware.js';
import type { CreateChatRequest } from '../../../../../packages/shared-types/src/api-types.js';
import {
  createChat,
  createMessage,
  getChat,
  getChatMembers,
  getMessages,
  listChats,
  sendTyping,
} from './chats.service.js';

export function createChatRouter(prisma: PrismaClient = new PrismaClient()): Router {
  const router = Router();

  router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const chats = await listChats(prisma, req.user!.userId);
    res.json(chats);
  });

  router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const result = await createChat(prisma, req.user!.userId, req.body as CreateChatRequest);
    res.status(result.status).json(result.body);
  });

  router.get('/:chatId', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const chat = await getChat(prisma, req.user!.userId, req.params.chatId);
    res.json(chat);
  });

  router.get('/:chatId/members', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const members = await getChatMembers(prisma, req.user!.userId, req.params.chatId);
    res.json(members);
  });

  router.get('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const messages = await getMessages(prisma, {
      userId: req.user!.userId,
      chatId: req.params.chatId,
      beforeMessageId: req.query.before_message_id,
      limit: req.query.limit,
    });
    res.json(messages);
  });

  router.post('/:chatId/messages', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const msg = await createMessage(prisma, {
      senderId: req.user!.userId,
      chatId: req.params.chatId,
      body: req.body.body,
      requestId: req.body.request_id,
    });
    res.status(201).json(msg);
  });

  router.post('/:chatId/typing', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    await sendTyping(prisma, req.user!.userId, req.params.chatId);
    res.status(204).send();
  });

  return router;
}
