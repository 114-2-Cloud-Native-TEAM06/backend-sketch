import express, { Express } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { parse } from 'url';
import { createAuthRouter } from './routes/auth.js';
import { createChatRouter } from './routes/chats.js';
import { createUserRouter } from './routes/users.js';

interface JwtPayload {
  userId: string;
  username: string;
}

// ─── REST server (port 8080) ─────────────────────────────────────────────────

const app: Express = express();
app.use(express.json());

const API_VERSION = process.env.API_VERSION || '1';
app.use(`/api/v${API_VERSION}/auth`, createAuthRouter());
app.use(`/api/v${API_VERSION}/chats`, createChatRouter());
app.use(`/api/v${API_VERSION}/users`, createUserRouter());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const REST_PORT = process.env.REST_PORT || 8080;
createServer(app).listen(REST_PORT, () => {
  console.log(`REST server running on port ${REST_PORT}`);
});

// ─── WebSocket server (port 8081) ────────────────────────────────────────────

const WS_PORT = process.env.WS_PORT || 8081;
const wss = new WebSocketServer({ port: Number(WS_PORT) });

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

console.log(`WebSocket server running on port ${WS_PORT}`);
