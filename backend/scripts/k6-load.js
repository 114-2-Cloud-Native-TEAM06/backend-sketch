/**
 * k6 WS load generator — ramps WS connections up and holds, each sending into
 * one group chat. Mirrors ws-load.mjs but as a k6 scenario (ramping connections
 * give a nice staircase on the dashboard).
 *
 * Run (join the app's compose network, target the `app` service):
 *   docker run --rm --network backend-sketch_default \
 *     -v "${PWD}/backend/scripts:/scripts" grafana/k6 run /scripts/k6-load.js \
 *     -e API_URL=http://app:8080/api/v1 -e WS_URL=ws://app:8081
 *
 * Tunables (-e KEY=VALUE):
 *   USERS (80) | SEND_INTERVAL_MS (200) | WS_HOLD_MS (60000)
 */
import ws from 'k6/ws';
import httpReq from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:8080/api/v1';
const WS = __ENV.WS_URL || 'ws://localhost:8081';
const USERS = Number(__ENV.USERS || 80);
const SEND_INTERVAL_MS = Number(__ENV.SEND_INTERVAL_MS || 200);
const PASSWORD = 'k6load123';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const wsSent = new Counter('im_ws_sent');
const wsAcked = new Counter('im_ws_acked');

export const options = {
  scenarios: {
    message_ramp: {
      executor: 'ramping-vus',
      exec: 'fanout',
      startVUs: 0,
      stages: [
        { duration: '20s', target: USERS }, // ramp connections up
        { duration: '30s', target: USERS }, // hold
        { duration: '10s', target: 0 },      // ramp down
      ],
      gracefulStop: '5s',
    },
  },
};

export function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const username = `k6l_u${i}`;
    const email = `${username}@k6.test`;
    httpReq.post(`${API}/auth/register`, JSON.stringify({ username, email, password: PASSWORD, display_name: username }), { headers: JSON_HEADERS });
    const res = httpReq.post(`${API}/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: JSON_HEADERS });
    users.push({ username, token: res.json('token') });
  }
  const owner = users[0];
  const create = httpReq.post(`${API}/chats`, JSON.stringify({ type: 'group', name: 'k6load', member_ids: users.slice(1).map((u) => u.username) }),
    { headers: Object.assign({ Authorization: `Bearer ${owner.token}` }, JSON_HEADERS) });
  return { users, chatId: create.json('id') };
}

export function fanout(data) {
  const u = data.users[(__VU - 1) % data.users.length];
  const res = ws.connect(`${WS}/ws/chat?token=${encodeURIComponent(u.token)}`, {}, (socket) => {
    let seq = 0;
    socket.on('open', () => {
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: 'send', request_id: `${u.username}:${__VU}:${seq++}:${Date.now()}`, chat_id: data.chatId, body: `k6 ${seq}` }));
        wsSent.add(1);
      }, SEND_INTERVAL_MS);
      socket.setTimeout(() => socket.close(), Number(__ENV.WS_HOLD_MS || 60000));
    });
    socket.on('message', (msg) => {
      try { if (JSON.parse(msg).type === 'ack') wsAcked.add(1); } catch (e) { /* ignore */ }
    });
  });
  check(res, { 'ws upgraded (101)': (r) => r && r.status === 101 });
}
