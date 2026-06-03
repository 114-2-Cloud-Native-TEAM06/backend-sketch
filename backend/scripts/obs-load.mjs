/**
 * Observability load generator — exercises every microservice so the Grafana
 * Cloud dashboards (traces / metrics / logs / profiles) have rich data.
 *
 *   register/login  → user-service
 *   create group    → chat-service
 *   WS + send        → realtime-service (+ fanout)
 *   message persist  → message-writer-service (via NATS) + DB metrics
 *
 * Run inside a backend container (has node + the `ws` dep), targeting the
 * INTERNAL service addresses (reliable, no public hairpin):
 *
 *   docker compose exec chat-service node scripts/obs-load.mjs
 *
 * Tunables (-e / env): USERS (20) | DURATION_MS (60000) | SEND_INTERVAL_MS (1000)
 * To drive external traffic through Caddy instead, override the *_API / WS_URL.
 */
import WebSocket from 'ws';

const USER_API = process.env.USER_API ?? 'http://user-service:8082/api/v1';
const CHAT_API = process.env.CHAT_API ?? 'http://chat-service:8080/api/v1';
// Connect straight to a realtime instance (not the gateway) so the load
// generator never depends on the nginx gateway's health.
const WS_URL = process.env.WS_URL ?? 'ws://realtime-service-1:8081/ws/chat';
const USERS = Number(process.env.USERS ?? 20);
const DURATION_MS = Number(process.env.DURATION_MS ?? 60_000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 1_000);
const PASSWORD = 'obsload123';

async function register(username) {
  await fetch(`${USER_API}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@obs.test`, password: PASSWORD, display_name: username }),
  }).catch(() => {});
}

async function login(username) {
  const r = await fetch(`${USER_API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${username}@obs.test`, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (await r.json()).token;
}

async function main() {
  const names = Array.from({ length: USERS }, (_, i) => `obs_u${i}`);
  console.log(`[setup] register + login ${USERS} users (user-service)...`);
  const tokens = {};
  for (const n of names) { await register(n); tokens[n] = await login(n); }

  const owner = names[0];
  const res = await fetch(`${CHAT_API}/chats`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[owner]}` },
    body: JSON.stringify({ type: 'group', name: 'obs-load', member_ids: names.slice(1) }),
  });
  if (!res.ok) throw new Error(`group create (chat-service): ${res.status} ${await res.text()}`);
  const chat = await res.json();
  console.log(`[setup] group chat ${chat.id} with ${chat.member_ids.length} members\n`);

  const stats = { sent: 0, ack: 0, recv: 0, err: 0 };
  const sockets = [], timers = [];
  for (const n of names) {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(tokens[n])}`);
    sockets.push(ws);
    let seq = 0;
    ws.on('open', () => {
      timers.push(setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'send', request_id: `${n}:${seq++}:${process.hrtime.bigint()}`, chat_id: chat.id, body: `obs ${seq}` }));
        stats.sent++;
      }, SEND_INTERVAL_MS));
    });
    ws.on('message', (d) => {
      try { const f = JSON.parse(d.toString()); if (f.type === 'ack') stats.ack++; else if (f.type === 'msg') stats.recv++; else if (f.type === 'error') stats.err++; } catch { /* ignore */ }
    });
    ws.on('error', () => { stats.err++; });
  }

  console.log(`[run] ${USERS} WS clients sending every ${SEND_INTERVAL_MS}ms for ${DURATION_MS}ms`);
  const report = setInterval(() => console.log(`[stats] sent=${stats.sent} ack=${stats.ack} recv=${stats.recv} err=${stats.err}`), 5_000);
  await new Promise((r) => setTimeout(r, DURATION_MS));
  clearInterval(report);
  timers.forEach(clearInterval);
  sockets.forEach((ws) => ws.close());
  await new Promise((r) => setTimeout(r, 1_000));
  console.log('\n=== done ===', JSON.stringify(stats));
  process.exit(0);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
