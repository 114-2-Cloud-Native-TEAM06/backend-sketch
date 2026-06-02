const fs = require('fs');
const path = require('path');

const reportDir = process.env.REPORT_DIR || 'load/reports';
const runPrefix = process.env.RUN_PREFIX;
const onlinePrefix = process.env.ONLINE_PREFIX || `${runPrefix}-online`;
const throughputRunId = process.env.THROUGHPUT_RUN_ID || `${runPrefix}-1000u1mps`;
const throughputUsers = Number(process.env.THROUGHPUT_USERS || 1000);
const throughputIntervalMs = Number(process.env.THROUGHPUT_SEND_INTERVAL_MS || 1000);
const ackErrorMax = Number(process.env.ACK_ERROR_MAX || 1);
const ackP95Max = Number(process.env.ACK_P95_MAX || 1);
const dbRatioMin = Number(process.env.DB_RATIO_MIN || 98);
const connectSuccessMin = Number(process.env.CONNECT_SUCCESS_MIN || 99);
const unexpectedCloseMax = Number(process.env.UNEXPECTED_CLOSE_MAX || 0);
const pongSuccessMin = Number(process.env.PONG_SUCCESS_MIN || 95);
const pongP95Max = Number(process.env.PONG_P95_MAX || 1);
const dbCountRaw = process.env.DB_COUNT;

