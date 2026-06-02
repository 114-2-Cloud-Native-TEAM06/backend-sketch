import http from 'k6/http';
import ws from 'k6/ws';
import { sleep } from 'k6';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const API_BASE = __ENV.API_BASE;
const USER_API_BASE = __ENV.USER_API_BASE || API_BASE || 'http://localhost:8082';
const CHAT_API_BASE = __ENV.CHAT_API_BASE || API_BASE || 'http://localhost:8080';
const WS_BASE = __ENV.WS_BASE || 'ws://localhost:8081';
const USERS = Number(__ENV.USERS || 100);
const DURATION = __ENV.DURATION || '2m';
const SEND_INTERVAL_MS = Number(__ENV.SEND_INTERVAL_MS || 100);
const SOCKET_LIFE_MS = Number(__ENV.SOCKET_LIFE_MS || 60000);
const MAX_PENDING_ACKS = Number(__ENV.MAX_PENDING_ACKS || 1000);
const PASSWORD = __ENV.PASSWORD || 'password123';
const RUN_ID = __ENV.RUN_ID || 'local';
const REPORT_DIR = __ENV.REPORT_DIR || 'load/reports';
const API_HEALTH_TIMEOUT_SECONDS = Number(__ENV.API_HEALTH_TIMEOUT_SECONDS || 60);
const USERNAME_RUN_ID = RUN_ID.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'local';

export const options = {
  setupTimeout: '5m',
  scenarios: {
    chat_ws: {
      executor: 'constant-vus',
      vus: USERS,
      duration: DURATION,
      gracefulStop: '10s',
    },
  },
};

const wsConnectAttempts = new Counter('ws_connect_attempts');
const wsConnectSuccessRate = new Rate('ws_connect_success_rate');
const messagesSent = new Counter('messages_sent');
const sendSkippedBackpressure = new Counter('send_skipped_backpressure');
const wsFramesReceived = new Counter('ws_frames_received');
const ackReceived = new Counter('ack_received');
const ackMissing = new Counter('ack_missing_on_close');
const wsErrorFrames = new Counter('ws_error_frames');
const ackLatency = new Trend('ack_latency_ms', true);

function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function postJson(baseUrl, path, body, token) {
  return http.post(`${baseUrl}${path}`, JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    timeout: '30s',
  });
}

function describeHttpFailure(res) {
  const body = typeof res.body === 'string' && res.body.length > 0
    ? res.body.slice(0, 300)
    : '<empty>';
  const error = res.error ? ` error=${res.error}` : '';
  return `status=${res.status}${error} body=${body}`;
}

function waitForHealth(baseUrl, label) {
  let res;
  const deadline = Date.now() + API_HEALTH_TIMEOUT_SECONDS * 1000;

  do {
    res = http.get(`${baseUrl}/health`, { timeout: '10s' });
    if (res.status === 200) return;
    sleep(1);
  } while (Date.now() < deadline);

  throw new Error(
    `${label} health check failed for ${baseUrl}: ${describeHttpFailure(res)}. ` +
    'Start the backend first, or override USER_API_BASE / CHAT_API_BASE. For Docker k6 on macOS use ' +
    'host.docker.internal; on Linux try 172.17.0.1 or Docker host networking.',
  );
}

function preflightApi() {
  waitForHealth(USER_API_BASE, 'user API');
  waitForHealth(CHAT_API_BASE, 'chat API');
}

function registerOrLogin(index) {
  const username = `k6_${USERNAME_RUN_ID}_${index}`.slice(0, 32);
  const email = `${username}@example.com`;
  const payload = {
    username,
    email,
    password: PASSWORD,
    display_name: `K6 User ${index}`,
  };

  const registerRes = postJson(USER_API_BASE, '/api/v1/auth/register', payload);
  if (registerRes.status === 201) {
    const body = json(registerRes);
    return { token: body.token, user: body.user, username };
  }

  if (registerRes.status === 409) {
    const loginRes = postJson(USER_API_BASE, '/api/v1/auth/login', { email, password: PASSWORD });
    if (loginRes.status === 200) {
      const body = json(loginRes);
      return { token: body.token, user: body.user, username };
    }
    throw new Error(`login failed for ${username}: ${describeHttpFailure(loginRes)}`);
  }

  throw new Error(`register failed for ${username}: ${describeHttpFailure(registerRes)} USER_API_BASE=${USER_API_BASE}`);
}

function createDirectRoom(owner, target) {
  const res = postJson(CHAT_API_BASE, '/api/v1/chats', {
    type: 'direct',
    member_ids: [target.username],
  }, owner.token);

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`create room failed for ${owner.username}/${target.username}: ${describeHttpFailure(res)}`);
  }

  return json(res).id;
}

export function setup() {
  if (USERS % 2 !== 0) throw new Error('USERS must be an even number for direct-room pairing');
  preflightApi();

  const users = [];
  for (let i = 0; i < USERS; i += 1) {
    users.push(registerOrLogin(i));
  }

  const rooms = [];
  for (let i = 0; i < USERS; i += 2) {
    const roomId = createDirectRoom(users[i], users[i + 1]);
    users[i].roomId = roomId;
    users[i + 1].roomId = roomId;
    rooms.push(roomId);
  }

  return {
    runId: RUN_ID,
    users: users.map((u) => ({
      token: u.token,
      userId: u.user.id,
      username: u.username,
      roomId: u.roomId,
    })),
    rooms,
  };
}

