#!/usr/bin/env sh
set -eu

RUN_ID="${1:-}"

if [ -z "$RUN_ID" ]; then
  echo "Usage: sh load/count-k6-messages.sh <RUN_ID>"
  exit 1
fi

docker compose exec postgres psql -U admin -d imdb -c \
  "SELECT count(*) AS k6_message_count FROM \"Message\" WHERE \"requestId\" LIKE 'k6-${RUN_ID}-%';"