if (!runPrefix) {
  console.error('RUN_PREFIX is required');
  process.exit(1);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function onlineReportsFromCsv() {
  const csvPath = path.join(reportDir, `online-ceiling-${onlinePrefix}.csv`);
  if (!fs.existsSync(csvPath)) return [];

  return fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((row) => {
    const cols = row.split(',');
    return {
      target_users: Number(cols[1]),
      websocket_connect_success_rate_percent: Number(cols[4]),
      ws_unexpected_close: Number(cols[5]),
      pong_success_rate_percent: Number(cols[8]),
      pong_p95_seconds: Number(cols[9]),
      stable: cols[10],
      source: `online-ceiling-${onlinePrefix}.csv`,
    };
  });
}

function onlineReportsFromSingleRuns() {
  if (!fs.existsSync(reportDir)) return [];

  return fs.readdirSync(reportDir)
    .filter((name) => name.startsWith(`ws-online-load-${onlinePrefix}-u`) && name.endsWith('.json'))
    .filter((name) => !name.endsWith('.k6-summary.json'))
    .map((name) => {
      const report = readJsonIfExists(path.join(reportDir, name));
      if (!report) return null;
      const stable =
        Number(report.websocket_connect_success_rate_percent || 0) >= connectSuccessMin &&
        Number(report.ws_unexpected_close || 0) <= unexpectedCloseMax &&
        Number(report.pong_success_rate_percent || 0) >= pongSuccessMin &&
        Number(report.pong_p95_seconds || 0) <= pongP95Max;
      return { ...report, stable: stable ? 'yes' : 'no', source: name };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.target_users || 0) - Number(b.target_users || 0));
}

const onlineReports = onlineReportsFromCsv();
const onlineRows = onlineReports.length > 0 ? onlineReports : onlineReportsFromSingleRuns();
const stableOnlineRows = onlineRows.filter((row) => row.stable === 'yes');
const highestOnline = stableOnlineRows.at(-1);
const onlineTable = onlineRows.map((row) => {
  return `| ${row.target_users} | ${row.websocket_connect_success_rate_percent}% | ${row.ws_unexpected_close} | ${row.pong_success_rate_percent}% | ${row.pong_p95_seconds}s | ${row.stable} | ${row.source} |`;
}).join('\n');

const throughputJson = path.join(reportDir, `ws-chat-load-${throughputRunId}.json`);
const throughput = readJsonIfExists(throughputJson);
let throughputMarkdown = 'Throughput benchmark did not produce a `ws-chat-load` JSON report yet.';
let throughputStable = false;
let throughputConclusion = 'not run yet';

if (throughput) {
  const sent = Number(throughput.messages_sent || 0);
  const dbCount = dbCountRaw === undefined ? null : Number(dbCountRaw || 0);
  const dbRatio = dbCount === null ? null : sent > 0 ? (dbCount / sent) * 100 : 0;
  const theoretical = throughputUsers * 1000 / throughputIntervalMs;
  throughputStable =
    Number(throughput.ack_error_rate_percent || 0) <= ackErrorMax &&
    Number(throughput.ack_p95_seconds || 0) <= ackP95Max &&
    dbRatio !== null &&
    dbRatio >= dbRatioMin;

  const throughputIssues = [];
  if (Number(throughput.ack_error_rate_percent || 0) > ackErrorMax) {
    throughputIssues.push(`ack error rate ${throughput.ack_error_rate_percent}% > ${ackErrorMax}%`);
  }
  if (Number(throughput.ack_p95_seconds || 0) > ackP95Max) {
    throughputIssues.push(`ack p95 ${throughput.ack_p95_seconds}s > ${ackP95Max}s`);
  }
  if (dbRatio === null) {
    throughputIssues.push('DB persisted ratio was not checked');
  } else if (dbRatio < dbRatioMin) {
    throughputIssues.push(`DB persisted ratio ${dbRatio.toFixed(2)}% < ${dbRatioMin}%`);
  }
  throughputConclusion = throughputStable ? 'passed' : `not passed (${throughputIssues.join('; ')})`;

  throughputMarkdown = `| Metric | Value |
|---|---:|
| Target users | ${throughputUsers} |
| Per-user send interval | ${throughputIntervalMs}ms |
| Theoretical target | ${theoretical.toFixed(0)} msg/sec |
| Actual average send rate | ${throughput.average_send_rate_msg_per_sec} msg/sec |
| Messages sent | ${sent} |
| Ack p95 | ${throughput.ack_p95_seconds}s |
| Ack error rate | ${throughput.ack_error_rate_percent}% |
| WS error frames | ${throughput.ws_error_frames} |
| Backpressure skipped sends | ${throughput.backpressure_skipped_sends} |
| DB message count | ${dbCount === null ? 'not checked yet' : dbCount} |
| DB persisted ratio | ${dbRatio === null ? 'not checked yet' : `${dbRatio.toFixed(2)}%`} |
| Stable | ${throughputStable ? 'yes' : 'no'} |`;
}

const summaryPath = path.join(reportDir, `evaluation-criteria-benchmark-${runPrefix}.md`);
const completeness = throughput ? 'complete or post-throughput' : 'partial online-only';
const scalabilityStatus = throughput && onlineRows.length > 0
  ? 'Measured in this report'
  : throughput || onlineRows.length > 0
    ? 'Partially measured in this report'
    : 'Not measured yet';
const throughputReportFiles = throughput
  ? `- \`ws-chat-load-${throughputRunId}.txt\`
- \`ws-chat-load-${throughputRunId}.json\`
- \`ws-chat-load-${throughputRunId}.k6-summary.json\``
  : '- Throughput report not produced yet.';
const onlineSourceFiles = onlineRows.length > 0
  ? onlineRows.map((row) => `- \`${row.source}\``).join('\n')
  : '- Online report not produced yet.';

const markdown = `# Evaluation Criteria Benchmark - ${runPrefix}

Status: ${completeness}

## Evaluation Criteria Mapping

| Weight | Category | Benchmark Evidence | Status |
|---:|---|---|---|
| 30% | 需求轉換與實作 | REST/WebSocket feature checklist, health checks, manual UI/RWD demo evidence | Supporting evidence required |
| 10% | 程式碼品質 | Modular multi-service codebase, tests, version-controlled scripts, security-sensitive auth validation | Supporting evidence required |
| 25% | 架構設計與可擴展性 | Concurrent online ceiling and 1,000 users x 1 msg/sec k6 benchmark | ${scalabilityStatus} |
| 25% | 系統測試與驗證 | Unit tests, integration tests, k6 load reports, DB persistence validation | Supporting evidence required |
| 10% | 運維與可靠性 | Docker health checks, REST /health endpoints, runtime load metrics, threshold explanations | Supporting evidence required |

## 30% 需求轉換與實作

This benchmark report does not replace the product demo or UI/RWD review. Use it as supporting evidence that the implemented backend can run the required messaging flows under load.

Evidence to present:

- Auth/user APIs: register, login, profile, user lookup.
- Chat APIs: create direct chat, create group chat, list chats, read message history.
- WebSocket frames: send, ack, message, typing, presence, ping/pong, error.
- Advanced requirements: message notification through real-time frames, group chat support, online presence.
- UI/RWD evidence should come from frontend screenshots or demo steps, because k6 only validates backend behavior.

## 10% 程式碼品質

Evidence to present:

- Version control contains benchmark scripts and optimization notes.
- Services are split by responsibility: user, chat, realtime, notification, message writer.
- Input validation and auth checks are covered by unit/integration tests.
- Load-test scripts use explicit thresholds and JSON/Markdown outputs instead of manual screenshots only.
- Security-sensitive evidence should include JWT auth validation and no known hardcoded production secret usage.

## 25% 架構設計與可擴展性

Target:

- Handle large concurrent-online WebSocket usage.
- Support roughly 1,000 users, each sending one message per second.

Pass criteria:

| Area | Metric | Threshold |
|---|---:|---:|
| Concurrent online users | connect success rate | >= ${connectSuccessMin}% |
| Concurrent online users | unexpected close | <= ${unexpectedCloseMax} |
| Concurrent online users | pong success rate | >= ${pongSuccessMin}% |
| Concurrent online users | pong p95 | <= ${pongP95Max}s |
| 1,000 users x 1 msg/sec | ack error rate | <= ${ackErrorMax}% |
| 1,000 users x 1 msg/sec | ack p95 | <= ${ackP95Max}s |
| 1,000 users x 1 msg/sec | DB persisted ratio | >= ${dbRatioMin}% |

### Online Ceiling Result

| Target users | Connect success | Unexpected close | Pong success | Pong p95 | Stable | Source |
|---:|---:|---:|---:|---:|---|---|
${onlineTable || '| none | none | none | none | none | no | none |'}

Highest stable online users: ${highestOnline ? highestOnline.target_users : 'none'}

### Throughput Result

${throughputMarkdown}

Architecture/scalability conclusion:

- Online scalability: ${highestOnline ? `stable up to ${highestOnline.target_users} concurrent users in this run` : 'no stable online step in this run'}.
- 1,000 users x 1 msg/sec: ${throughputConclusion}.
- If a row has 0 connection attempts, k6 failed during setup before opening WebSocket connections; do not interpret it as a WebSocket capacity result.

## 25% 系統測試與驗證

Recommended verification commands:

\`\`\`bash
docker compose --profile test run --rm test npm run test:unit
docker compose --profile test run --rm test sh -c "npx prisma generate && npx prisma migrate deploy && npm run test:integration"
docker compose config --quiet
\`\`\`

Benchmark artifacts:

Online reports:

${onlineSourceFiles}

Throughput reports:

${throughputReportFiles}

DB persistence check:

\`\`\`bash
docker compose exec postgres psql -U admin -d imdb -c \\
  "SELECT count(*) FROM \\"Message\\" WHERE \\"requestId\\" LIKE 'k6-${throughputRunId}-%';"
\`\`\`

## 10% 運維與可靠性

Health indicators:

- \`chat-service\`: \`GET /health\` on port 8080.
- \`user-service\`: \`GET /health\` on port 8082.
- \`notification-service\`: \`GET /health\` on port 8083.
- Docker Compose health checks for PostgreSQL, Redis, NATS, chat-service, user-service, notification-service.

Runtime/load indicators:

- WebSocket connect success rate.
- Unexpected WebSocket closes.
- Ping/pong success rate and p95 latency.
- Ack p95 and ack error rate.
- DB persisted ratio.
- Realtime and message-writer load metrics in service logs.

Operational interpretation:

- Online passes but throughput fails: WebSocket connection layer is healthy; inspect message persistence, NATS, and PostgreSQL.
- High ack p95: inspect message-writer backlog, Prisma connection pool, DB CPU/I/O, and NATS publish latency.
- Low DB persisted ratio: inspect message-writer durability, outbox drain, and delayed writes after the k6 run ends.
`;

fs.writeFileSync(summaryPath, markdown);
console.log(`Benchmark markdown written to: ${summaryPath}`);
