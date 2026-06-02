#!/usr/bin/env sh
set -eu

USER_STEPS="${USER_STEPS:-100 200 500 1000 1500 2000 3000 5000}"
DURATION="${DURATION:-1m}"
SOCKET_HOLD_MS="${SOCKET_HOLD_MS:-60000}"
PING_INTERVAL_MS="${PING_INTERVAL_MS:-15000}"
USER_API_BASE="${USER_API_BASE:-${API_BASE:-http://host.docker.internal:8082}}"
WS_BASE="${WS_BASE:-ws://host.docker.internal:8081}"
REPORT_DIR="${REPORT_DIR:-load/reports}"
RUN_PREFIX="${RUN_PREFIX:-oc$(date +%H%M%S)}"
CONNECT_SUCCESS_MIN="${CONNECT_SUCCESS_MIN:-99}"
UNEXPECTED_CLOSE_MAX="${UNEXPECTED_CLOSE_MAX:-0}"
PONG_SUCCESS_MIN="${PONG_SUCCESS_MIN:-95}"
PONG_P95_MAX="${PONG_P95_MAX:-1}"

mkdir -p "$REPORT_DIR"

CSV="$REPORT_DIR/online-ceiling-${RUN_PREFIX}.csv"
TXT="$REPORT_DIR/online-ceiling-${RUN_PREFIX}.txt"

cat > "$CSV" <<'EOF'
run_id,target_users,ws_connect_attempts,ws_connected,connect_success_rate_percent,unexpected_close,ping_sent,pong_received,pong_success_rate_percent,pong_p95_seconds,stable
EOF

cat > "$TXT" <<EOF
WebSocket online ceiling run: ${RUN_PREFIX}

Stable criteria:
- connect_success_rate_percent >= ${CONNECT_SUCCESS_MIN}
- unexpected_close <= ${UNEXPECTED_CLOSE_MAX}
- pong_success_rate_percent >= ${PONG_SUCCESS_MIN}
- pong_p95_seconds <= ${PONG_P95_MAX}

EOF

echo "Starting online ceiling test: ${RUN_PREFIX}"
echo "User steps: ${USER_STEPS}"
echo "Reports: ${REPORT_DIR}"

for users in $USER_STEPS; do
  run_id="${RUN_PREFIX}-u${users}"

  echo ""
  echo "=== users=${users}, run_id=${run_id} ==="

  docker run --rm \
    -v "$PWD/load:/scripts" \
    grafana/k6 run \
    -e USER_API_BASE="$USER_API_BASE" \
    -e WS_BASE="$WS_BASE" \
    -e USERS="$users" \
    -e DURATION="$DURATION" \
    -e SOCKET_HOLD_MS="$SOCKET_HOLD_MS" \
    -e PING_INTERVAL_MS="$PING_INTERVAL_MS" \
    -e RUN_ID="$run_id" \
    -e REPORT_DIR=/scripts/reports \
    /scripts/ws-online-load.js

  report_json="$REPORT_DIR/ws-online-load-${run_id}.json"
  if [ ! -f "$report_json" ]; then
    echo "Report not found: $report_json" >&2
    exit 1
  fi

  row="$(node - "$report_json" "$CONNECT_SUCCESS_MIN" "$UNEXPECTED_CLOSE_MAX" "$PONG_SUCCESS_MIN" "$PONG_P95_MAX" <<'NODE'
const fs = require('fs');
const [reportPath, connectSuccessMin, unexpectedCloseMax, pongSuccessMin, pongP95Max] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const stable =
  Number(report.websocket_connect_success_rate_percent || 0) >= Number(connectSuccessMin) &&
  Number(report.ws_unexpected_close || 0) <= Number(unexpectedCloseMax) &&
  Number(report.pong_success_rate_percent || 0) >= Number(pongSuccessMin) &&
  Number(report.pong_p95_seconds || 0) <= Number(pongP95Max);
const fields = [
  report.run_id,
  report.target_users,
  report.ws_connect_attempts,
  report.ws_connected,
  report.websocket_connect_success_rate_percent,
  report.ws_unexpected_close,
  report.ping_sent,
  report.pong_received,
  report.pong_success_rate_percent,
  report.pong_p95_seconds,
  stable ? 'yes' : 'no',
];
console.log(fields.join(','));
NODE
)"

  echo "$row" >> "$CSV"

  IFS=',' read -r run_id_out users_out attempts_out connected_out connect_rate_out unexpected_out ping_out pong_out pong_rate_out pong_p95_out stable_out <<EOF_ROW
$row
EOF_ROW

  cat >> "$TXT" <<EOF
run_id=${run_id_out}
target_users=${users_out}
attempts=${attempts_out} connected=${connected_out} connect_success=${connect_rate_out}%
unexpected_close=${unexpected_out}
ping_sent=${ping_out} pong_received=${pong_out} pong_success=${pong_rate_out}% pong_p95=${pong_p95_out}s
stable=${stable_out}

EOF

  echo "Result: users=${users_out}, connected=${connected_out}, connect=${connect_rate_out}%, unexpected=${unexpected_out}, pong=${pong_rate_out}%, pong_p95=${pong_p95_out}s, stable=${stable_out}"

  if [ "$stable_out" = "no" ]; then
    echo "Stop: users ${users} failed stable criteria."
    break
  fi
done

echo ""
echo "Online ceiling summary written to:"
echo "$CSV"
echo "$TXT"
echo ""
echo "Highest stable online users:"
awk -F, 'NR > 1 && $11 == "yes" { row=$0 } END { if (row) print row; else print "none" }' "$CSV"

