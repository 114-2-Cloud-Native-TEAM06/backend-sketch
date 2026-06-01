import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const data = JSON.parse(open('./generated/ws-1000-msgs.json'));
const ackLatency = new Trend('ws_ack_latency_ms');
const ackErrorRate = new Rate('ws_ack_errors');
const skippedSends = new Counter('ws_skipped_sends');
const sentFrames = new Counter('ws_sent_frames');

export const options = {
  scenarios: {
    ws_messages: {
      executor: 'constant-vus',
      vus: Number(__ENV.WS_VUS || 100),
      duration: __ENV.WS_DURATION || '2m',
    },
  },
  thresholds: {
    ws_ack_latency_ms: ['p(95)<500'],
    ws_ack_errors: ['rate<0.01'],
  },
};

export default function () {
  const user = data.users[__VU % data.users.length];
  const url = `${data.wsUrl}?token=${encodeURIComponent(user.token)}`;
  const maxPending = Number(__ENV.WS_MAX_PENDING || 25);

  const res = ws.connect(url, {}, (socket) => {
    const pending = new Map();

    socket.on('open', () => {
      socket.setInterval(() => {
        if (pending.size >= maxPending) {
          skippedSends.add(1);
          return;
        }

        const requestId = `${__VU}-${__ITER}-${Date.now()}-${Math.random()}`;
        pending.set(requestId, Date.now());
        sentFrames.add(1);
        socket.send(JSON.stringify({
          type: 'send',
          request_id: requestId,
          chat_id: user.roomId,
          body: `load message ${requestId}`,
        }));
      }, Number(__ENV.WS_SEND_INTERVAL_MS || 100));
    });

    socket.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (frame.type === 'ack') {
        const startedAt = pending.get(frame.request_id);
        if (startedAt) {
          ackLatency.add(Date.now() - startedAt);
          pending.delete(frame.request_id);
        }
        ackErrorRate.add(0);
        return;
      }

      if (frame.type === 'error') {
        pending.delete(frame.request_id);
        ackErrorRate.add(1);
      }
    });

    socket.setTimeout(() => {
      for (const requestId of pending.keys()) {
        pending.delete(requestId);
        ackErrorRate.add(1);
      }
      socket.close();
    }, Number(__ENV.WS_SOCKET_LIFETIME_MS || 125_000));
  });

  check(res, {
    'websocket connected': (r) => r && r.status === 101,
  });
  sleep(1);
}
