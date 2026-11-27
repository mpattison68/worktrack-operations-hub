#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL before running backup.}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/worktrack}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

OUT_FILE="${BACKUP_DIR}/worktrack-db-${STAMP}.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="$OUT_FILE"
sha256sum "$OUT_FILE" > "${OUT_FILE}.sha256"

echo "Database backup written to ${OUT_FILE} (checksum recorded)."
echo "Encrypt and sync ${BACKUP_DIR} to off-VM storage per docs/specification.md Section 18."