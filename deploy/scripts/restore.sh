#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${DATABASE_URL:?Set isolated target DATABASE_URL}"
[[ "${RESTORE_ISOLATED_CONFIRM:-}" == 'ISOLATED TEST DATABASE' ]] || exit 1
: "${RESTORE_TARGET_FINGERPRINT:?Supply the independently checked isolated-target fingerprint}"
: "${TARGET_STORAGE_DIR:?Set empty isolated Storage destination}"
: "${TARGET_CONFIG_DIR:?Set empty isolated configuration destination}"
export PGDATABASE="$DATABASE_URL"
DIR="${1:?Usage: restore.sh /path/to/validated-backup-directory}"
export DIR
# Validate all files, archives, destination aliases and target identity BEFORE writes.
python3 - <<'PY'
import hashlib,json,os,pathlib,subprocess,tarfile
p=pathlib.Path(os.environ['DIR']).resolve();m=json.loads((p/'manifest.json').read_text())
for name,h in m['files'].items():
 if pathlib.Path(name).name!=name or hashlib.sha256((p/name).read_bytes()).hexdigest()!=h:raise SystemExit('Unsafe filename or checksum mismatch.')
for key in ['TARGET_STORAGE_DIR','TARGET_CONFIG_DIR']:
 target=pathlib.Path(os.environ[key]).resolve()
 if target==pathlib.Path('/') or target==p or target in p.parents or pathlib.Path('/srv/worktrack')==target or pathlib.Path('/srv/worktrack') in target.parents:raise SystemExit('Production/backup destination is forbidden.')
 if target.exists() and any(target.iterdir()):raise SystemExit('Isolated destinations must be empty.')
for name in ['storage','configuration']:
 with tarfile.open(p/(name+'.tar.gz')) as archive:
  for item in archive.getmembers():
   path=pathlib.PurePosixPath(item.name)
   if path.is_absolute() or '..' in path.parts or item.issym() or item.islnk() or not(item.isfile() or item.isdir()):raise SystemExit('Unsafe archive entry; no restore performed.')
fingerprint=subprocess.check_output(['psql','-X','-t','-A','-c',"SELECT md5(current_database()||':'||(SELECT system_identifier::text FROM pg_control_system()))"],text=True).strip()
if fingerprint==m['database_fingerprint'] or fingerprint!=os.environ['RESTORE_TARGET_FINGERPRINT']:raise SystemExit('Target is the source database or not the checked isolated target; restore refused.')
PY
pg_restore --exit-on-error --single-transaction --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$DIR/database.dump"
mkdir -p "$TARGET_STORAGE_DIR" "$TARGET_CONFIG_DIR"
tar -xzf "$DIR/storage.tar.gz" --no-same-owner -C "$TARGET_STORAGE_DIR"
tar -xzf "$DIR/configuration.tar.gz" --no-same-owner -C "$TARGET_CONFIG_DIR"
echo 'Isolated restore completed. Restore roles/ownership/permissions and verify Auth/RLS/evidence before release; no production promotion is automatic.'
