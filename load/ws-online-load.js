import http from 'k6/http';
import ws from 'k6/ws';
import { sleep } from 'k6';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const API_BASE = __ENV.API_BASE;
const POOL_FILE = __ENV.POOL_FILE || '';
const POOL_METADATA = POOL_FILE ? JSON.parse(open(POOL_FILE)) : null;
const POOL_USERS = POOL_FILE
  ? new SharedArray(`online-pool-${POOL_FILE}`, () => {
    const fixture = JSON.parse(open(POOL_FILE));
    if (!Array.isArray(fixture.users) || fixture.users.length === 0) {
      throw new Error(`POOL_FILE ${POOL_FILE} does not contain users`);
    }
    for (const user of fixture.users) {
      if (!user.token) {
        throw new Error(`POOL_FILE ${POOL_FILE} users must include token`);
      }
    }
    return fixture.users;
  })
  : null;
const USER_API_BASE = __ENV.USER_API_BASE || API_BASE || 'http://localhost:8082';
const WS_BASE = __ENV.WS_BASE || 'ws://localhost:8081';
const USERS = Number(__ENV.USERS || (POOL_USERS ? POOL_USERS.length : 1000));
const USER_OFFSET = Number(__ENV.USER_OFFSET || 0);
const DURATION = __ENV.DURATION || '1m';
const SOCKET_HOLD_MS = Number(__ENV.SOCKET_HOLD_MS || 60000);
const PING_INTERVAL_MS = Number(__ENV.PING_INTERVAL_MS || 15000);
const GRACEFUL_STOP = __ENV.GRACEFUL_STOP || '10s';
const RUN_MAX_DURATION = __ENV.RUN_MAX_DURATION
  || formatDurationMs(SOCKET_HOLD_MS + parseDurationMs(GRACEFUL_STOP));
const PASSWORD = __ENV.PASSWORD || 'password123';
const RUN_ID = __ENV.RUN_ID || 'online';
const REPORT_DIR = __ENV.REPORT_DIR || 'load/reports';
const API_HEALTH_TIMEOUT_SECONDS = Number(__ENV.API_HEALTH_TIMEOUT_SECONDS || 60);
const USER_POOL_ID = __ENV.USER_POOL_ID || POOL_METADATA?.user_pool_id || RUN_ID;
const USERNAME_RUN_ID = USER_POOL_ID.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'online';

if (!Number.isInteger(USER_OFFSET) || USER_OFFSET < 0) {
  throw new Error('USER_OFFSET must be a non-negative integer');
}

if (POOL_USERS && USER_OFFSET + USERS > POOL_USERS.length) {
  throw new Error(`USER_OFFSET + USERS (${USER_OFFSET + USERS}) exceeds POOL_FILE users (${POOL_USERS.length})`);
}

export const options = {
  setupTimeout: __ENV.SETUP_TIMEOUT || '20m',
  scenarios: {
    online_ws: {
      executor: 'per-vu-iterations',
      vus: USERS,
      iterations: 1,
      maxDuration: RUN_MAX_DURATION,
      gracefulStop: GRACEFUL_STOP,
    },
  },
};

const wsConnectAttempts = new Counter('ws_connect_attempts');
const wsConnected = new Counter('ws_connected');
const wsConnectSuccessRate = new Rate('ws_connect_success_rate');
const wsUnexpectedClose = new Counter('ws_unexpected_close');
const pingSent = new Counter('ping_sent');
const pongReceived = new Counter('pong_received');
const pongLatency = new Trend('pong_latency_ms', true);
const wsFramesReceived = new Counter('ws_frames_received');

