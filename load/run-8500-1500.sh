#!/usr/bin/env sh
set -eu

DOCKER="${DOCKER:-docker}"
COMPOSE="${COMPOSE:-$DOCKER compose}"
K6_IMAGE="${K6_IMAGE:-grafana/k6}"
NETWORK="${NETWORK:-backend-sketch_default}"
REPORT_DIR="${REPORT_DIR:-load/reports}"
RUN_PREFIX="${RUN_PREFIX:-load$(date +%Y%m%d%H%M%S)}"

IDLE_USERS="${IDLE_USERS:-8500}"
ACTIVE_USERS="${ACTIVE_USERS:-1500}"
IDLE_DURATION="${IDLE_DURATION:-6m}"
ACTIVE_DURATION="${ACTIVE_DURATION:-2m}"
ACTIVE_START_DELAY_SECONDS="${ACTIVE_START_DELAY_SECONDS:-30}"
ACTIVE_CONNECT_WARMUP_MS="${ACTIVE_CONNECT_WARMUP_MS:-30000}"
ACTIVE_SEND_INTERVAL_MS="${ACTIVE_SEND_INTERVAL_MS:-1000}"
ACTIVE_MAX_PENDING_ACKS="${ACTIVE_MAX_PENDING_ACKS:-20}"
IDLE_SOCKET_HOLD_MS="${IDLE_SOCKET_HOLD_MS:-360000}"
IDLE_PING_INTERVAL_MS="${IDLE_PING_INTERVAL_MS:-10000}"
IDLE_SHARDS="${IDLE_SHARDS:-3000:0 3000:3000 2500:6000}"
IDLE_READY_CONNECTIONS="${IDLE_READY_CONNECTIONS:-$IDLE_USERS}"
IDLE_READY_TIMEOUT_SECONDS="${IDLE_READY_TIMEOUT_SECONDS:-600}"
IDLE_READY_POLL_SECONDS="${IDLE_READY_POLL_SECONDS:-5}"
REALTIME_SERVICES="${REALTIME_SERVICES:-realtime-service-1 realtime-service-2 realtime-service-3 realtime-service-4}"
STOP_IDLE_AFTER_ACTIVE="${STOP_IDLE_AFTER_ACTIVE:-false}"

IDLE_POOL_FILE="${IDLE_POOL_FILE:-/scripts/fixtures/ws-online-pool-idle${IDLE_USERS}.json}"
ACTIVE_POOL_FILE="${ACTIVE_POOL_FILE:-/scripts/fixtures/ws-chat-pool-active${ACTIVE_USERS}.json}"
INTERNAL_WS_BASE="${INTERNAL_WS_BASE:-ws://realtime-gateway:8081}"
HOST_LOAD_DIR="${HOST_LOAD_DIR:-$PWD/load}"

if command -v cygpath >/dev/null 2>&1; then
  HOST_LOAD_DIR="$(cygpath -w "$PWD/load")"
fi

log() {
  printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

ensure_repo_root() {
  if [ ! -f "docker-compose.yml" ] || [ ! -d "load" ] || [ ! -d "backend" ]; then
    echo "Run this script from the repository root: backend-sketch" >&2
    exit 1
  fi
}

docker_run() {
  if command -v cygpath >/dev/null 2>&1; then
    MSYS_NO_PATHCONV=1 $DOCKER run "$@"
  else
    $DOCKER run "$@"
  fi
}

clear_k6_messages() {
  if [ "${CLEAR_K6_MESSAGES:-false}" != "true" ]; then
    return
  fi

  log "Clearing old k6 messages"
  $COMPOSE exec -T postgres psql -U admin -d imdb -c \
    "BEGIN;
     DELETE FROM \"MessageOutbox\"
     WHERE \"messageId\" IN (SELECT id FROM \"Message\" WHERE \"requestId\" LIKE 'k6-%');
     DELETE FROM \"Message\" WHERE \"requestId\" LIKE 'k6-%';
     DELETE FROM \"MessageWrite\" WHERE \"requestId\" LIKE 'k6-%';
     COMMIT;"
}

get_service_ws_connected() {
  service="$1"
  $COMPOSE exec -T "$service" wget -q -O - http://127.0.0.1:9091/metrics \
    | awk '/^backend_realtime_ws_connected/ { value=$NF } END { print value + 0 }'
}

get_total_ws_connected() {
  total=0
  for service in $REALTIME_SERVICES; do
    count="$(get_service_ws_connected "$service")"
    total=$((total + count))
  done
  printf '%s\n' "$total"
}

ensure_idle_containers_running() {
  for container in "$@"; do
    status="$($DOCKER inspect -f "{{.State.Status}}" "$container" 2>/dev/null || true)"
    case "$status" in
      running)
        ;;
      "")
        echo "Idle k6 container ${container} was not found while waiting for idle WebSocket connections" >&2
        exit 1
        ;;
      *)
        echo "Idle k6 container ${container} is no longer running: ${status}" >&2
        exit 1
        ;;
    esac
  done
}

