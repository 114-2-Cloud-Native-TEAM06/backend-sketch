import { createHash } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Chat, CreateChatRequest, Message, User } from '../../../../../packages/shared-types/src/api-types.js';
import { AppError } from '../../../../../packages/shared-errors/src/app-error.js';
import {
  cacheMessage,
  getCachedMessage,
  publishRoomMessage,
  type RedisLike,
} from '../../../../../packages/shared-redis/src/index.js';
import {
  publishMessageWriteWithRetry,
  type MessageWriteCommand,
  type MessageWritePublisher,
} from '../../../../../packages/shared-nats/src/index.js';
import {
  createDirectRoom,
  createGroupRoom,
  createMessageRow,
  findDirectRoomCandidates,
  findMembershipsForUser,
  findMessageByRequestId,
  findMessageCursor,
  findMessages,
  findPendingMessageWrites,
  findPendingMessageWritesForRooms,
  findRoomForUser,
  findRoomMembersForUser,
  findRoomMembership,
  findUserForChatMember,
  findWriteCursor,
  updateLastMessageAt,
} from './chats.repository.js';

type MessageRow = {
  id: string;
  content: string;
  createdAt: Date;
  senderId: string;
  roomId: string;
};

type PendingMessageWriteRow = {
  id: string;
  content: string;
  acceptedAt: Date;
  senderId: string;
  roomId: string;
};

export interface CreateMessageInput {
  senderId: string;
  chatId: string;
  body: string;
  requestId?: string;
}

export interface CreateMessageDependencies {
  redis?: RedisLike;
  publisher?: RedisLike;
  originConnectionId?: string;
}

