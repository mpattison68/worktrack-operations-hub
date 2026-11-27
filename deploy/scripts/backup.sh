#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL before running backup.}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/worktrack}"
STORAGE_DATA_DIR="${STORAGE_DATA_DIR:-}"
CONFIG_ENV_FILE="${CONFIG_ENV_FILE:-}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

OUT_FILE="${BACKUP_DIR}/worktrack-db-${STAMP}.dump"
pg_dump "$DATABASE_URL" --format=custom --no-owner --file="$OUT_FILE"
sha256sum "$OUT_FILE" > "${OUT_FILE}.sha256"
chmod 600 "$OUT_FILE" "${OUT_FILE}.sha256"

if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "${OUT_FILE}.gpg" "$OUT_FILE"
  chmod 600 "${OUT_FILE}.gpg"
  echo "Encrypted database backup written to ${OUT_FILE}.gpg"
fi

if [[ -n "$STORAGE_DATA_DIR" && -d "$STORAGE_DATA_DIR" ]]; then
  STORAGE_TAR="${BACKUP_DIR}/worktrack-storage-${STAMP}.tar.gz"
  tar -czf "$STORAGE_TAR" -C "$STORAGE_DATA_DIR" .
  sha256sum "$STORAGE_TAR" > "${STORAGE_TAR}.sha256"
  chmod 600 "$STORAGE_TAR" "${STORAGE_TAR}.sha256"
  echo "Private storage archive written to ${STORAGE_TAR} (checksum recorded)."
  if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
    gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "${STORAGE_TAR}.gpg" "$STORAGE_TAR"
    chmod 600 "${STORAGE_TAR}.gpg"
    echo "Encrypted storage archive written to ${STORAGE_TAR}.gpg"
  fi
else
  echo "Note: STORAGE_DATA_DIR not set or absent; skipped private storage volume archive."
fi

if [[ -n "$CONFIG_ENV_FILE" && -f "$CONFIG_ENV_FILE" ]]; then
  echo "Config snapshot reminder: encrypt ${CONFIG_ENV_FILE} off-VM using age/gpg (never store plaintext in git)."
fi

if [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && [[ "$BACKUP_RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'worktrack-*' -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  echo "Retention policy applied: removed local archives older than ${BACKUP_RETENTION_DAYS} days."
fi

echo "Database backup written to ${OUT_FILE} (checksum recorded)."
echo "Encrypt (gpg/age) and sync ${BACKUP_DIR} to off-VM storage per docs/specification.md Section 18 (RPO 24h / RTO 8h)."