export default function (data) {
  const userIndex = (exec.vu.idInTest - 1) % data.users.length;
  const user = data.users[userIndex];
  const pending = {};
  let seq = 0;

  const url = `${WS_BASE}/ws/chat?token=${encodeURIComponent(user.token)}`;
  wsConnectAttempts.add(1);

  const res = ws.connect(url, {}, (socket) => {
    socket.setInterval(() => {
      const pendingCount = Object.keys(pending).length;
      if (pendingCount >= MAX_PENDING_ACKS) {
        sendSkippedBackpressure.add(1);
        return;
      }

      const requestId = `k6-${data.runId}-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}-${seq}`;
      seq += 1;
      pending[requestId] = Date.now();

      socket.send(JSON.stringify({
        type: 'send',
        request_id: requestId,
        chat_id: user.roomId,
        body: `load-test message ${requestId}`,
      }));
      messagesSent.add(1);
    }, SEND_INTERVAL_MS);

    socket.on('message', (raw) => {
      wsFramesReceived.add(1);

      let frame;
      try {
        frame = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (frame.type === 'ack' && frame.request_id) {
        const sentAt = pending[frame.request_id];
        if (sentAt) {
          ackLatency.add(Date.now() - sentAt);
          delete pending[frame.request_id];
        }
        ackReceived.add(1);
        return;
      }

      if (frame.type === 'error') {
        wsErrorFrames.add(1);
      }
    });

    socket.setTimeout(() => {
      const missing = Object.keys(pending).length;
      if (missing > 0) ackMissing.add(missing);
      socket.close();
    }, SOCKET_LIFE_MS);
  });

  const connected = Boolean(res && res.status === 101);
  wsConnectSuccessRate.add(connected);
  check(res, { 'websocket handshake status is 101': (r) => r && r.status === 101 });
}

function metricCount(data, name) {
  return data.metrics[name]?.values?.count || 0;
}

function metricRate(data, name) {
  return data.metrics[name]?.values?.rate || 0;
}

function metricP95(data, name) {
  return data.metrics[name]?.values?.['p(95)'] || 0;
}

export function handleSummary(data) {
  const sent = metricCount(data, 'messages_sent');
  const frames = metricCount(data, 'ws_frames_received');
  const ackOk = metricCount(data, 'ack_received');
  const ackMiss = metricCount(data, 'ack_missing_on_close');
  const wsErrors = metricCount(data, 'ws_error_frames');
  const skipped = metricCount(data, 'send_skipped_backpressure');
  const durationSec = (data.state?.testRunDurationMs || 0) / 1000;
  const sendRate = durationSec > 0 ? sent / durationSec : 0;
  const ackErrorRate = sent > 0 ? (Math.max(sent - ackOk, 0) / sent) * 100 : 0;
  const connectRate = metricRate(data, 'ws_connect_success_rate') * 100;
  const ackP95 = metricP95(data, 'ack_latency_ms') / 1000;
  const dbCountCommand = `docker compose exec postgres psql -U admin -d imdb -c "SELECT count(*) FROM \\"Message\\" WHERE \\"requestId\\" LIKE 'k6-${RUN_ID}-%';"`;
  const report = {
    run_id: RUN_ID,
    user_api_base: USER_API_BASE,
    chat_api_base: CHAT_API_BASE,
    ws_base: WS_BASE,
    users: USERS,
    direct_rooms: USERS / 2,
    duration: DURATION,
    send_interval_ms: SEND_INTERVAL_MS,
    socket_life_ms: SOCKET_LIFE_MS,
    websocket_connect_success_rate_percent: Number(connectRate.toFixed(2)),
    messages_sent: sent,
    average_send_rate_msg_per_sec: Number(sendRate.toFixed(0)),
    ws_frames_received: frames,
    ack_received: ackOk,
    ack_missing_on_close: ackMiss,
    ws_error_frames: wsErrors,
    ack_p95_seconds: Number(ackP95.toFixed(2)),
    ack_error_rate_percent: Number(ackErrorRate.toFixed(2)),
    backpressure_skipped_sends: skipped,
    db_count_command: dbCountCommand,
    conclusion_hint: 'Compare ack latency/error rate with DB persisted count to identify realtime, writer, or DB bottlenecks.',
  };

  const text = `
NATS/WS load-test run_id=${RUN_ID}

Targets:
user_api_base=${USER_API_BASE}
chat_api_base=${CHAT_API_BASE}
ws_base=${WS_BASE}

Load:
users=${USERS}
direct_rooms=${USERS / 2}
duration=${DURATION}
send_interval_ms=${SEND_INTERVAL_MS}

Results:
websocket_connect_success_rate=${connectRate.toFixed(2)}%
messages_sent=${sent.toLocaleString()}
average_send_rate=${sendRate.toFixed(0)} msg/sec
ws_frames_received=${frames.toLocaleString()}
ack_received=${ackOk.toLocaleString()}
ack_missing_on_close=${ackMiss.toLocaleString()}
ws_error_frames=${wsErrors.toLocaleString()}
ack_p95=${ackP95.toFixed(2)}s
ack_error_rate=${ackErrorRate.toFixed(2)}%
backpressure_skipped_sends=${skipped.toLocaleString()}

DB validation:
${dbCountCommand}

Reports:
${REPORT_DIR}/ws-chat-load-${RUN_ID}.txt
${REPORT_DIR}/ws-chat-load-${RUN_ID}.json
${REPORT_DIR}/ws-chat-load-${RUN_ID}.k6-summary.json
`;

  return {
    stdout: text,
    [`${REPORT_DIR}/ws-chat-load-${RUN_ID}.txt`]: text,
    [`${REPORT_DIR}/ws-chat-load-${RUN_ID}.json`]: JSON.stringify(report, null, 2),
    [`${REPORT_DIR}/ws-chat-load-${RUN_ID}.k6-summary.json`]: JSON.stringify(data, null, 2),
  };
}