export interface CreateBufferedMessageDependencies {
  messageWritePublisher: MessageWritePublisher;
  publishAttempts?: number;
  publishRetryDelayMs?: number;
  originConnectionId?: string;
  membershipVerified?: boolean;
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

export function toPendingMessageDto(msg: PendingMessageWriteRow): Message {
  return {
    id:         msg.id,
    chat_id:    msg.roomId,
    sender_id:  msg.senderId,
    type:       'TEXT',
    body:       msg.content,
    created_at: msg.acceptedAt.toISOString(),
    delivery_status: 'sent',
  };
}

function toChatDto(room: {
  id: string;
  isGroup: boolean;
  name: string | null;
  createdAt: Date;
  members: Array<{ userId: string; user: { id: string; displayName: string } }>;
  messages: MessageRow[];
}, currentUserId: string): Chat {
  const otherMember = room.isGroup
    ? undefined
    : room.members.find((member) => member.userId !== currentUserId)?.user;
  const lastMsg = room.messages[0];

  return {
    id:           room.id,
    type:         room.isGroup ? 'group' : 'direct',
    name:         room.isGroup ? (room.name ?? 'Group Chat') : (otherMember?.displayName ?? 'Unknown'),
    member_ids:   room.members.map((member) => member.userId),
    last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
    unread_count: 0,
    created_at:   room.createdAt.toISOString(),
  };
}

function newestMessage(left: Message | undefined, right: Message | undefined): Message | undefined {
  if (!left) return right;
  if (!right) return left;
  return new Date(left.created_at).getTime() >= new Date(right.created_at).getTime() ? left : right;
}

async function attachPendingLatestMessages(
  prisma: PrismaClient,
  chats: Chat[],
): Promise<Chat[]> {
  const pendingWrites = await findPendingMessageWritesForRooms(prisma, chats.map((chat) => chat.id));
  const pendingByRoom = new Map<string, Message>();

  for (const write of pendingWrites) {
    if (pendingByRoom.has(write.roomId)) continue;
    pendingByRoom.set(write.roomId, toPendingMessageDto(write));
  }

  return chats
    .map((chat) => ({
      ...chat,
      last_message: newestMessage(chat.last_message, pendingByRoom.get(chat.id)),
    }))
    .sort((a, b) => {
      const aTime = a.last_message ? new Date(a.last_message.created_at).getTime() : new Date(a.created_at).getTime();
      const bTime = b.last_message ? new Date(b.last_message.created_at).getTime() : new Date(b.created_at).getTime();
      return bTime - aTime;
    });
}

export async function listChats(prisma: PrismaClient, userId: string): Promise<Chat[]> {
  const memberships = await findMembershipsForUser(prisma, userId);
  return attachPendingLatestMessages(prisma, memberships.map((membership) => toChatDto(membership.room, userId)));
}

export async function createChat(
  prisma: PrismaClient,
  userId: string,
  body: CreateChatRequest,
): Promise<{ status: number; body: Chat }> {
  const { type, name, member_ids } = body;

  if (!type || !member_ids || !Array.isArray(member_ids))
    throw new AppError(400, 'VALIDATION_FAILED', 'type and member_ids are required');

  if (type === 'direct') {
    if (member_ids.length !== 1)
      throw new AppError(400, 'VALIDATION_FAILED', 'direct chat requires exactly 1 member_id');

    const rawTarget = member_ids[0];
    const targetUser = await findUserForChatMember(prisma, rawTarget);
    if (!targetUser)
      throw new AppError(422, 'VALIDATION_FAILED', `member_ids[0]: user "${rawTarget}" not found`);

    if (targetUser.id === userId)
      throw new AppError(400, 'VALIDATION_FAILED', 'cannot create a direct chat with yourself');

    const candidates = await findDirectRoomCandidates(prisma, { userId, targetUserId: targetUser.id });
    const existing = candidates.find((room) => room.members.length === 2);

    if (existing) {
      const lastMsg = existing.messages[0];
      return {
        status: 200,
        body: {
          id:           existing.id,
          type:         'direct',
          name:         targetUser.displayName,
          member_ids:   existing.members.map((m) => m.userId),
          last_message: lastMsg ? toMessageDto(lastMsg) : undefined,
          unread_count: 0,
          created_at:   existing.createdAt.toISOString(),
        },
      };
    }

    const room = await createDirectRoom(prisma, { userId, targetUserId: targetUser.id });
    return {
      status: 201,
      body: {
        id:           room.id,
        type:         'direct',
        name:         targetUser.displayName,
        member_ids:   [userId, targetUser.id],
        unread_count: 0,
        created_at:   room.createdAt.toISOString(),
      },
    };
  }

  if (type === 'group') {
    if (!name)
      throw new AppError(400, 'VALIDATION_FAILED', 'group chat requires a name');
    if (!member_ids.length)
      throw new AppError(400, 'VALIDATION_FAILED', 'group chat requires at least 1 member_id');

    const resolvedMembers = await Promise.all(member_ids.map((id) => findUserForChatMember(prisma, id)));
    const badIdx = resolvedMembers.findIndex((user) => user === null);
    if (badIdx !== -1)
      throw new AppError(422, 'VALIDATION_FAILED', `member_ids[${badIdx}]: user "${member_ids[badIdx]}" not found`);

    const resolvedIds = resolvedMembers.map((user) => user!.id);
    const allIds = [...new Set([userId, ...resolvedIds])];
    const room = await createGroupRoom(prisma, { name, memberIds: allIds });

    return {
      status: 201,
      body: {
        id:           room.id,
        type:         'group',
        name:         room.name ?? name,
        member_ids:   allIds,
        unread_count: 0,
        created_at:   room.createdAt.toISOString(),
      },
    };
  }

  throw new AppError(400, 'VALIDATION_FAILED', 'type must be "direct" or "group"');
}

export async function getChat(prisma: PrismaClient, userId: string, chatId: string): Promise<Chat> {
  const room = await findRoomForUser(prisma, { userId, roomId: chatId });
  if (!room) throw new AppError(404, 'NOT_FOUND', 'Chat not found');
  const [chat] = await attachPendingLatestMessages(prisma, [toChatDto(room, userId)]);
  return chat;
}

export async function getChatMembers(prisma: PrismaClient, userId: string, chatId: string): Promise<User[]> {
  const room = await findRoomMembersForUser(prisma, { userId, roomId: chatId });
  if (!room) throw new AppError(404, 'NOT_FOUND', 'Chat not found');
  return room.members.map((member) => toUserDto(member.user));
}

export async function getMessages(
  prisma: PrismaClient,
  input: { userId: string; chatId: string; beforeMessageId?: unknown; limit?: unknown },
): Promise<Message[]> {
  const pageSize = Math.min(Number(input.limit ?? '50') || 50, 100);

  const isMember = await findRoomMembership(prisma, { userId: input.userId, roomId: input.chatId });
  if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');

  let cursorCreatedAt: Date | undefined;
  if (input.beforeMessageId && typeof input.beforeMessageId === 'string') {
    const cursorMsg = await findMessageCursor(prisma, input.beforeMessageId)
      ?? await findWriteCursor(prisma, input.beforeMessageId);
    if (cursorMsg) cursorCreatedAt = cursorMsg.createdAt;
  }

  const [messages, pendingWrites] = await Promise.all([
    findMessages(prisma, {
      roomId: input.chatId,
      before: cursorCreatedAt,
      limit: pageSize,
    }),
    findPendingMessageWrites(prisma, {
      roomId: input.chatId,
      before: cursorCreatedAt,
      limit: pageSize,
    }),
  ]);

  const merged = new Map<string, Message>();
  for (const message of messages) merged.set(message.id, toMessageDto(message));
  for (const write of pendingWrites) {
    if (!merged.has(write.id)) merged.set(write.id, toPendingMessageDto(write));
  }

  return [...merged.values()]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, pageSize);
}

