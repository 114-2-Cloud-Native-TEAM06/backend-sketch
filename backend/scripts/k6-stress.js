/**
 * k6 two-phase stress test — login storm then message storm, as separate
 * scenarios on a time offset so each shows up in its own Grafana window.
 *
 * k6 is a standalone tool (NOT Node). Run via the docker image, pointing at
 * the running app. Easiest is to join the app's compose network and target the
 * `app` service by name:
 *
 *   docker run --rm --network backend-sketch_default \
 *     -v "${PWD}/backend/scripts:/scripts" grafana/k6 run /scripts/k6-stress.js \
 *     -e API_URL=http://app:8080/api/v1 -e WS_URL=ws://app:8081
 *
 * (check the network name with `docker network ls | findstr default`.)
 * On Windows Docker Desktop you can instead target the host:
 *   ... -e API_URL=http://host.docker.internal:8080/api/v1 -e WS_URL=ws://host.docker.internal:8081
 *
 * Tunables (-e KEY=VALUE):
 *   USERS (50) | LOGIN_VUS (20) | LOGIN_RAMP/HOLD via stages | MSG_VUS (=USERS)
 *   MSG_DURATION (30s) | MSG_START (30s) | SEND_INTERVAL_MS (200)
 */
import ws from 'k6/ws';
import httpReq from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:8080/api/v1';
const WS = __ENV.WS_URL || 'ws://localhost:8081';
const USERS = Number(__ENV.USERS || 50);
const SEND_INTERVAL_MS = Number(__ENV.SEND_INTERVAL_MS || 200);
const MSG_DURATION = __ENV.MSG_DURATION || '30s';
const PASSWORD = 'k6stress123';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const wsSent = new Counter('im_ws_sent');
const wsAcked = new Counter('im_ws_acked');
const wsReceived = new Counter('im_ws_received');

export const options = {
  scenarios: {
    // Phase 1: hammer POST /auth/login → isolates bcrypt + user lookup.
    login_storm: {
      executor: 'ramping-vus',
      exec: 'loginStorm',
      startVUs: 0,
      stages: [
        { duration: '5s', target: Number(__ENV.LOGIN_VUS || 20) },
        { duration: '15s', target: Number(__ENV.LOGIN_VUS || 20) },
        { duration: '2s', target: 0 },
      ],
      startTime: '0s',
      gracefulStop: '3s',
    },
    // Phase 2: N held WS connections each sending → isolates fanout + msg DB writes.
    message_storm: {
      executor: 'constant-vus',
      exec: 'messageStorm',
      vus: Number(__ENV.MSG_VUS || USERS),
      duration: MSG_DURATION,
      startTime: __ENV.MSG_START || '30s', // after login storm + a visible gap
      gracefulStop: '5s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:login_storm}': ['p(95)<3000'],
    checks: ['rate>0.95'],
  },
};

// Runs once. Registers a user pool, logs them in, creates one group chat.
export function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const username = `k6_u${i}`;
    const email = `${username}@k6.test`;
    httpReq.post(`${API}/auth/register`, JSON.stringify({ username, email, password: PASSWORD, display_name: username }), { headers: JSON_HEADERS });
    const res = httpReq.post(`${API}/auth/login`, JSON.stringify({ email, password: PASSWORD }), { headers: JSON_HEADERS });
    users.push({ username, token: res.json('token') });
  }
  const owner = users[0];
  const create = httpReq.post(`${API}/chats`, JSON.stringify({ type: 'group', name: 'k6stress', member_ids: users.slice(1).map((u) => u.username) }),
    { headers: Object.assign({ Authorization: `Bearer ${owner.token}` }, JSON_HEADERS) });
  return { users, chatId: create.json('id') };
}

export function loginStorm(data) {
  const u = data.users[(__VU + __ITER) % data.users.length];
  const res = httpReq.post(`${API}/auth/login`, JSON.stringify({ email: `${u.username}@k6.test`, password: PASSWORD }), { headers: JSON_HEADERS });
  check(res, { 'login 200': (r) => r.status === 200 });
}

export function messageStorm(data) {
  const u = data.users[(__VU - 1) % data.users.length];
  const url = `${WS}/ws/chat?token=${encodeURIComponent(u.token)}`;
  const res = ws.connect(url, {}, (socket) => {
    let seq = 0;
    socket.on('open', () => {
      socket.setInterval(() => {
        socket.send(JSON.stringify({ type: 'send', request_id: `${u.username}:${__VU}:${seq++}:${Date.now()}`, chat_id: data.chatId, body: `k6 ${seq}` }));
        wsSent.add(1);
      }, SEND_INTERVAL_MS);
      // hold the connection for (almost) the whole scenario, then close cleanly
      socket.setTimeout(() => socket.close(), Number(__ENV.WS_HOLD_MS || 28000));
    });
    socket.on('message', (msg) => {
      let f;
      try { f = JSON.parse(msg); } catch (e) { return; }
      if (f.type === 'ack') wsAcked.add(1);
      else if (f.type === 'msg') wsReceived.add(1);
    });
  });
  check(res, { 'ws upgraded (101)': (r) => r && r.status === 101 });
}
