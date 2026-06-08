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
const markdown = `# Evaluation Criteria Benchmark - ${runPrefix}

Status: ${completeness}

## Target

This benchmark maps to the evaluation item: architecture scalability under tens of thousands of concurrent online users, plus roughly 1,000 users sending one message per second.

## Pass Criteria

| Area | Metric | Threshold |
|---|---:|---:|
| Concurrent online users | connect success rate | >= ${connectSuccessMin}% |
| Concurrent online users | unexpected close | <= ${unexpectedCloseMax} |
| Concurrent online users | pong success rate | >= ${pongSuccessMin}% |
| Concurrent online users | pong p95 | <= ${pongP95Max}s |
| 1,000 users x 1 msg/sec | ack error rate | <= ${ackErrorMax}% |
| 1,000 users x 1 msg/sec | ack p95 | <= ${ackP95Max}s |
| 1,000 users x 1 msg/sec | DB persisted ratio | >= ${dbRatioMin}% |

## Online Ceiling Result

| Target users | Connect success | Unexpected close | Pong success | Pong p95 | Stable | Source |
|---:|---:|---:|---:|---:|---|---|
${onlineTable || '| none | none | none | none | none | no | none |'}

Highest stable online users: ${highestOnline ? highestOnline.target_users : 'none'}

## Throughput Result

${throughputMarkdown}

## Conclusion

- Online scalability: ${highestOnline ? `stable up to ${highestOnline.target_users} concurrent users in this run` : 'no stable online step in this run'}.
- 1,000 users x 1 msg/sec: ${throughputConclusion}.
- If a row has 0 connection attempts, k6 failed during setup before opening WebSocket connections; do not interpret it as a WebSocket capacity result.
`;

fs.writeFileSync(summaryPath, markdown);
console.log(`Benchmark markdown written to: ${summaryPath}`);
