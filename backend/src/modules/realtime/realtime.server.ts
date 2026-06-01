import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { parse } from 'url';
import { JSONCodec } from 'nats';
import { ulid } from 'ulid';
import { AppError } from '../shared/errors/app-error.js';
import { verifyToken } from '../shared/auth/jwt.js';
import { createMessage } from '../chats/chats.service.js';
import type { WsErrorReason, WsServerFrame } from '../shared/types/api-types.js';
import {
  getNatsConnection,
  isNatsEnabled,
  publishAcceptedMessage,
} from '../messaging/nats-client.js';
import {
  MESSAGE_FAILED_SUBJECT,
  MESSAGE_PERSISTED_SUBJECT,
  type ChatMessageFailedEvent,
  type ChatMessagePersistedEvent,
} from '../messaging/message-events.js';
import { InMemoryPresenceStore } from './realtime.service.js';
import type { ClientState, JwtPayload, PresenceStore } from './realtime.types.js';

type RawFrame = Record<string, unknown> & { type?: unknown };

export function createWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma: PrismaClient = new PrismaClient(),
  presenceStore: PresenceStore = new InMemoryPresenceStore(),
): WebSocketServer {
  const wss = new WebSocketServer({ port });
  if (isNatsEnabled()) startMessageStatusFanout(presenceStore);

  const sendJson = (ws: WebSocket, frame: WsServerFrame): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Ignore per-socket send failures; close cleanup removes dead sockets.
    }
  };

  const sendError = (ws: WebSocket, reason: WsErrorReason, detail?: string): void => {
    sendJson(ws, { type: 'error', reason, ...(detail ? { detail } : {}) });
  };

  const broadcastPresence = (state: ClientState, online: boolean): void => {
    const recipients = new Set<WebSocket>();
    for (const roomId of state.roomIds) {
      const sockets = presenceStore.getRoomSockets(roomId);
      if (!sockets) continue;
      for (const socket of sockets) {
        const recipient = presenceStore.getClientState(socket);
        if (!recipient || recipient.user.userId === state.user.userId) continue;
        recipients.add(socket);
      }
    }

    for (const socket of recipients) {
      sendJson(socket, { type: 'presence', user_id: state.user.userId, online });
    }
  };

  const ensureRoomIndexed = async (state: ClientState, roomId: string): Promise<boolean> => {
    if (state.roomIds.has(roomId)) return true;

    const membership = await prisma.roomMember.findUnique({
      where: { userId_roomId: { userId: state.user.userId, roomId } },
    });
    if (!membership) return false;

    presenceStore.addSocketToRoom(state, roomId);
    return true;
  };

  const handleSend = async (state: ClientState, frame: RawFrame): Promise<void> => {
    if (typeof frame.request_id !== 'string' || !frame.request_id) {
      sendError(state.ws, 'validation_failed', 'request_id is required');
      return;
    }
    if (typeof frame.chat_id !== 'string' || !frame.chat_id) {
      sendError(state.ws, 'validation_failed', 'chat_id is required');
      return;
    }
    if (typeof frame.body !== 'string' || !frame.body.trim()) {
      sendError(state.ws, 'validation_failed', 'body is required');
      return;
    }

    try {
      if (isNatsEnabled()) {
        if (!await ensureRoomIndexed(state, frame.chat_id)) {
          sendError(state.ws, 'forbidden', 'Not a member of this chat');
          return;
        }

        const acceptedAt = new Date().toISOString();
        const messageId = ulid();
        const body = frame.body.trim();

        await publishAcceptedMessage({
          event_version: 1,
          message_id: messageId,
          request_id: frame.request_id,
          room_id: frame.chat_id,
          sender_id: state.user.userId,
          body,
          accepted_at: acceptedAt,
        });

        sendJson(state.ws, {
          type: 'ack',
          request_id: frame.request_id,
          message_id: messageId,
          accepted_at: acceptedAt,
          status: 'accepted',
        });
        presenceStore.broadcastToRoom(frame.chat_id, {
          type: 'msg',
          message: {
            id: messageId,
            chat_id: frame.chat_id,
            sender_id: state.user.userId,
            type: 'TEXT',
            body,
            created_at: acceptedAt,
          },
        });
        return;
      }

      const message = await createMessage(prisma, {
        senderId: state.user.userId,
        chatId: frame.chat_id,
        body: frame.body,
        requestId: frame.request_id,
      });
      presenceStore.addSocketToRoom(state, frame.chat_id);
      sendJson(state.ws, {
        type: 'ack',
        request_id: frame.request_id,
        message_id: message.id,
        persisted_at: message.created_at,
      });
      presenceStore.broadcastToRoom(frame.chat_id, { type: 'msg', message });
    } catch (err) {
      if (err instanceof AppError) {
        sendError(state.ws, mapAppErrorToWsReason(err), err.message);
        return;
      }
      console.error('ws send failed:', err);
      sendError(state.ws, 'validation_failed', 'message could not be sent');
    }
  };

  const handleTyping = async (state: ClientState, frame: RawFrame): Promise<void> => {
    if (typeof frame.chat_id !== 'string' || !frame.chat_id) {
      sendError(state.ws, 'validation_failed', 'chat_id is required');
      return;
    }
    if (typeof frame.is_typing !== 'boolean') {
      sendError(state.ws, 'validation_failed', 'is_typing is required');
      return;
    }

    if (!await ensureRoomIndexed(state, frame.chat_id)) {
      sendError(state.ws, 'forbidden', 'Not a member of this chat');
      return;
    }

    presenceStore.broadcastToRoom(frame.chat_id, {
      type: 'typing',
      chat_id: frame.chat_id,
      user_id: state.user.userId,
      is_typing: frame.is_typing,
    });
  };

  wss.on('connection', (ws: WebSocket, req) => {
    const { query } = parse(req.url ?? '', true);
    const token = Array.isArray(query.token) ? query.token[0] : query.token;

    if (!token) {
      ws.close(1008, 'auth_expired');
      return;
    }

    let user: JwtPayload;
    try {
      user = verifyToken(token);
    } catch {
      ws.close(1008, 'auth_expired');
      return;
    }

    const state: ClientState = { ws, user, roomIds: new Set() };
    const wasOnline = presenceStore.hasOpenSocketForUser(user.userId);
    presenceStore.addClient(state);

    ws.on('message', (data) => {
      let frame: RawFrame;
      try {
        frame = JSON.parse(data.toString()) as RawFrame;
      } catch {
        return;
      }

      if (frame.type === 'ping') {
        sendJson(ws, { type: 'pong' });
        return;
      }

      if (frame.type === 'send') {
        void handleSend(state, frame);
        return;
      }

      if (frame.type === 'typing') {
        void handleTyping(state, frame);
        return;
      }

      sendError(ws, 'unknown_op', 'Unknown frame type');
    });

    ws.on('close', () => {
      const closedState = presenceStore.removeClient(ws);
      if (closedState && !presenceStore.hasOpenSocketForUser(user.userId)) {
        broadcastPresence(closedState, false);
      }
    });

    void (async () => {
      const memberships = await prisma.roomMember.findMany({
        where: { userId: user.userId },
        select: { roomId: true },
      });
      if (ws.readyState !== WebSocket.OPEN || presenceStore.getClientState(ws) !== state) return;
      for (const membership of memberships) presenceStore.addSocketToRoom(state, membership.roomId);

      // Send presence:true for every already-online user visible in shared rooms
      const onlineUserIds = new Set<string>();
      for (const roomId of state.roomIds) {
        const sockets = presenceStore.getRoomSockets(roomId);
        if (!sockets) continue;
        for (const socket of sockets) {
          const recipient = presenceStore.getClientState(socket);
          if (recipient && recipient.user.userId !== user.userId) {
            onlineUserIds.add(recipient.user.userId);
          }
        }
      }
      for (const onlineUserId of onlineUserIds) {
        sendJson(ws, { type: 'presence', user_id: onlineUserId, online: true });
      }

      // console.log('ws connected:', user.userId);
      if (!wasOnline) broadcastPresence(state, true);
    })().catch((err) => {
      console.error('ws connection setup failed:', err);
      ws.close(1011, 'internal_error');
    });
  });

  return wss;
}

