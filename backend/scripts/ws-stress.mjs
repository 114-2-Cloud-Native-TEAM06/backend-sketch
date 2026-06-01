/**
 * Two-phase stress test — isolates the LOGIN bottleneck from the MESSAGING
 * bottleneck so each shows up cleanly in its own time window.
 *
 *   Phase 1 (LOGIN STORM):  hammer POST /auth/login concurrently. Isolates the
 *                           auth path (bcrypt hashing + the user lookup query).
 *   Phase 2 (MESSAGE STORM):open N WS connections, blast messages into one group
 *                           chat. Isolates fanout (ws socket writes) + the
 *                           per-message DB writes.
 *
 * Each phase prints a START/END timestamp — copy those into Grafana's time
 * picker to frame Pyroscope (wall) and the dashboard at that phase.
 *
 * Run inside the app container:
 *   docker compose exec app node scripts/ws-stress.mjs
 *
 * Tunables (env):
 *   USERS              pool size / WS connections          (default 50)
 *   LOGIN_CONCURRENCY  parallel login workers in phase 1   (default 20)
 *   LOGIN_MS           phase 1 duration                    (default 20000)
 *   MSG_MS             phase 2 duration                    (default 30000)
 *   SEND_INTERVAL_MS   per-connection gap in phase 2       (default 200)
 *   API_URL / WS_URL
 */
import WebSocket from 'ws';

const API = process.env.API_URL ?? 'http://localhost:8080/api/v1';
const WS = process.env.WS_URL ?? 'ws://localhost:8081';
const USERS = Math.max(2, Number(process.env.USERS ?? 50));
const LOGIN_CONCURRENCY = Number(process.env.LOGIN_CONCURRENCY ?? 20);
const LOGIN_MS = Number(process.env.LOGIN_MS ?? 20_000);
const MSG_MS = Number(process.env.MSG_MS ?? 30_000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 200);
const PASSWORD = 'loadtest123';

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : 0);

async function register(username) {
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@stress.test`, password: PASSWORD, display_name: username }),
  }).catch(() => {});
}

async function login(username) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${username}@stress.test`, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${username}: ${res.status}`);
  return res.json();
}

async function main() {
  const names = Array.from({ length: USERS }, (_, i) => `stress_u${i}`);

  console.log(`[setup] registering + logging in ${USERS} users...`);
  for (const n of names) await register(n);
  const tokens = {};
  for (const n of names) tokens[n] = (await login(n)).token;

  // group chat with everyone in it
  const owner = names[0];
  const createRes = await fetch(`${API}/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[owner]}` },
    body: JSON.stringify({ type: 'group', name: 'stress', member_ids: names.slice(1) }),
  });
  if (!createRes.ok) throw new Error(`group create: ${createRes.status} ${await createRes.text()}`);
  const chat = await createRes.json();
  console.log(`[setup] group chat ${chat.id} with ${chat.member_ids.length} members\n`);

  // ── Phase 1: LOGIN STORM ────────────────────────────────────────────────────
  console.log(`================ PHASE 1: LOGIN STORM ================`);
  console.log(`PHASE 1 START  ${now()}   (${LOGIN_CONCURRENCY} workers, ${LOGIN_MS}ms)`);
  const loginLat = [];
  let logins = 0, loginErr = 0;
  const loginDeadline = Date.now() + LOGIN_MS;
  const loginWorker = async () => {
    while (Date.now() < loginDeadline) {
      const n = names[Math.floor((logins + loginErr) % USERS)];
      const t0 = performance.now();
      try { await login(n); loginLat.push(performance.now() - t0); logins++; }
      catch { loginErr++; }
    }
  };
  const loginReport = setInterval(() => {
    console.log(`  [login] done=${logins} err=${loginErr} avg=${(loginLat.reduce((a, b) => a + b, 0) / (loginLat.length || 1)).toFixed(0)}ms p95=${pct(loginLat, 0.95).toFixed(0)}ms`);
  }, 5_000);
  await Promise.all(Array.from({ length: LOGIN_CONCURRENCY }, loginWorker));
  clearInterval(loginReport);
  console.log(`PHASE 1 END    ${now()}`);
  console.log(`  → logins=${logins} err=${loginErr} avg=${(loginLat.reduce((a, b) => a + b, 0) / (loginLat.length || 1)).toFixed(0)}ms p50=${pct(loginLat, 0.5).toFixed(0)}ms p95=${pct(loginLat, 0.95).toFixed(0)}ms max=${Math.max(0, ...loginLat).toFixed(0)}ms\n`);

  // brief gap so the two phases are visually separable in Grafana
  await new Promise((r) => setTimeout(r, 5_000));

  // ── Phase 2: MESSAGE STORM ──────────────────────────────────────────────────
  console.log(`================ PHASE 2: MESSAGE STORM ================`);
  console.log(`PHASE 2 START  ${now()}   (${USERS} conns, every ${SEND_INTERVAL_MS}ms, ${MSG_MS}ms)`);
  const sockets = [], timers = [];
  let connected = 0, sent = 0, acked = 0, received = 0, wsErr = 0;
  for (const n of names) {
    const ws = new WebSocket(`${WS}/ws/chat?token=${encodeURIComponent(tokens[n])}`);
    sockets.push(ws);
    let seq = 0;
    ws.on('open', () => {
      connected++;
      timers.push(setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'send', request_id: `${n}:${seq++}:${process.hrtime.bigint()}`, chat_id: chat.id, body: `msg ${seq}` }));
        sent++;
      }, SEND_INTERVAL_MS));
    });
    ws.on('message', (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      if (f.type === 'ack') acked++; else if (f.type === 'msg') received++; else if (f.type === 'error') wsErr++;
    });
    ws.on('error', () => { wsErr++; });
  }
  const msgReport = setInterval(() => {
    console.log(`  [msg] conn=${connected} sent=${sent} ack=${acked} recv=${received} err=${wsErr}`);
  }, 5_000);
  await new Promise((r) => setTimeout(r, MSG_MS));
  clearInterval(msgReport);
  timers.forEach(clearInterval);
  sockets.forEach((ws) => ws.close());
  await new Promise((r) => setTimeout(r, 1_000));
  console.log(`PHASE 2 END    ${now()}`);
  console.log(`  → connected=${connected}/${USERS} sent=${sent} acked=${acked} received=${received} errors=${wsErr}\n`);

  console.log(`================ SUMMARY ================`);
  console.log(`Phase 1 (login):    frame Grafana to the PHASE 1 window → expect bcrypt (auth.service:login) + user-lookup DB`);
  console.log(`Phase 2 (messaging):frame Grafana to the PHASE 2 window → expect ws socket writev (fanout) + createMessage DB writes`);
  process.exit(0);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
