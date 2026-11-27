#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set target DATABASE_URL before running restore.}"
DUMP_FILE="${1:?Usage: ./restore.sh /path/to/worktrack-db-TIMESTAMP.dump}"

if [[ -f "${DUMP_FILE}.sha256" ]]; then
  sha256sum -c "${DUMP_FILE}.sha256"
fi

pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP_FILE"
echo "Restore completed from ${DUMP_FILE}. Run smoke checks before switching traffic."