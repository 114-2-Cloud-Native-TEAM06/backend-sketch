import { WebSocketServer, WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { parse } from 'url';
import { AppError } from '../../../../../packages/shared-errors/src/app-error.js';
import { verifyToken } from '../../../../../packages/shared-auth/src/jwt.js';
import { createBufferedMessage } from '../../../../../services/chat-service/src/modules/chats/chats.service.js';
import type { WsErrorReason, WsServerFrame } from '../../../../../packages/shared-types/src/api-types.js';
import {
  createConnectionId,
  isUserOnline,
  parsePresenceEvent,
  parseRoomEvent,
  PRESENCE_CHANNEL,
  refreshPresence,
  registerPresence,
  ROOM_EVENT_PATTERN,
  unregisterPresence,
  type RedisLike,
} from '../../../../../packages/shared-redis/src/index.js';
import type { MessageWritePublisher } from '../../../../../packages/shared-nats/src/index.js';
import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
} from '../../../../../packages/shared-observability/src/metrics.js';
import { InMemoryPresenceStore } from './realtime.service.js';
import type { ClientState, JwtPayload, PresenceStore } from './realtime.types.js';
import { createRealtimeRateLimiter, type RealtimeRateLimitMode } from './realtime-rate-limit.js';

type RawFrame = Record<string, unknown> & { type?: unknown };

type LatencySnapshot = {
  count: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
};

export interface RealtimeRedisDependencies {
  redis?: RedisLike;
  publisher?: RedisLike;
  subscriber?: RedisLike;
  messageWritePublisher?: MessageWritePublisher;
}

