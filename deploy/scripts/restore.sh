#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_URL:?Set isolated target DATABASE_URL}"
: "${RESTORE_ISOLATED_CONFIRM:?Set RESTORE_ISOLATED_CONFIRM=ISOLATED TEST DATABASE after checking the target}"
[[ "$RESTORE_ISOLATED_CONFIRM" == 'ISOLATED TEST DATABASE' ]] || exit 1
DIR="${1:?Usage: restore.sh /path/to/validated-backup-directory}"
: "${TARGET_STORAGE_DIR:?Set isolated Storage destination}"
: "${TARGET_CONFIG_DIR:?Set isolated configuration extraction directory (never /)}"
[[ "$TARGET_CONFIG_DIR" != / && "$TARGET_STORAGE_DIR" != / ]] || exit 1
DIR="$DIR" python3 - <<'PY'
import hashlib,json,os,pathlib
p=pathlib.Path(os.environ['DIR']);m=json.loads((p/'manifest.json').read_text())
for name,h in m['files'].items():
 if pathlib.Path(name).name!=name or hashlib.sha256((p/name).read_bytes()).hexdigest()!=h: raise SystemExit('Checksum mismatch or unsafe filename: '+name)
PY
export PGDATABASE="$DATABASE_URL"
pg_restore --exit-on-error --single-transaction --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DIR/database.dump"
mkdir -p "$TARGET_STORAGE_DIR" "$TARGET_CONFIG_DIR"
# Reject path traversal/absolute entries before extracting either archive.
for archive in storage configuration; do
 tar -tzf "$DIR/$archive.tar.gz" | python3 -c 'import sys,pathlib; names=sys.stdin.read().splitlines(); assert all(not pathlib.PurePosixPath(n).is_absolute() and ".." not in pathlib.PurePosixPath(n).parts for n in names), "Unsafe archive path"'
done
tar -xzf "$DIR/storage.tar.gz" --no-same-owner -C "$TARGET_STORAGE_DIR"
tar -xzf "$DIR/configuration.tar.gz" --no-same-owner -C "$TARGET_CONFIG_DIR"
echo 'Isolated restore completed; validate authentication, RLS, evidence and configuration before any production recovery.'
