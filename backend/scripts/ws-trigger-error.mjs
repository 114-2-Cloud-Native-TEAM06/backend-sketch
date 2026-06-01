/**
 * Deliberately trigger a WebSocket error so the `im_ws_errors_total` metric
 * (and the "WebSocket errors / sec" dashboard panel) gets a data point.
 *
 * It connects as a fresh user and sends a message to a chat the user is NOT a
 * member of → the server's createMessage throws an AppError → wsErrorsTotal++.
 *
 *   docker compose exec app node scripts/ws-trigger-error.mjs
 */
import WebSocket from 'ws';

const API = process.env.API_URL ?? 'http://localhost:8080/api/v1';
const WS = process.env.WS_URL ?? 'ws://localhost:8081';
const USERNAME = 'err_tester';
const PASSWORD = 'errtest123';
const COUNT = Number(process.env.COUNT ?? 5); // how many error messages to send

async function main() {
  const email = `${USERNAME}@err.test`;
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, email, password: PASSWORD, display_name: USERNAME }),
  }).catch(() => {});
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const { token } = await login.json();

  const ws = new WebSocket(`${WS}/ws/chat?token=${encodeURIComponent(token)}`);
  let replies = 0;

  ws.on('open', () => {
    console.log(`connected — sending ${COUNT} messages to a chat we are NOT in...`);
    for (let i = 0; i < COUNT; i++) {
      ws.send(JSON.stringify({
        type: 'send',
        request_id: `err-${i}-${Date.now()}`,
        chat_id: '00000000-0000-0000-0000-000000000000', // not a member → server errors
        body: 'trigger error',
      }));
    }
  });

  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    console.log('server replied:', JSON.stringify(frame));
    if (frame.type === 'error' && ++replies >= COUNT) {
      ws.close();
      console.log(`\nDone — ${replies} errors triggered. Check the "WebSocket errors / sec" panel.`);
      process.exit(0);
    }
  });

  ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
  setTimeout(() => { console.log('timeout'); process.exit(0); }, 10_000);
}

main().catch((err) => { console.error('[fatal]', err); process.exit(1); });
