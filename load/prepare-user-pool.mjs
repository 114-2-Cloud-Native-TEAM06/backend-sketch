#!/usr/bin/env node
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const poolType = process.env.POOL_TYPE || 'active';
const userPoolId = process.env.USER_POOL_ID || (poolType === 'active' ? 'pool-active1500' : 'pool-idle8500');
const users = Number(process.env.USERS || (poolType === 'active' ? 1500 : 8500));
const password = process.env.PASSWORD || 'password123';
const userApiBase = process.env.USER_API_BASE || 'http://localhost:8082';
const chatApiBase = process.env.CHAT_API_BASE || 'http://localhost:8080';
const concurrency = Number(process.env.PREPARE_CONCURRENCY || 25);
const outputFile = process.env.OUTPUT_FILE || defaultOutputFile(poolType, userPoolId);
const usernamePrefix = sanitizedPoolId(userPoolId);

if (!['active', 'idle'].includes(poolType)) {
  throw new Error('POOL_TYPE must be "active" or "idle"');
}

if (!Number.isInteger(users) || users < 1) {
  throw new Error('USERS must be a positive integer');
}

if (poolType === 'active' && users % 2 !== 0) {
  throw new Error('USERS must be even for active direct-room pairing');
}

await waitForHealth(userApiBase, 'user API');
if (poolType === 'active') await waitForHealth(chatApiBase, 'chat API');

console.log(`Preparing ${poolType} pool ${userPoolId}: users=${users}, concurrency=${concurrency}`);

const preparedUsers = await mapWithConcurrency(
  Array.from({ length: users }, (_, index) => index),
  concurrency,
  async (index) => {
    const user = await registerOrLogin(index);
    if ((index + 1) % 100 === 0 || index + 1 === users) {
      console.log(`users prepared: ${index + 1}/${users}`);
    }
    return user;
  },
);

const rooms = [];
if (poolType === 'active') {
  const pairIndexes = Array.from({ length: users / 2 }, (_, pairIndex) => pairIndex * 2);
  const roomIds = await mapWithConcurrency(pairIndexes, concurrency, async (index) => {
    const roomId = await createDirectRoom(preparedUsers[index], preparedUsers[index + 1]);
    preparedUsers[index].roomId = roomId;
    preparedUsers[index + 1].roomId = roomId;
    if ((index + 2) % 200 === 0 || index + 2 === users) {
      console.log(`direct-room users paired: ${index + 2}/${users}`);
    }
    return roomId;
  });
  rooms.push(...roomIds);
}

const fixture = {
  schema_version: 1,
  type: poolType === 'active' ? 'chat' : 'online',
  user_pool_id: userPoolId,
  target_users: users,
  generated_at: new Date().toISOString(),
  token_ttl_hint: 'JWT tokens expire 7 days after prepare; rerun this script to refresh them.',
  user_api_base: userApiBase,
  chat_api_base: poolType === 'active' ? chatApiBase : undefined,
  rooms: poolType === 'active' ? rooms : undefined,
};

fixture.users = preparedUsers.map((user) => ({
  token: user.token,
  userId: user.user.id,
  username: user.username,
  ...(user.roomId ? { roomId: user.roomId } : {}),
}));

await writeJsonAtomic(outputFile, fixture);
console.log(`Wrote ${outputFile}`);

function defaultOutputFile(type, poolId) {
  const name = type === 'active' ? 'ws-chat' : 'ws-online';
  return path.join('load', 'fixtures', `${name}-${poolId}.json`);
}

function sanitizedPoolId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'local';
}

function usernameFor(index) {
  const prefix = poolType === 'active' ? 'k6' : 'on';
  return `${prefix}_${usernamePrefix}_${index}`.slice(0, 32);
}

async function registerOrLogin(index) {
  const username = usernameFor(index);
  const email = `${username}@example.com`;
  const payload = {
    username,
    email,
    password,
    display_name: poolType === 'active' ? `K6 User ${index}` : `Online User ${index}`,
  };

  const registerRes = await postJson(userApiBase, '/api/v1/auth/register', payload);
  if (registerRes.status === 201) {
    const body = await registerRes.json();
    return { token: body.token, user: body.user, username };
  }

  if (registerRes.status === 409) {
    const loginRes = await postJson(userApiBase, '/api/v1/auth/login', { email, password });
    if (loginRes.status === 200) {
      const body = await loginRes.json();
      return { token: body.token, user: body.user, username };
    }
    throw new Error(`login failed for ${username}: ${await describeHttpFailure(loginRes)}`);
  }

  throw new Error(`register failed for ${username}: ${await describeHttpFailure(registerRes)}`);
}

async function createDirectRoom(owner, target) {
  const res = await postJson(chatApiBase, '/api/v1/chats', {
    type: 'direct',
    member_ids: [target.username],
  }, owner.token);

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`create room failed for ${owner.username}/${target.username}: ${await describeHttpFailure(res)}`);
  }

  return (await res.json()).id;
}

async function postJson(baseUrl, route, body, token) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitForHealth(baseUrl, label) {
  const deadline = Date.now() + Number(process.env.API_HEALTH_TIMEOUT_SECONDS || 60) * 1000;
  let lastError = 'not checked';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) return;
      lastError = `${res.status} ${await res.text()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(1000);
  }

  throw new Error(`${label} health check failed for ${baseUrl}: ${lastError}`);
}

async function describeHttpFailure(res) {
  const text = await res.text();
  return `status=${res.status} body=${text.slice(0, 300) || '<empty>'}`;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