function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function postJson(path, body, token) {
  return http.post(`${USER_API_BASE}${path}`, JSON.stringify(body), {
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

function preflightApi() {
  let res;
  const deadline = Date.now() + API_HEALTH_TIMEOUT_SECONDS * 1000;

  do {
    res = http.get(`${USER_API_BASE}/health`, { timeout: '10s' });
    if (res.status === 200) return;
    sleep(1);
  } while (Date.now() < deadline);

  throw new Error(
    `user API health check failed for USER_API_BASE=${USER_API_BASE}: ${describeHttpFailure(res)}. ` +
    'Start the backend first, or override USER_API_BASE. For Docker k6 on macOS use ' +
    'http://host.docker.internal:8082; on Linux try http://172.17.0.1:8082 or Docker host networking.',
  );
}

function registerOrLogin(index) {
  const username = `on_${USERNAME_RUN_ID}_${index}`.slice(0, 32);
  const email = `${username}@example.com`;
  const payload = {
    username,
    email,
    password: PASSWORD,
    display_name: `Online User ${index}`,
  };

  const registerRes = postJson('/api/v1/auth/register', payload);
  if (registerRes.status === 201) {
    const body = json(registerRes);
    return { token: body.token, user: body.user, username };
  }

  if (registerRes.status === 409) {
    const loginRes = postJson('/api/v1/auth/login', { email, password: PASSWORD });
    if (loginRes.status === 200) {
      const body = json(loginRes);
      return { token: body.token, user: body.user, username };
    }
    throw new Error(`login failed for ${username}: ${describeHttpFailure(loginRes)}`);
  }

  throw new Error(`register failed for ${username}: ${describeHttpFailure(registerRes)} USER_API_BASE=${USER_API_BASE}`);
}

export function setup() {
  if (POOL_USERS) {
    return {
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
      poolFile: POOL_FILE,
    };
  }

  preflightApi();

  const users = [];
  for (let i = 0; i < USERS; i += 1) {
    users.push(registerOrLogin(i));
  }

  return {
    runId: RUN_ID,
    userPoolId: USER_POOL_ID,
    users: users.map((u) => ({ token: u.token, userId: u.user.id, username: u.username })),
  };
}

export default function (data) {
  const users = POOL_USERS || data.users;
  const userIndex = (USER_OFFSET + exec.vu.idInTest - 1) % users.length;
  const user = users[userIndex];
  const url = `${WS_BASE}/ws/chat?token=${encodeURIComponent(user.token)}`;
  let intentionalClose = false;
  let lastPingAt = 0;

  wsConnectAttempts.add(1);

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      wsConnected.add(1);
    });

    socket.setInterval(() => {
      lastPingAt = Date.now();
      pingSent.add(1);
      socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);

    socket.on('message', (raw) => {
      wsFramesReceived.add(1);
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch (_) {
        return;
      }

      if (frame.type === 'pong') {
        pongReceived.add(1);
        if (lastPingAt > 0) pongLatency.add(Date.now() - lastPingAt);
      }
    });

    socket.on('close', () => {
      if (!intentionalClose) wsUnexpectedClose.add(1);
    });

    socket.setTimeout(() => {
      intentionalClose = true;
      socket.close();
    }, SOCKET_HOLD_MS);
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

function parseDurationMs(value) {
  const text = String(value || '').trim();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (!matches.length) return 0;

  return matches.reduce((sum, match) => {
    const amount = Number(match[1]);
    const unit = match[2];
    if (unit === 'ms') return sum + amount;
    if (unit === 's') return sum + amount * 1000;
    if (unit === 'm') return sum + amount * 60000;
    if (unit === 'h') return sum + amount * 3600000;
    return sum;
  }, 0);
}

function formatDurationMs(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function handleSummary(data) {
  const attempts = metricCount(data, 'ws_connect_attempts');
  const connected = metricCount(data, 'ws_connected');
  const successRate = metricRate(data, 'ws_connect_success_rate') * 100;
  const unexpectedClose = metricCount(data, 'ws_unexpected_close');
  const pings = metricCount(data, 'ping_sent');
  const pongs = metricCount(data, 'pong_received');
  const pongRate = pings > 0 ? (pongs / pings) * 100 : 0;
  const pongP95 = metricP95(data, 'pong_latency_ms') / 1000;
  const frames = metricCount(data, 'ws_frames_received');

  const report = {
    run_id: RUN_ID,
    user_pool_id: USER_POOL_ID,
    pool_file: POOL_FILE || undefined,
    user_offset: USER_OFFSET,
    user_api_base: USER_API_BASE,
    ws_base: WS_BASE,
    target_users: USERS,
    duration: DURATION,
    run_max_duration: RUN_MAX_DURATION,
    socket_hold_ms: SOCKET_HOLD_MS,
    ping_interval_ms: PING_INTERVAL_MS,
    ws_connect_attempts: attempts,
    ws_connected: connected,
    websocket_connect_success_rate_percent: Number(successRate.toFixed(2)),
    ws_unexpected_close: unexpectedClose,
    ping_sent: pings,
    pong_received: pongs,
    pong_success_rate_percent: Number(pongRate.toFixed(2)),
    pong_p95_seconds: Number(pongP95.toFixed(2)),
    ws_frames_received: frames,
  };

  const text = `
WS online load-test run_id=${RUN_ID}

Targets:
user_pool_id=${USER_POOL_ID}
pool_file=${POOL_FILE || '<none>'}
user_api_base=${USER_API_BASE}
ws_base=${WS_BASE}

Load:
target_users=${USERS}
user_offset=${USER_OFFSET}
duration=${DURATION}
run_max_duration=${RUN_MAX_DURATION}
socket_hold_ms=${SOCKET_HOLD_MS}
ping_interval_ms=${PING_INTERVAL_MS}

Results:
ws_connect_attempts=${attempts.toLocaleString()}
ws_connected=${connected.toLocaleString()}
websocket_connect_success_rate=${successRate.toFixed(2)}%
ws_unexpected_close=${unexpectedClose.toLocaleString()}
ping_sent=${pings.toLocaleString()}
pong_received=${pongs.toLocaleString()}
pong_success_rate=${pongRate.toFixed(2)}%
pong_p95=${pongP95.toFixed(2)}s
ws_frames_received=${frames.toLocaleString()}

Reports:
${REPORT_DIR}/ws-online-load-${RUN_ID}.txt
${REPORT_DIR}/ws-online-load-${RUN_ID}.json
${REPORT_DIR}/ws-online-load-${RUN_ID}.k6-summary.json
`;

  return {
    stdout: text,
    [`${REPORT_DIR}/ws-online-load-${RUN_ID}.txt`]: text,
    [`${REPORT_DIR}/ws-online-load-${RUN_ID}.json`]: JSON.stringify(report, null, 2),
    [`${REPORT_DIR}/ws-online-load-${RUN_ID}.k6-summary.json`]: JSON.stringify(data, null, 2),
  };
}
