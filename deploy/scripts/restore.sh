#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set target DATABASE_URL before running restore.}"
DUMP_FILE="${1:?Usage: ./restore.sh /path/to/worktrack-db-TIMESTAMP.dump}"
STORAGE_TAR="${2:-}"
TARGET_STORAGE_DIR="${TARGET_STORAGE_DIR:-}"

if [[ -f "${DUMP_FILE}.sha256" ]]; then
  sha256sum -c "${DUMP_FILE}.sha256"
fi

pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DUMP_FILE"
echo "Database restore completed from ${DUMP_FILE}."

if [[ -n "$STORAGE_TAR" ]]; then
  : "${TARGET_STORAGE_DIR:?Set TARGET_STORAGE_DIR when restoring a storage archive.}"
  if [[ -f "${STORAGE_TAR}.sha256" ]]; then
    sha256sum -c "${STORAGE_TAR}.sha256"
  fi
  mkdir -p "$TARGET_STORAGE_DIR"
  tar -xzf "$STORAGE_TAR" -C "$TARGET_STORAGE_DIR"
  echo "Private storage restored to ${TARGET_STORAGE_DIR}."
fi

echo "Restore completed. Run deploy/scripts/verify-restore-drill.sh before switching traffic."