import 'express-async-errors';
import express, { Express } from 'express';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath, parse } from 'url';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter } from './routes/chats.js';
import { createUserRouter } from './routes/users.js';
import { AppError, errorMiddleware } from './utils/errHandler.js';
import { createMessage } from './services/messageService.js';
import type { WsErrorReason, WsServerFrame } from './types/api-types.js';

interface JwtPayload {
  userId: string;
  username: string;
}

interface ClientState {
  ws: WebSocket;
  user: JwtPayload;
  roomIds: Set<string>;
}

type RawFrame = Record<string, unknown> & { type?: unknown };

// ─── REST server (port 8080) ─────────────────────────────────────────────────

export function createRestApp(): Express {
  const app: Express = express();
  app.use(express.json());

  const API_VERSION = process.env.API_VERSION || '1';
  app.use(`/api/v${API_VERSION}/auth`, createAuthRouter());
  app.use(`/api/v${API_VERSION}/chats`, createChatRouter());
  app.use(`/api/v${API_VERSION}/users`, createUserRouter());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(errorMiddleware);

  return app;
}

export function startRestServer(port = Number(process.env.REST_PORT || 8080)): Server {
  const server = createServer(createRestApp());
  server.listen(port, () => {
    console.log(`REST server running on port ${port}`);
  });
  return server;
}

// ─── WebSocket server (port 8081) ────────────────────────────────────────────

export function createWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma: PrismaClient = new PrismaClient(),
): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const roomSockets = new Map<string, Set<WebSocket>>();
  const clientStates = new Map<WebSocket, ClientState>();

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

  const addSocketToRoom = (state: ClientState, roomId: string): void => {
    state.roomIds.add(roomId);
    const sockets = roomSockets.get(roomId) ?? new Set<WebSocket>();
    sockets.add(state.ws);
    roomSockets.set(roomId, sockets);
  };

  const removeSocketFromRooms = (state: ClientState): void => {
    for (const roomId of state.roomIds) {
      const sockets = roomSockets.get(roomId);
      if (!sockets) continue;
      sockets.delete(state.ws);
      if (!sockets.size) roomSockets.delete(roomId);
    }
  };

  const hasOpenSocketForUser = (userId: string): boolean => {
    for (const state of clientStates.values()) {
      if (state.user.userId === userId && state.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  };

  const broadcastToRoom = (roomId: string, frame: WsServerFrame): void => {
    const sockets = roomSockets.get(roomId);
    if (!sockets) return;
    for (const ws of sockets) sendJson(ws, frame);
  };

  const broadcastPresence = (state: ClientState, online: boolean): void => {
    const recipients = new Set<WebSocket>();
    for (const roomId of state.roomIds) {
      const sockets = roomSockets.get(roomId);
      if (!sockets) continue;
      for (const socket of sockets) {
        const recipient = clientStates.get(socket);
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

    addSocketToRoom(state, roomId);
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
      const message = await createMessage(prisma, {
        senderId: state.user.userId,
        chatId: frame.chat_id,
        body: frame.body,
        requestId: frame.request_id,
      });
      addSocketToRoom(state, frame.chat_id);
      sendJson(state.ws, {
        type: 'ack',
        request_id: frame.request_id,
        message_id: message.id,
        persisted_at: message.created_at,
      });
      broadcastToRoom(frame.chat_id, { type: 'msg', message });
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

    broadcastToRoom(frame.chat_id, {
      type: 'typing',
      chat_id: frame.chat_id,
      user_id: state.user.userId,
      is_typing: frame.is_typing,
    });
  };

  wss.on('connection', (ws: WebSocket, req) => {
    // Extract JWT from query string: ws://host:8081/ws/chat?token=...
    const { query } = parse(req.url ?? '', true);
    const token = Array.isArray(query.token) ? query.token[0] : query.token;

    if (!token) {
      ws.close(1008, 'auth_expired');
      return;
    }

    let user: JwtPayload;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    } catch {
      ws.close(1008, 'auth_expired');
      return;
    }

    const state: ClientState = { ws, user, roomIds: new Set() };
    const wasOnline = hasOpenSocketForUser(user.userId);
    clientStates.set(ws, state);

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
      removeSocketFromRooms(state);
      clientStates.delete(ws);
      if (!hasOpenSocketForUser(user.userId)) broadcastPresence(state, false);
      // console.log('ws disconnected:', user.userId);
    });

    void (async () => {
      const memberships = await prisma.roomMember.findMany({
        where: { userId: user.userId },
        select: { roomId: true },
      });
      if (ws.readyState !== WebSocket.OPEN || clientStates.get(ws) !== state) return;
      for (const membership of memberships) addSocketToRoom(state, membership.roomId);

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

function mapAppErrorToWsReason(err: AppError): WsErrorReason {
  if (err.code === 'FORBIDDEN') return 'forbidden';
  if (err.code === 'AUTH_REQUIRED') return 'auth_expired';
  return 'validation_failed';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRestServer();
  startWebSocketServer();
}
