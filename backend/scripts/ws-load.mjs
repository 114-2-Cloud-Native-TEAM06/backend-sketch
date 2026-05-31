/**
 * WebSocket load generator — lights up the WS observability signals
 * (im_ws_active_connections, im_messages_sent_total, im_message_fanout_duration,
 *  im_ws_errors_total, and the im.message.receive spans).
 *
 * Run INSIDE the app container (has `ws` + Node 20), talking to the local servers:
 *   docker compose exec app node scripts/ws-load.mjs
 *
 * Tunables (env):
 *   CONNECTIONS      number of concurrent WS clients / users   (default 30)
 *   DURATION_MS      how long to keep sending                  (default 30000)
 *   SEND_INTERVAL_MS per-client gap between messages           (default 500)
 *   API_URL          REST base                                 (default http://localhost:8080/api/v1)
 *   WS_URL           WS base                                   (default ws://localhost:8081)
 *
 * Crank it up:  CONNECTIONS=80 SEND_INTERVAL_MS=200 DURATION_MS=60000 \
 *               docker compose exec app node scripts/ws-load.mjs
 */
import WebSocket from 'ws';

const API = process.env.API_URL ?? 'http://localhost:8080/api/v1';
const WS = process.env.WS_URL ?? 'ws://localhost:8081';
const N = Math.max(2, Number(process.env.CONNECTIONS ?? 30));
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS ?? 500);
const PASSWORD = 'loadtest123';

const stats = { connected: 0, sent: 0, acked: 0, received: 0, errors: 0, closed: 0 };

async function registerAndLogin(username) {
  const email = `${username}@load.test`;
  // Register is best-effort: a 409 (already exists) just means we log in below.
  await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email, password: PASSWORD, display_name: username }),
  }).catch(() => {});

  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`);
  const { token, user } = await res.json();
  return { username, token, userId: user.id };
}

async function main() {
  console.log(`[setup] ${N} users → group chat → WS load for ${DURATION_MS}ms @ ${SEND_INTERVAL_MS}ms/client`);

  const users = [];
  for (let i = 0; i < N; i++) {
    users.push(await registerAndLogin(`load_u${i}`));
  }
  console.log(`[setup] ${users.length} users ready`);

  // One group chat with everyone in it, so every send fans out to N-1 sockets.
  const owner = users[0];
  const createRes = await fetch(`${API}/chats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ type: 'group', name: 'loadtest', member_ids: users.slice(1).map((u) => u.username) }),
  });
  if (!createRes.ok) throw new Error(`group chat create failed: ${createRes.status} ${await createRes.text()}`);
  const chat = await createRes.json();
  console.log(`[setup] group chat ${chat.id} with ${chat.member_ids.length} members`);

  const sockets = [];
  const timers = [];

  for (const user of users) {
    const ws = new WebSocket(`${WS}/ws/chat?token=${encodeURIComponent(user.token)}`);
    sockets.push(ws);
    let seq = 0;

    ws.on('open', () => {
      stats.connected++;
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: 'send',
          request_id: `${user.username}:${seq++}:${process.hrtime.bigint()}`,
          chat_id: chat.id,
          body: `hello from ${user.username} #${seq}`,
        }));
        stats.sent++;
      }, SEND_INTERVAL_MS);
      timers.push(timer);
    });

    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.type === 'ack') stats.acked++;
      else if (frame.type === 'msg') stats.received++;
      else if (frame.type === 'error') stats.errors++;
    });

    ws.on('error', () => { stats.errors++; });
    ws.on('close', () => { stats.closed++; });
  }

  const report = setInterval(() => {
    console.log(`[stats] conn=${stats.connected} sent=${stats.sent} ack=${stats.acked} recv=${stats.received} err=${stats.errors}`);
  }, 5_000);

  await new Promise((r) => setTimeout(r, DURATION_MS));

  clearInterval(report);
  timers.forEach(clearInterval);
  sockets.forEach((ws) => ws.close());
  await new Promise((r) => setTimeout(r, 1_000));

  console.log('\n=== WS load summary ===');
  console.log(JSON.stringify({ ...stats, users: N, durationMs: DURATION_MS }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
