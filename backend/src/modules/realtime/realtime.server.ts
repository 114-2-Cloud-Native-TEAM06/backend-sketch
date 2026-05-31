import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { parse } from 'url';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { AppError } from '../shared/errors/app-error.js';
import { verifyToken } from '../shared/auth/jwt.js';
import { createMessage } from '../chats/chats.service.js';
import type { WsErrorReason, WsServerFrame } from '../shared/types/api-types.js';
import { createPrismaClient } from '../shared/db/prisma.js';
import { logger } from '../shared/observability/logger.js';
import {
  messageFanoutDuration,
  messagesSentTotal,
  observeActiveConnections,
  wsErrorsTotal,
} from '../shared/observability/metrics.js';
import { InMemoryPresenceStore } from './realtime.service.js';
import type { ClientState, JwtPayload, PresenceStore } from './realtime.types.js';

const tracer = trace.getTracer('im-backend');

type RawFrame = Record<string, unknown> & { type?: unknown };

export function createWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma: PrismaClient = createPrismaClient(),
  presenceStore: PresenceStore = new InMemoryPresenceStore(),
): WebSocketServer {
  const wss = new WebSocketServer({ port });

  // Expose live connection count as an observable gauge (cheap O(1) read).
  // Dispose on server close so callbacks don't pile up across lifecycles.
  const disposeActiveConnections = observeActiveConnections(() => presenceStore.activeConnections);
  wss.on('close', () => disposeActiveConnections());

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

  const handleSend = (state: ClientState, frame: RawFrame): Promise<void> =>
    tracer.startActiveSpan('im.message.receive', async (span) => {
      try {
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

        // Attributes must never carry the message body or the auth token.
        span.setAttribute('im.chat_id', frame.chat_id);
        span.setAttribute('im.sender_id', state.user.userId);

        try {
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

          const fanoutStart = performance.now();
          presenceStore.broadcastToRoom(frame.chat_id, { type: 'msg', message });
          // No chat_id label: room IDs are unbounded and would explode metric cardinality.
          // The chat_id lives on the span instead.
          messageFanoutDuration.record(performance.now() - fanoutStart);
          messagesSentTotal.add(1);
        } catch (err) {
          if (err instanceof AppError) {
            wsErrorsTotal.add(1, { reason: mapAppErrorToWsReason(err) });
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            sendError(state.ws, mapAppErrorToWsReason(err), err.message);
            return;
          }
          wsErrorsTotal.add(1, { reason: 'internal_error' });
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.error({ err }, 'ws send failed');
          sendError(state.ws, 'validation_failed', 'message could not be sent');
        }
      } finally {
        span.end();
      }
    });

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

      if (!wasOnline) broadcastPresence(state, true);
    })().catch((err) => {
      wsErrorsTotal.add(1, { reason: 'connection_setup' });
      logger.error({ err }, 'ws connection setup failed');
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
  logger.info({ port }, 'WebSocket server running');
  return wss;
}

function mapAppErrorToWsReason(err: AppError): WsErrorReason {
  if (err.code === 'FORBIDDEN') return 'forbidden';
  if (err.code === 'AUTH_REQUIRED') return 'auth_expired';
  return 'validation_failed';
}
