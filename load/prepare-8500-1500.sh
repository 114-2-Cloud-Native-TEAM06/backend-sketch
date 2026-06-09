#!/usr/bin/env sh
set -eu

DOCKER="${DOCKER:-docker}"
COMPOSE="${COMPOSE:-$DOCKER compose}"
BACKEND_IMAGE="${BACKEND_IMAGE:-backend-sketch-backend-dev}"
NETWORK="${NETWORK:-backend-sketch_default}"
IDLE_USERS="${IDLE_USERS:-8500}"
ACTIVE_USERS="${ACTIVE_USERS:-1500}"
IDLE_POOL_FILE="${IDLE_POOL_FILE:-/scripts/fixtures/ws-online-pool-idle${IDLE_USERS}.json}"
ACTIVE_POOL_FILE="${ACTIVE_POOL_FILE:-/scripts/fixtures/ws-chat-pool-active${ACTIVE_USERS}.json}"
LOAD_METRICS_LOG_INTERVAL_MS="${LOAD_METRICS_LOG_INTERVAL_MS:-5000}"
WS_PRELOAD_ROOMS="${WS_PRELOAD_ROOMS:-false}"
MESSAGE_WRITER_DISABLE_FANOUT="${MESSAGE_WRITER_DISABLE_FANOUT:-true}"
API_HEALTH_TIMEOUT_SECONDS="${API_HEALTH_TIMEOUT_SECONDS:-120}"
PREPARE_CONCURRENCY="${PREPARE_CONCURRENCY:-25}"
REFRESH_FIXTURES="${REFRESH_FIXTURES:-false}"

INTERNAL_USER_API_BASE="${INTERNAL_USER_API_BASE:-http://user-service:8082}"
INTERNAL_CHAT_API_BASE="${INTERNAL_CHAT_API_BASE:-http://chat-service:8080}"
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

host_fixture_path() {
  case "$1" in
    /scripts/*)
      printf '%s/%s\n' "$PWD/load" "${1#/scripts/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

prepare_pool() {
  pool_type="$1"
  user_pool_id="$2"
  users="$3"
  output_file="$4"
  host_output_file="$(host_fixture_path "$output_file")"

  if [ "$REFRESH_FIXTURES" != "true" ] && [ -s "$host_output_file" ]; then
    log "Skipping ${pool_type} pool; fixture already exists: ${host_output_file}"
    return
  fi

  log "Preparing ${pool_type} pool: ${users} users -> ${output_file}"

  if [ "$pool_type" = "active" ]; then
    docker_run --rm \
      --network "$NETWORK" \
      -v "$HOST_LOAD_DIR:/scripts" \
      -w /scripts \
      -e POOL_TYPE=active \
      -e USER_POOL_ID="$user_pool_id" \
      -e USERS="$users" \
      -e USER_API_BASE="$INTERNAL_USER_API_BASE" \
      -e CHAT_API_BASE="$INTERNAL_CHAT_API_BASE" \
      -e API_HEALTH_TIMEOUT_SECONDS="$API_HEALTH_TIMEOUT_SECONDS" \
      -e PREPARE_CONCURRENCY="$PREPARE_CONCURRENCY" \
      -e OUTPUT_FILE="$output_file" \
      "$BACKEND_IMAGE" node /scripts/prepare-user-pool.mjs
  else
    docker_run --rm \
      --network "$NETWORK" \
      -v "$HOST_LOAD_DIR:/scripts" \
      -w /scripts \
      -e POOL_TYPE=idle \
      -e USER_POOL_ID="$user_pool_id" \
      -e USERS="$users" \
      -e USER_API_BASE="$INTERNAL_USER_API_BASE" \
      -e API_HEALTH_TIMEOUT_SECONDS="$API_HEALTH_TIMEOUT_SECONDS" \
      -e PREPARE_CONCURRENCY="$PREPARE_CONCURRENCY" \
      -e OUTPUT_FILE="$output_file" \
      "$BACKEND_IMAGE" node /scripts/prepare-user-pool.mjs
  fi
}

ensure_repo_root
mkdir -p load/fixtures load/reports

log "Building backend image"
$COMPOSE build

log "Starting Postgres, Redis, and NATS shards"
$COMPOSE up -d postgres redis nats-0 nats-1 nats-2 nats-3

log "Applying Prisma generate/migrate"
$COMPOSE run --rm user-service sh -c "npx prisma generate && npx prisma migrate deploy"

log "Starting API, realtime gateway, 4 realtime services, and 4 writers"
WS_PRELOAD_ROOMS="$WS_PRELOAD_ROOMS" \
MESSAGE_WRITER_DISABLE_FANOUT="$MESSAGE_WRITER_DISABLE_FANOUT" \
LOAD_METRICS_LOG_INTERVAL_MS="$LOAD_METRICS_LOG_INTERVAL_MS" \
  $COMPOSE up -d \
    chat-service user-service \
    realtime-service-1 realtime-service-2 realtime-service-3 realtime-service-4 realtime-gateway \
    message-writer-service message-writer-1 message-writer-2 message-writer-3

$COMPOSE ps

prepare_pool "idle" "pool-idle${IDLE_USERS}" "$IDLE_USERS" "$IDLE_POOL_FILE"
prepare_pool "active" "pool-active${ACTIVE_USERS}" "$ACTIVE_USERS" "$ACTIVE_POOL_FILE"

log "Prepared fixture pools"
printf 'Idle fixture:   %s\n' "$IDLE_POOL_FILE"
printf 'Active fixture: %s\n' "$ACTIVE_POOL_FILE"