wait_for_idle_connections() {
  deadline=$(( $(date +%s) + IDLE_READY_TIMEOUT_SECONDS ))

  log "Waiting for idle WebSocket connections: target=${IDLE_READY_CONNECTIONS}, timeout=${IDLE_READY_TIMEOUT_SECONDS}s"
  while :; do
    ensure_idle_containers_running "$@"
    total="$(get_total_ws_connected)"
    log "Idle WebSocket connections observed: ${total}/${IDLE_READY_CONNECTIONS}"

    if [ "$total" -ge "$IDLE_READY_CONNECTIONS" ]; then
      log "Idle WebSocket connection target reached"
      return
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "Timed out waiting for idle WebSocket connections: observed=${total}, target=${IDLE_READY_CONNECTIONS}" >&2
      exit 1
    fi

    sleep "$IDLE_READY_POLL_SECONDS"
  done
}

start_idle_shards() {
  idle_containers=""
  shard_index=1

  for shard in $IDLE_SHARDS; do
    shard_users="${shard%%:*}"
    shard_offset="${shard#*:}"
    shard_run_id="${idle_run_id}-s${shard_index}"
    shard_container="k6-idle-${run_ts}-s${shard_index}"

    if [ "$shard" = "$shard_users" ] || [ -z "$shard_users" ] || [ -z "$shard_offset" ]; then
      echo "Invalid IDLE_SHARDS entry: ${shard}. Expected USERS:USER_OFFSET, for example 3000:0" >&2
      exit 1
    fi

    log "Starting idle shard ${shard_index}: users=${shard_users}, offset=${shard_offset}, run_id=${shard_run_id}"
    docker_run -d --rm --name "$shard_container" \
      --network "$NETWORK" \
      -v "$HOST_LOAD_DIR:/scripts" \
      -e RUN_ID="$shard_run_id" \
      -e POOL_FILE="$IDLE_POOL_FILE" \
      -e USERS="$shard_users" \
      -e USER_OFFSET="$shard_offset" \
      -e DURATION="$IDLE_DURATION" \
      -e SOCKET_HOLD_MS="$IDLE_SOCKET_HOLD_MS" \
      -e PING_INTERVAL_MS="$IDLE_PING_INTERVAL_MS" \
      -e WS_BASE="$INTERNAL_WS_BASE" \
      -e REPORT_DIR=/scripts/reports \
      "$K6_IMAGE" run /scripts/ws-online-load.js

    idle_containers="${idle_containers} ${shard_container}"
    shard_index=$((shard_index + 1))
  done

  # shellcheck disable=SC2086
  wait_for_idle_connections $idle_containers
}

stop_idle_containers() {
  if [ "$STOP_IDLE_AFTER_ACTIVE" != "true" ]; then
    return
  fi

  for container in "$@"; do
    if [ "$($DOCKER inspect -f "{{.State.Status}}" "$container" 2>/dev/null || true)" = "running" ]; then
      log "Stopping idle k6 container: ${container}"
      $DOCKER stop "$container" >/dev/null
    fi
  done
}

ensure_repo_root
mkdir -p "$REPORT_DIR"

run_ts="$RUN_PREFIX"
idle_run_id="online${IDLE_USERS}idle-${run_ts}"
active_run_id="active${ACTIVE_USERS}-${run_ts}"

clear_k6_messages

start_idle_shards

if [ "$ACTIVE_START_DELAY_SECONDS" -gt 0 ]; then
  log "Waiting ${ACTIVE_START_DELAY_SECONDS}s after idle target before active senders"
  sleep "$ACTIVE_START_DELAY_SECONDS"
fi

log "Running active sender k6: ${ACTIVE_USERS} users (${active_run_id})"
docker_run --rm --name "k6-active-${run_ts}" \
  --network "$NETWORK" \
  -v "$HOST_LOAD_DIR:/scripts" \
  -e RUN_ID="$active_run_id" \
  -e POOL_FILE="$ACTIVE_POOL_FILE" \
  -e USERS="$ACTIVE_USERS" \
  -e DURATION="$ACTIVE_DURATION" \
  -e CONNECT_WARMUP_MS="$ACTIVE_CONNECT_WARMUP_MS" \
  -e SEND_INTERVAL_MS="$ACTIVE_SEND_INTERVAL_MS" \
  -e MAX_PENDING_ACKS="$ACTIVE_MAX_PENDING_ACKS" \
  -e WS_BASE="$INTERNAL_WS_BASE" \
  -e REPORT_DIR=/scripts/reports \
  "$K6_IMAGE" run /scripts/ws-chat-load.js

log "DB persisted messages for ${active_run_id}"
$COMPOSE exec -T postgres psql -U admin -d imdb -t -A -c \
  "SELECT count(*) FROM \"Message\" WHERE \"requestId\" LIKE 'k6-${active_run_id}-%';"

stop_idle_containers \
  "k6-idle-${run_ts}-s1" \
  "k6-idle-${run_ts}-s2" \
  "k6-idle-${run_ts}-s3" \
  "k6-idle-${run_ts}-s4" \
  "k6-idle-${run_ts}-s5" \
  "k6-idle-${run_ts}-s6" \
  "k6-idle-${run_ts}-s7" \
  "k6-idle-${run_ts}-s8"

log "Reports written under ${REPORT_DIR}"
printf 'Idle run ID:   %s\n' "$idle_run_id"
printf 'Active run ID: %s\n' "$active_run_id"
