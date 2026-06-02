#!/usr/bin/env sh
set -eu

INTERVALS="${INTERVALS:-100 90 80 70 60 50 40 30}"
USERS="${USERS:-100}"
DURATION="${DURATION:-2m}"
SOCKET_LIFE_MS="${SOCKET_LIFE_MS:-60000}"
MAX_PENDING_ACKS="${MAX_PENDING_ACKS:-1000}"
USER_API_BASE="${USER_API_BASE:-${API_BASE:-http://host.docker.internal:8082}}"
CHAT_API_BASE="${CHAT_API_BASE:-${API_BASE:-http://host.docker.internal:8080}}"
WS_BASE="${WS_BASE:-ws://host.docker.internal:8081}"
REPORT_DIR="${REPORT_DIR:-load/reports}"
RUN_PREFIX="${RUN_PREFIX:-tc$(date +%H%M%S)}"
ACK_ERROR_MAX="${ACK_ERROR_MAX:-1}"
ACK_P95_MAX="${ACK_P95_MAX:-1}"
DB_RATIO_MIN="${DB_RATIO_MIN:-98}"

mkdir -p "$REPORT_DIR"

CSV="$REPORT_DIR/throughput-ceiling-${RUN_PREFIX}.csv"
TXT="$REPORT_DIR/throughput-ceiling-${RUN_PREFIX}.txt"

cat > "$CSV" <<'EOF'
run_id,interval_ms,theoretical_msg_per_sec,messages_sent,average_send_rate_msg_per_sec,ack_p95_seconds,ack_error_rate_percent,db_message_count,db_ratio_percent,ws_error_frames,backpressure_skipped_sends,stable
EOF

cat > "$TXT" <<EOF
WebSocket throughput ceiling run: ${RUN_PREFIX}

Stable criteria:
- ack_error_rate_percent <= ${ACK_ERROR_MAX}
- ack_p95_seconds <= ${ACK_P95_MAX}
- db_ratio_percent >= ${DB_RATIO_MIN}

EOF

echo "Starting throughput ceiling test: ${RUN_PREFIX}"
echo "Intervals: ${INTERVALS}"
echo "Reports: ${REPORT_DIR}"

for interval in $INTERVALS; do
  run_id="${RUN_PREFIX}-i${interval}"
  theoretical=$((USERS * 1000 / interval))

  echo ""
  echo "=== interval=${interval}ms, theoretical=${theoretical} msg/sec, run_id=${run_id} ==="

  docker run --rm \
    -v "$PWD/load:/scripts" \
    grafana/k6 run \
    -e USER_API_BASE="$USER_API_BASE" \
    -e CHAT_API_BASE="$CHAT_API_BASE" \
    -e WS_BASE="$WS_BASE" \
    -e USERS="$USERS" \
    -e DURATION="$DURATION" \
    -e SEND_INTERVAL_MS="$interval" \
    -e SOCKET_LIFE_MS="$SOCKET_LIFE_MS" \
    -e MAX_PENDING_ACKS="$MAX_PENDING_ACKS" \
    -e RUN_ID="$run_id" \
    -e REPORT_DIR=/scripts/reports \
    /scripts/ws-chat-load.js

  report_json="$REPORT_DIR/ws-chat-load-${run_id}.json"
  if [ ! -f "$report_json" ]; then
    echo "Report not found: $report_json" >&2
    exit 1
  fi

  db_count="$(docker compose exec -T postgres psql -U admin -d imdb -t -A -c "SELECT count(*) FROM \"Message\" WHERE \"requestId\" LIKE 'k6-${run_id}-%';" | tr -d '[:space:]')"

  row="$(node - "$report_json" "$db_count" "$interval" "$theoretical" "$ACK_ERROR_MAX" "$ACK_P95_MAX" "$DB_RATIO_MIN" <<'NODE'
const fs = require('fs');
const [reportPath, dbCountRaw, interval, theoretical, ackErrorMax, ackP95Max, dbRatioMin] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const dbCount = Number(dbCountRaw || 0);
const sent = Number(report.messages_sent || 0);
const dbRatio = sent > 0 ? (dbCount / sent) * 100 : 0;
const stable =
  Number(report.ack_error_rate_percent || 0) <= Number(ackErrorMax) &&
  Number(report.ack_p95_seconds || 0) <= Number(ackP95Max) &&
  dbRatio >= Number(dbRatioMin);
const fields = [
  report.run_id,
  interval,
  theoretical,
  sent,
  report.average_send_rate_msg_per_sec,
  report.ack_p95_seconds,
  report.ack_error_rate_percent,
  dbCount,
  dbRatio.toFixed(2),
  report.ws_error_frames,
  report.backpressure_skipped_sends,
  stable ? 'yes' : 'no',
];
console.log(fields.join(','));
NODE
)"

  echo "$row" >> "$CSV"

  IFS=',' read -r run_id_out interval_out theoretical_out sent_out rate_out ack_p95_out ack_err_out db_out db_ratio_out ws_err_out backpressure_out stable_out <<EOF_ROW
$row
EOF_ROW

  cat >> "$TXT" <<EOF
run_id=${run_id_out}
interval=${interval_out}ms theoretical=${theoretical_out} msg/sec
sent=${sent_out} average_send_rate=${rate_out} msg/sec
ack_p95=${ack_p95_out}s ack_error_rate=${ack_err_out}%
db_count=${db_out} db_ratio=${db_ratio_out}%
ws_error_frames=${ws_err_out} backpressure_skipped=${backpressure_out}
stable=${stable_out}

EOF

  echo "Result: rate=${rate_out} msg/sec, ack_p95=${ack_p95_out}s, ack_error=${ack_err_out}%, db_ratio=${db_ratio_out}%, stable=${stable_out}"

  if [ "$stable_out" = "no" ]; then
    echo "Stop: interval ${interval}ms failed stable criteria."
    break
  fi
done

echo ""
echo "Ceiling summary written to:"
echo "$CSV"
echo "$TXT"
echo ""
echo "Highest stable rate:"
awk -F, 'NR > 1 && $12 == "yes" { row=$0 } END { if (row) print row; else print "none" }' "$CSV"