export async function createMessage(
  prisma: PrismaClient,
  input: CreateMessageInput,
  deps: CreateMessageDependencies = {},
): Promise<Message> {
  const body = input.body;
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', 'body is required');
  }

  const isMember = await findRoomMembership(prisma, { userId: input.senderId, roomId: input.chatId });
  if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');

  const cached = await getCachedMessage(deps.redis, input.senderId, input.requestId);
  if (cached) return cached;

  const trimmedBody = body.trim();

  let msg: MessageRow;
  let recoveredDuplicate = false;
  try {
    msg = await createMessageRow(prisma, {
      content: trimmedBody,
      senderId: input.senderId,
      roomId: input.chatId,
      requestId: input.requestId,
    });
  } catch (err) {
    if (!input.requestId || !isUniqueRequestIdError(err)) throw err;

    msg = await findMessageByRequestId(prisma, {
      senderId: input.senderId,
      requestId: input.requestId,
    });
    recoveredDuplicate = true;
  }

  if (!recoveredDuplicate) {
    await updateLastMessageAt(prisma, {
      roomId: input.chatId,
      lastMessageAt: msg.createdAt,
    });
  }

  const dto = toMessageDto(msg);
  await cacheMessage(deps.redis, input.senderId, input.requestId, dto);
  if (!recoveredDuplicate) await publishRoomMessage(deps.publisher, dto, deps.originConnectionId);
  return dto;
}

export async function createBufferedMessage(
  prisma: PrismaClient,
  input: CreateMessageInput & { requestId: string },
  deps: CreateBufferedMessageDependencies,
): Promise<Message> {
  const body = input.body;
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', 'body is required');
  }

  if (!deps.membershipVerified) {
    const isMember = await findRoomMembership(prisma, { userId: input.senderId, roomId: input.chatId });
    if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');
  }

  const trimmedBody = body.trim();
  const acceptedAt = new Date();
  const pendingMessage: PendingMessageWriteRow = {
    id: stableMessageId(input.senderId, input.requestId),
    content: trimmedBody,
    acceptedAt,
    senderId: input.senderId,
    roomId: input.chatId,
  };

  const command: MessageWriteCommand = {
    message_id: pendingMessage.id,
    request_id: input.requestId,
    sender_id: pendingMessage.senderId,
    room_id: pendingMessage.roomId,
    body: pendingMessage.content,
    accepted_at: acceptedAt.toISOString(),
    ...(deps.originConnectionId ? { origin_connection_id: deps.originConnectionId } : {}),
  };

  try {
    await publishMessageWriteWithRetry(deps.messageWritePublisher, command, {
      attempts: deps.publishAttempts,
      delayMs: deps.publishRetryDelayMs,
    });
  } catch {
    throw new AppError(503, 'INTERNAL', 'message buffer is unavailable');
  }

  return toPendingMessageDto(pendingMessage);
}

export async function sendTyping(prisma: PrismaClient, userId: string, chatId: string): Promise<void> {
  const isMember = await findRoomMembership(prisma, { userId, roomId: chatId });
  if (!isMember) throw new AppError(403, 'FORBIDDEN', 'Not a member of this chat');
}

function isUniqueRequestIdError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function stableMessageId(senderId: string, requestId: string): string {

  const digest = createHash('sha256')
    .update(senderId)
    .update(':')
    .update(requestId)
    .digest('hex')
    .slice(0, 32);
  return `msg_${digest}`;
}
