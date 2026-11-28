#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_URL:?Set DATABASE_URL securely}"
: "${STORAGE_DATA_DIR:?Set the actual self-hosted Storage volume directory}"
: "${SUPABASE_CONFIG_DIR:?Set /srv/worktrack/supabase/docker or the actual config directory}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/worktrack}"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
OUT="$(mktemp -d "$BACKUP_DIR/worktrack-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
trap 'printf "%s\n" "Backup failed: $OUT" > "$BACKUP_DIR/last-failure"' ERR
export PGDATABASE="$DATABASE_URL"
pg_dump --format=custom --no-owner --file="$OUT/database.dump"
pg_restore --list "$OUT/database.dump" > "$OUT/database-catalog.txt"
test -s "$OUT/database-catalog.txt"
test -d "$STORAGE_DATA_DIR"
tar -czf "$OUT/storage.tar.gz" -C "$STORAGE_DATA_DIR" .
tar -tzf "$OUT/storage.tar.gz" >/dev/null
# Include exact existing deployment configuration and local overrides, not a
# replacement generated configuration. Files are only in the protected archive.
CONFIG_LIST="$OUT/config-list"; : > "$CONFIG_LIST"
for file in "$ROOT/deploy/.env" "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/docker-compose.override.yml" "$SUPABASE_CONFIG_DIR/.env" "$SUPABASE_CONFIG_DIR/docker-compose.yml" "$SUPABASE_CONFIG_DIR/docker-compose.override.yml" "$SUPABASE_CONFIG_DIR/docker-compose.worktrack.yml"; do
 if [[ -f "$file" ]]; then printf '%s\n' "${file#/}" >> "$CONFIG_LIST"; fi
done
test -s "$CONFIG_LIST"
tar -czf "$OUT/configuration.tar.gz" -C / -T "$CONFIG_LIST"
tar -tzf "$OUT/configuration.tar.gz" >/dev/null
rm "$CONFIG_LIST"
OUT="$OUT" python3 - <<'PY'
import datetime,hashlib,json,os,pathlib,subprocess
p=pathlib.Path(os.environ['OUT'])
fingerprint=subprocess.check_output(['psql','-X','-t','-A','-c',"SELECT md5(current_database()||':'||(SELECT system_identifier::text FROM pg_control_system()))"],text=True).strip()
m={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'database_fingerprint':fingerprint,'files':{name:hashlib.sha256((p/name).read_bytes()).hexdigest() for name in ['database.dump','storage.tar.gz','configuration.tar.gz']},'restore_test':'not executed'}
(p/'manifest.json').write_text(json.dumps(m,indent=2))
PY
if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
 for file in database.dump storage.tar.gz configuration.tar.gz manifest.json; do
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$OUT/$file.gpg" "$OUT/$file"
  sha256sum "$OUT/$file.gpg" > "$OUT/$file.gpg.sha256"
 done
fi
printf '%s\n' "$OUT" > "$BACKUP_DIR/last-success"
rm -f "$BACKUP_DIR/last-failure"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] && [[ "$RETENTION" -gt 0 ]] || { echo 'Invalid retention days' >&2;exit 1; }
# Only complete managed backup directories; never prune failed backups silently.
while IFS= read -r dir; do test ! -f "$dir/manifest.json" || rm -rf -- "$dir"; done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name 'worktrack-*' -mtime "+$RETENTION")
echo "Backup validated (checksums/archive catalog only; isolated restore still required): $OUT"