export function createWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma: PrismaClient = new PrismaClient(),
  presenceStore: PresenceStore = new InMemoryPresenceStore(),
  redisDeps: RealtimeRedisDependencies = {},
): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const preloadRoomsOnConnect = process.env.WS_PRELOAD_ROOMS !== 'false';
  const sendBufferLimitBytes = Number(process.env.WS_SEND_BUFFER_LIMIT_BYTES || 1024 * 1024);
  const rateLimiter = createRealtimeRateLimiter(redisDeps.redis);
  const metrics = createRealtimeMetrics(rateLimiter.mode);

  const sendJson = (ws: WebSocket, frame: WsServerFrame): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > sendBufferLimitBytes) {
      ws.close(1013, 'backpressure');
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Ignore per-socket send failures; close cleanup removes dead sockets.
    }
  };

  const sendError = (ws: WebSocket, reason: WsErrorReason, detail?: string, requestId?: string): void => {
    sendJson(ws, { type: 'error', reason, ...(requestId ? { request_id: requestId } : {}), ...(detail ? { detail } : {}) });
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

  const broadcastRoomEventToLocalClients = (raw: string): void => {
    const event = parseRoomEvent(raw);
    if (!event || event.type !== 'message.created') return;

    const sockets = presenceStore.getRoomSockets(event.room_id);
    if (!sockets) return;
    for (const socket of sockets) {
      const recipient = presenceStore.getClientState(socket);
      if (!recipient) continue;
      if (recipient.user.userId === event.message.sender_id) continue;
      if (recipient.connectionId === event.origin_connection_id) continue;
      sendJson(socket, { type: 'msg', message: event.message });
    }
  };

  const unavailableMessageWritePublisher: MessageWritePublisher = {
    async publishMessageWrite(): Promise<void> {
      throw new Error('message write publisher unavailable');
    },
  };
  const messageWritePublisher = instrumentMessageWritePublisher(
    redisDeps.messageWritePublisher ?? unavailableMessageWritePublisher,
    metrics,
    {
      timeoutMs: readPositiveInteger(process.env.REALTIME_NATS_PUBLISH_TIMEOUT_MS, 5000),
      maxInFlight: readPositiveInteger(process.env.REALTIME_NATS_PUBLISH_MAX_IN_FLIGHT, 8192),
    },
  );

  const broadcastPresenceEventToLocalClients = async (raw: string): Promise<void> => {
    const event = parsePresenceEvent(raw);
    if (!event) return;

    const memberships = await prisma.roomMember.findMany({
      where: { userId: event.user_id },
      select: { roomId: true },
    });
    const recipients = new Set<WebSocket>();
    for (const membership of memberships) {
      const sockets = presenceStore.getRoomSockets(membership.roomId);
      if (!sockets) continue;
      for (const socket of sockets) {
        const recipient = presenceStore.getClientState(socket);
        if (!recipient || recipient.user.userId === event.user_id) continue;
        recipients.add(socket);
      }
    }
    for (const socket of recipients) {
      sendJson(socket, { type: 'presence', user_id: event.user_id, online: event.online });
    }
  };

  if (redisDeps.subscriber) {
    void redisDeps.subscriber.pSubscribe(ROOM_EVENT_PATTERN, broadcastRoomEventToLocalClients).catch((err) => {
      console.error('redis room event subscription failed:', err);
    });
    void redisDeps.subscriber.pSubscribe(PRESENCE_CHANNEL, (message) => {
      void broadcastPresenceEventToLocalClients(message);
    }).catch((err) => {
      console.error('redis presence subscription failed:', err);
    });
  }

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
    const receivedAt = performance.now();
    metrics.recordSendFrameReceived();

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
    metrics.recordSendValidation(performance.now() - receivedAt);

    const rateLimitStartedAt = performance.now();
    const rateLimit = await rateLimiter.check(state.user.userId, {
      keyPrefix: 'ws:send',
      limit: Number(process.env.WS_SEND_RATE_LIMIT_PER_SEC || 20),
      windowSeconds: 1,
    });
    metrics.recordSendRateLimit(performance.now() - rateLimitStartedAt);
    if (!rateLimit.allowed) {
      metrics.recordRateLimitedSend();
      sendError(state.ws, 'rate_limited', 'Too many messages');
      return;
    }

    const roomIndexStartedAt = performance.now();
    const roomIndexed = await ensureRoomIndexed(state, frame.chat_id);
    metrics.recordSendRoomIndex(performance.now() - roomIndexStartedAt);
    if (!roomIndexed) {
      sendError(state.ws, 'forbidden', 'Not a member of this chat', frame.request_id);
      return;
    }
    metrics.recordSendPreBuffer(performance.now() - receivedAt);

    const createBufferStartedAt = performance.now();
    try {
      const message = await createBufferedMessage(prisma, {
        senderId: state.user.userId,
        chatId: frame.chat_id,
        body: frame.body,
        requestId: frame.request_id,
      }, {
        messageWritePublisher,
        originConnectionId: state.connectionId,
        membershipVerified: true,
        publishAttempts: 1,
        publishRetryDelayMs: 0,
        stageTimings: {
          recordPrepareMs: metrics.recordCreateBufferPrepare,
        },
      });
      metrics.recordCreateBufferTotal(performance.now() - createBufferStartedAt);
      sendJson(state.ws, {
        type: 'ack',
        request_id: frame.request_id,
        message_id: message.id,
        accepted_at: message.created_at,
      });
      metrics.recordAckSent(performance.now() - receivedAt);
    } catch (err) {
      metrics.recordCreateBufferTotal(performance.now() - createBufferStartedAt);
      if (err instanceof AppError) {
        sendError(state.ws, mapAppErrorToWsReason(err), err.message, frame.request_id);
        return;
      }
      console.error('ws send failed:', err);
      sendError(state.ws, 'validation_failed', 'message could not be sent', frame.request_id);
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

    const rateLimit = await rateLimiter.check(state.user.userId, {
      keyPrefix: 'ws:typing',
      limit: Number(process.env.WS_TYPING_RATE_LIMIT_PER_SEC || 10),
      windowSeconds: 1,
    });
    if (!rateLimit.allowed) {
      metrics.recordRateLimitedTyping();
      sendError(state.ws, 'rate_limited', 'Too many typing events');
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

    const state: ClientState = { ws, user, roomIds: new Set(), connectionId: createConnectionId() };
    const wasOnline = presenceStore.hasOpenSocketForUser(user.userId);
    presenceStore.addClient(state);
    metrics.recordWsConnected();
    const presenceRefresh = setInterval(() => {
      void refreshPresence(redisDeps.redis, state.connectionId);
    }, 10_000);
    presenceRefresh.unref();

    ws.on('message', (data) => {
      let frame: RawFrame;
      try {
        frame = JSON.parse(data.toString()) as RawFrame;
      } catch {
        return;
      }

      if (frame.type === 'ping') {
        void refreshPresence(redisDeps.redis, state.connectionId);
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
      clearInterval(presenceRefresh);
      metrics.recordWsDisconnected();
      const closedState = presenceStore.removeClient(ws);
      if (!closedState) return;

      if (redisDeps.redis) {
        void unregisterPresence(redisDeps.redis, user.userId, closedState.connectionId);
        return;
      }

      if (!presenceStore.hasOpenSocketForUser(user.userId)) {
        broadcastPresence(closedState, false);
      }
    });

    if (!preloadRoomsOnConnect) {
      void (async () => {
        if (ws.readyState !== WebSocket.OPEN || presenceStore.getClientState(ws) !== state) return;
        if (redisDeps.redis) {
          await registerPresence(redisDeps.redis, user.userId, state.connectionId);
        } else if (!wasOnline) {
          broadcastPresence(state, true);
        }
      })().catch((err) => {
        console.error('ws connection setup failed:', err);
        ws.close(1011, 'internal_error');
      });
      return;
    }

    void (async () => {
      const memberships = await prisma.roomMember.findMany({
        where: { userId: user.userId },
        select: { roomId: true },
      });
      if (ws.readyState !== WebSocket.OPEN || presenceStore.getClientState(ws) !== state) return;
      for (const membership of memberships) presenceStore.addSocketToRoom(state, membership.roomId);

      const onlineUserIds = redisDeps.redis
        ? await findOnlineRoomMembers(prisma, redisDeps.redis, [...state.roomIds], user.userId)
        : findLocalOnlineRoomMembers(presenceStore, state, user.userId);
      for (const onlineUserId of onlineUserIds) {
        sendJson(ws, { type: 'presence', user_id: onlineUserId, online: true });
      }

      // console.log('ws connected:', user.userId);
      if (redisDeps.redis) {
        await registerPresence(redisDeps.redis, user.userId, state.connectionId);
      } else if (!wasOnline) {
        broadcastPresence(state, true);
      }
    })().catch((err) => {
      console.error('ws connection setup failed:', err);
      ws.close(1011, 'internal_error');
    });
  });

  wss.on('close', () => {
    metrics.close();
  });

  return wss;
}

function findLocalOnlineRoomMembers(
  presenceStore: PresenceStore,
  state: ClientState,
  currentUserId: string,
): Set<string> {
  const onlineUserIds = new Set<string>();
  for (const roomId of state.roomIds) {
    const sockets = presenceStore.getRoomSockets(roomId);
    if (!sockets) continue;
    for (const socket of sockets) {
      const recipient = presenceStore.getClientState(socket);
      if (recipient && recipient.user.userId !== currentUserId) {
        onlineUserIds.add(recipient.user.userId);
      }
    }
  }
  return onlineUserIds;
}

async function findOnlineRoomMembers(
  prisma: PrismaClient,
  redis: RedisLike,
  roomIds: string[],
  currentUserId: string,
): Promise<Set<string>> {
  if (!roomIds.length) return new Set();

  const members = await prisma.roomMember.findMany({
    where: { roomId: { in: roomIds }, userId: { not: currentUserId } },
    select: { userId: true },
    distinct: ['userId'],
  });
  const onlineUserIds = new Set<string>();
  await Promise.all(members.map(async (member) => {
    if (await isUserOnline(redis, member.userId)) onlineUserIds.add(member.userId);
  }));
  return onlineUserIds;
}

export function startWebSocketServer(
  port = Number(process.env.WS_PORT || 8081),
  prisma?: PrismaClient,
  redisDeps: RealtimeRedisDependencies = {},
): WebSocketServer {
  const wss = createWebSocketServer(port, prisma, new InMemoryPresenceStore(), redisDeps);
  console.log(`WebSocket server running on port ${port}`);
  return wss;
}

function mapAppErrorToWsReason(err: AppError): WsErrorReason {
  if (err.code === 'FORBIDDEN') return 'forbidden';
  if (err.code === 'AUTH_REQUIRED') return 'auth_expired';
  if (err.code === 'INTERNAL') return 'buffer_unavailable';
  return 'validation_failed';
}

function instrumentMessageWritePublisher(
  publisher: MessageWritePublisher,
  metrics: RealtimeMetrics,
  options: { timeoutMs: number; maxInFlight: number },
): MessageWritePublisher {
  const timeoutMs = Math.max(1, options.timeoutMs);
  const maxInFlight = Math.max(1, options.maxInFlight);
  let inFlight = 0;

  return {
    async publishMessageWrite(command): Promise<void> {
      if (inFlight >= maxInFlight) {
        metrics.recordNatsPublishSkipped();
        throw new Error('message write publisher saturated');
      }

      const startedAt = performance.now();
      metrics.recordNatsPublishStarted();
      inFlight += 1;
      const trackedPublish = publisher.publishMessageWrite(command)
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1);
        });
      trackedPublish.catch(() => undefined);

      try {
        await withTimeout(trackedPublish, timeoutMs);
        metrics.recordNatsPublishSucceeded(performance.now() - startedAt);
      } catch (err) {
        metrics.recordNatsPublishFailed(performance.now() - startedAt);
        throw err;
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`message write publish timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

type RealtimeCounters = {
  ws_connected: number;
  send_frame_received: number;
  send_rate_limited: number;
  typing_rate_limited: number;
  nats_publish_started: number;
  nats_publish_succeeded: number;
  nats_publish_failed: number;
  nats_publish_skipped: number;
  ack_sent: number;
};

type RealtimeMetrics = ReturnType<typeof createRealtimeMetrics>;

function createRealtimeMetrics(rateLimitMode: RealtimeRateLimitMode) {
  const intervalMs = Number(process.env.LOAD_METRICS_LOG_INTERVAL_MS || 5000);
  const prometheus = createRealtimePrometheusMetrics();
  const counters: RealtimeCounters = {
    ws_connected: 0,
    send_frame_received: 0,
    send_rate_limited: 0,
    typing_rate_limited: 0,
    nats_publish_started: 0,
    nats_publish_succeeded: 0,
    nats_publish_failed: 0,
    nats_publish_skipped: 0,
    ack_sent: 0,
  };
  const publishLatency = createLatencyTracker();
  const ackLatency = createLatencyTracker();
  const sendValidationLatency = createLatencyTracker();
  const sendRateLimitLatency = createLatencyTracker();
  const sendRoomIndexLatency = createLatencyTracker();
  const sendPreBufferLatency = createLatencyTracker();
  const createBufferPrepareLatency = createLatencyTracker();
  const createBufferTotalLatency = createLatencyTracker();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  const timer = intervalMs > 0
    ? setInterval(() => {
      const snapshot = {
        event: 'realtime_metrics',
        ts: new Date().toISOString(),
        rate_limit_mode: rateLimitMode,
        ...counters,
        publish_latency_ms: publishLatency.snapshotAndReset(),
        ack_latency_ms: ackLatency.snapshotAndReset(),
        stage_latency_ms: {
          send_validation: sendValidationLatency.snapshotAndReset(),
          send_rate_limit: sendRateLimitLatency.snapshotAndReset(),
          send_room_index: sendRoomIndexLatency.snapshotAndReset(),
          send_pre_buffer: sendPreBufferLatency.snapshotAndReset(),
          create_buffer_prepare: createBufferPrepareLatency.snapshotAndReset(),
          create_buffer_total: createBufferTotalLatency.snapshotAndReset(),
        },
        event_loop_lag_ms: {
          avg: roundMs(eventLoopDelay.mean / 1_000_000),
          max: roundMs(eventLoopDelay.max / 1_000_000),
        },
      };
      prometheus.setEventLoopLag(snapshot.event_loop_lag_ms.avg, snapshot.event_loop_lag_ms.max);
      eventLoopDelay.reset();
      console.log(JSON.stringify(snapshot));
    }, intervalMs)
    : undefined;
  timer?.unref();

  return {
    recordWsConnected(): void {
      counters.ws_connected += 1;
      prometheus.setWsConnected(counters.ws_connected);
    },
    recordWsDisconnected(): void {
      counters.ws_connected = Math.max(0, counters.ws_connected - 1);
      prometheus.setWsConnected(counters.ws_connected);
    },
    recordSendFrameReceived(): void {
      counters.send_frame_received += 1;
      prometheus.recordSendFrameReceived();
    },
    recordRateLimitedSend(): void {
      counters.send_rate_limited += 1;
      prometheus.recordRateLimitedSend();
    },
    recordRateLimitedTyping(): void {
      counters.typing_rate_limited += 1;
      prometheus.recordRateLimitedTyping();
    },
    recordNatsPublishStarted(): void {
      counters.nats_publish_started += 1;
      prometheus.recordNatsPublish('started');
    },
    recordNatsPublishSucceeded(latencyMs: number): void {
      counters.nats_publish_succeeded += 1;
      publishLatency.add(latencyMs);
      prometheus.recordNatsPublish('succeeded', latencyMs);
    },
    recordNatsPublishFailed(latencyMs: number): void {
      counters.nats_publish_failed += 1;
      publishLatency.add(latencyMs);
      prometheus.recordNatsPublish('failed', latencyMs);
    },
    recordNatsPublishSkipped(): void {
      counters.nats_publish_skipped += 1;
      prometheus.recordNatsPublish('skipped');
    },
    recordSendValidation(latencyMs: number): void {
      sendValidationLatency.add(latencyMs);
      prometheus.recordStageLatency('send_validation', latencyMs);
    },
    recordSendRateLimit(latencyMs: number): void {
      sendRateLimitLatency.add(latencyMs);
      prometheus.recordStageLatency('send_rate_limit', latencyMs);
    },
    recordSendRoomIndex(latencyMs: number): void {
      sendRoomIndexLatency.add(latencyMs);
      prometheus.recordStageLatency('send_room_index', latencyMs);
    },
    recordSendPreBuffer(latencyMs: number): void {
      sendPreBufferLatency.add(latencyMs);
      prometheus.recordStageLatency('send_pre_buffer', latencyMs);
    },
    recordCreateBufferPrepare(latencyMs: number): void {
      createBufferPrepareLatency.add(latencyMs);
      prometheus.recordStageLatency('create_buffer_prepare', latencyMs);
    },
    recordCreateBufferTotal(latencyMs: number): void {
      createBufferTotalLatency.add(latencyMs);
      prometheus.recordStageLatency('create_buffer_total', latencyMs);
    },
    recordAckSent(latencyMs: number): void {
      counters.ack_sent += 1;
      ackLatency.add(latencyMs);
      prometheus.recordAckSent(latencyMs);
    },
    close(): void {
      if (timer) clearInterval(timer);
      eventLoopDelay.disable();
    },
  };
}

function createRealtimePrometheusMetrics() {
  const wsConnected = getOrCreateGauge({
    name: 'backend_realtime_ws_connected',
    help: 'Current open WebSocket connections on this realtime service instance.',
  });
  const sendFramesTotal = getOrCreateCounter({
    name: 'backend_realtime_send_frames_total',
    help: 'Total WebSocket send frames received.',
  });
  const sendRateLimitedTotal = getOrCreateCounter({
    name: 'backend_realtime_send_rate_limited_total',
    help: 'Total WebSocket send frames rejected by rate limiting.',
  });
  const typingRateLimitedTotal = getOrCreateCounter({
    name: 'backend_realtime_typing_rate_limited_total',
    help: 'Total WebSocket typing frames rejected by rate limiting.',
  });
  const natsPublishTotal = getOrCreateCounter({
    name: 'backend_realtime_nats_publish_total',
    help: 'Total message write NATS publish attempts by result.',
    labelNames: ['result'],
  });
  const ackSentTotal = getOrCreateCounter({
    name: 'backend_realtime_ack_sent_total',
    help: 'Total WebSocket ack frames sent.',
  });
  const publishLatency = getOrCreateHistogram({
    name: 'backend_realtime_publish_latency_ms',
    help: 'Message write NATS publish latency in milliseconds.',
    labelNames: ['result'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  });
  const ackLatency = getOrCreateHistogram({
    name: 'backend_realtime_ack_latency_ms',
    help: 'WebSocket send-to-ack latency in milliseconds.',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  });
  const stageLatency = getOrCreateHistogram({
    name: 'backend_realtime_stage_latency_ms',
    help: 'Realtime send pipeline stage latency in milliseconds.',
    labelNames: ['stage'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  });
  const eventLoopLag = getOrCreateGauge({
    name: 'backend_realtime_event_loop_lag_ms',
    help: 'Realtime service event loop lag in milliseconds.',
    labelNames: ['stat'],
  });

  return {
    setWsConnected(value: number): void {
      wsConnected.set(value);
    },
    recordSendFrameReceived(): void {
      sendFramesTotal.inc();
    },
    recordRateLimitedSend(): void {
      sendRateLimitedTotal.inc();
    },
    recordRateLimitedTyping(): void {
      typingRateLimitedTotal.inc();
    },
    recordNatsPublish(result: 'started' | 'succeeded' | 'failed' | 'skipped', latencyMs?: number): void {
      natsPublishTotal.labels(result).inc();
      if (latencyMs !== undefined && (result === 'succeeded' || result === 'failed')) {
        publishLatency.labels(result).observe(Math.max(0, latencyMs));
      }
    },
    recordStageLatency(stage: string, latencyMs: number): void {
      stageLatency.labels(stage).observe(Math.max(0, latencyMs));
    },
    recordAckSent(latencyMs: number): void {
      ackSentTotal.inc();
      ackLatency.observe(Math.max(0, latencyMs));
    },
    setEventLoopLag(avgMs: number, maxMs: number): void {
      eventLoopLag.labels('avg').set(avgMs);
      eventLoopLag.labels('max').set(maxMs);
    },
  };
}

function createLatencyTracker(maxSamples = Number(process.env.LOAD_METRICS_MAX_LATENCY_SAMPLES || 20_000)) {
  const samples: number[] = [];
  let count = 0;
  let sum = 0;
  let max = 0;

  return {
    add(value: number): void {
      const normalized = Math.max(0, value);
      count += 1;
      sum += normalized;
      max = Math.max(max, normalized);
      if (samples.length < maxSamples) samples.push(normalized);
    },
    snapshotAndReset(): LatencySnapshot {
      const sorted = [...samples].sort((a, b) => a - b);
      const p95Index = sorted.length ? Math.ceil(sorted.length * 0.95) - 1 : 0;
      const snapshot = {
        count,
        avg_ms: count ? roundMs(sum / count) : 0,
        p95_ms: sorted.length ? roundMs(sorted[p95Index]) : 0,
        max_ms: roundMs(max),
      };
      samples.length = 0;
      count = 0;
      sum = 0;
      max = 0;
      return snapshot;
    },
  };
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}