export function startWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma?: PrismaClient,
): WebSocketServer {
  const wss = createWebSocketServer(port, prisma);
  console.log(`WebSocket server running on port ${port}`);
  return wss;
}

function startMessageStatusFanout(presenceStore: PresenceStore): void {
  const jc = JSONCodec<ChatMessagePersistedEvent | ChatMessageFailedEvent>();

  void (async () => {
    const nc = await getNatsConnection();

    const persistedSub = nc.subscribe(`${MESSAGE_PERSISTED_SUBJECT}.*`);
    const failedSub = nc.subscribe(`${MESSAGE_FAILED_SUBJECT}.*`);

    console.log('NATS message status fanout started.');

    void (async () => {
      for await (const msg of persistedSub) {
        const event = jc.decode(msg.data) as ChatMessagePersistedEvent;
        presenceStore.broadcastToRoom(event.room_id, {
          type: 'message_status',
          request_id: event.request_id,
          message_id: event.message_id,
          chat_id: event.room_id,
          status: 'persisted',
          persisted_at: event.persisted_at,
        });
      }
    })();

    void (async () => {
      for await (const msg of failedSub) {
        const event = jc.decode(msg.data) as ChatMessageFailedEvent;
        presenceStore.broadcastToRoom(event.room_id, {
          type: 'message_status',
          request_id: event.request_id,
          message_id: event.message_id,
          chat_id: event.room_id,
          status: 'failed',
          reason: event.reason,
        });
      }
    })();
  })().catch((err) => {
    console.error('NATS message status fanout failed to start:', err);
  });
}

function mapAppErrorToWsReason(err: AppError): WsErrorReason {
  if (err.code === 'FORBIDDEN') return 'forbidden';
  if (err.code === 'AUTH_REQUIRED') return 'auth_expired';
  return 'validation_failed';
}
