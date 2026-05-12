import 'express-async-errors';
import express, { Express } from 'express';
import { createServer, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { fileURLToPath, parse } from 'url';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter } from './routes/chats.js';
import { createUserRouter } from './routes/users.js';
import { errorMiddleware } from './utils/errHandler.js';

interface JwtPayload {
  userId: string;
  username: string;
}

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

export function createWebSocketServer(port = Number(process.env.WS_PORT || 8081)): WebSocketServer {
  const wss = new WebSocketServer({ port });

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

    console.log('ws connected:', user.userId);

    ws.on('message', (data) => {
      let frame: { type: string };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (frame.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
    });

    ws.on('close', () => {
      console.log('ws disconnected:', user.userId);
    });
  });

  return wss;
}

export function startWebSocketServer(port = Number(process.env.WS_PORT || 8081)): WebSocketServer {
  const wss = createWebSocketServer(port);
  console.log(`WebSocket server running on port ${port}`);
  return wss;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRestServer();
  startWebSocketServer();
}
