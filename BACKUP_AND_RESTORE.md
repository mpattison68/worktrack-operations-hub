# Backup and isolated recovery

Use `deploy/scripts/backup.sh` with the actual `DATABASE_URL`, `STORAGE_DATA_DIR`, `SUPABASE_CONFIG_DIR` and `ENV_FILE`. It creates a protected directory containing `database.dump`, `storage.tar.gz`, `configuration.tar.gz`, catalog and `manifest.json` with checksums and database fingerprint. Capture extra deployment overlays privately as well.

Ordinary running-system backups are not a coordinated DB/filesystem snapshot. For reset/import or upgrade, stop **all** WorkTrack writers and set `BACKUP_QUIESCED_CONFIRM='ALL WRITERS STOPPED'`. The reset/import verifier requires that manifest flag, a matching database and a backup less than 24 hours old. Checksums/catalog validation do not prove a successful restore.

Optional GPG produces encrypted copies; protected plaintext originals remain on the VM. Never upload plaintext configuration/credentials. Configure encrypted off-site storage, access controls, schedule, alerting and retention, and prove recovery on a separate VM. These operational integrations were not executed here. The target objectives remain RPO 24 hours and RTO 8 hours, not measured achievements.

`restore.sh` is **isolated-only**. Decrypt/verify into a protected backup directory first. Set a different isolated `DATABASE_URL`, independently checked `RESTORE_TARGET_FINGERPRINT`, `RESTORE_ISOLATED_CONFIRM='ISOLATED TEST DATABASE'`, and empty `TARGET_STORAGE_DIR`/`TARGET_CONFIG_DIR` outside production paths, then pass the backup directory to the script. It validates manifest, archive entries/links, destination aliases and target fingerprint before writes and refuses the source database.

The target backend must already have compatible roles/extensions/infrastructure. Restore ownership and filesystem permissions appropriately, test Auth and RLS, and download actual private evidence before any controlled promotion. The database and filesystem do not share a restore transaction; an extraction failure leaves an isolated partial recovery, not a successful restore. Never use this script as an unattended production rollback.

See `UPGRADING.md` for exact existing-VM upgrade and `docs/release-acceptance-checklist.md` for measured recovery acceptance.
