import { Prisma, PrismaClient } from '@prisma/client';
import type { Message } from '../types/api-types.js';
import { AppError } from '../utils/errHandler.js';

type MessageRow = {
  id: string;
  content: string;
  createdAt: Date;
  senderId: string;
  roomId: string;
};

export function toMessageDto(msg: MessageRow): Message {
  return {
    id:         msg.id,
    chat_id:    msg.roomId,
    sender_id:  msg.senderId,
    type:       'TEXT',
    body:       msg.content,
    created_at: msg.createdAt.toISOString(),
  };
}

export interface CreateMessageInput {
  senderId: string;
  chatId: string;
  body: string;
  requestId?: string;
}

export async function createMessage(
  prisma: PrismaClient,
  input: CreateMessageInput,
): Promise<Message> {
  const body = input.body;
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', 'body is required');
  }

  const isMember = await prisma.roomMember.findUnique({
    where: { userId_roomId: { userId: input.senderId, roomId: input.chatId } },
  });
  if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');

  const trimmedBody = body.trim();
  const data = {
    content: trimmedBody,
    senderId: input.senderId,
    roomId: input.chatId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };

  let msg: MessageRow;
  try {
    msg = await prisma.message.create({
      data,
      select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
    });
  } catch (err) {
    if (!input.requestId || !isUniqueRequestIdError(err)) throw err;

    msg = await prisma.message.findFirstOrThrow({
      where: { senderId: input.senderId, requestId: input.requestId },
      select: { id: true, content: true, createdAt: true, senderId: true, roomId: true },
    });
  }

  await prisma.room.update({
    where: { id: input.chatId },
    data: { lastMessageAt: msg.createdAt },
  });

  return toMessageDto(msg);
}

function isUniqueRequestIdError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
