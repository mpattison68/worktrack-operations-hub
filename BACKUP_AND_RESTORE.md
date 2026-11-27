# WorkTrack — Backup, Retention, and Disaster Recovery

This guide covers automated daily backups, encryption, off-site replication, retention, and full VM recovery for WorkTrack (PostgreSQL database, private evidence storage, and configuration).

Target recovery objectives (per `docs/specification.md` Section 18):
- **RPO (maximum data loss):** 24 hours (daily automated backups)
- **RTO (maximum restore time):** 8 hours

## 1. What Must Be Backed Up
1. **PostgreSQL database** (`worktrack-db-<timestamp>.dump`) — all businesses, users (`auth.users`), memberships, jobs, assessments, waypoints, progress, attendance, payroll, finances, reports, vehicles, and attachment metadata.
2. **Private storage files** (`worktrack-storage-<timestamp>.tar.gz`) — all uploaded photographs, receipts, and PDFs stored under `STORAGE_DATA_DIR`.
3. **Configuration & secrets** (`deploy/.env` and self-hosted Supabase `.env`) — encrypted separately off-VM (never committed to GitHub).

## 2. Manual Backup Test
Run from the WorkTrack repository directory:
```bash
set -a && source /srv/worktrack/app/deploy/.env && set +a
bash /srv/worktrack/app/deploy/scripts/backup.sh
ls -lh /var/backups/worktrack
```
Expected output:
- `worktrack-db-YYYYMMDDTHHMMSSZ.dump` + `.sha256` (permissions `600`)
- `worktrack-storage-YYYYMMDDTHHMMSSZ.tar.gz` + `.sha256` (permissions `600`)
- `.gpg` encrypted copies if `BACKUP_GPG_RECIPIENT` is set in `deploy/.env`

## 3. Automated Daily Backups (Cron)
Create a root-only cron job running nightly at 02:15 SAST (00:15 UTC):
```bash
sudo tee /etc/cron.d/worktrack-backup >/dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 0 * * * root set -a && source /srv/worktrack/app/deploy/.env && set +a && /srv/worktrack/app/deploy/scripts/backup.sh >> /var/log/worktrack-backup.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/worktrack-backup
```
Verify after the first nightly run:
```bash
tail -n 30 /var/log/worktrack-backup.log
ls -lh /var/backups/worktrack
```

## 4. Backup Encryption & Off-Site Sync
Local backups on the same VM do not protect against VM disk failure or ransomware.

### Option A: GPG encryption built into `backup.sh` + `rclone` to S3 / Backblaze B2 / Wasabi
1. Import your backup public key on the VM (`gpg --import backup-public.asc`) and set `BACKUP_GPG_RECIPIENT=<key-id-or-email>` in `deploy/.env`.
2. Sync only encrypted `.gpg` and `.sha256` files off-site:
```bash
rclone copy /var/backups/worktrack remote:worktrack-backups \
  --include "*.gpg" --include "*.sha256" --transfers 2
```

### Option B: `rsync` over SSH to a second server or NAS
```bash
rsync -az --chmod=F600 /var/backups/worktrack/*.gpg backupuser@offsite.example.co.za:/backups/worktrack/
```

## 5. Retention Policy
- `deploy/scripts/backup.sh` automatically deletes local `worktrack-*` files older than `BACKUP_RETENTION_DAYS` (default **30 days**).
- On your off-site storage bucket, configure lifecycle rules (e.g., keep daily backups for 30 days, monthly snapshots for 12 months, and yearly financial archives for 5 years to meet South African record-keeping expectations).

## 6. Restoring Following a VM Failure
1. Provision a replacement Linux VM with Docker, Docker Compose, PostgreSQL client (`psql`/`pg_restore`), and your reverse proxy.
2. Clone the WorkTrack GitHub repository and restore your encrypted `deploy/.env` and Supabase `.env` files.
3. Start the fresh self-hosted Supabase Docker Compose stack so PostgreSQL and Storage directories exist.
4. Download and decrypt the latest database dump and storage archive:
```bash
gpg --decrypt --output /tmp/worktrack-db.dump /path/to/worktrack-db-STAMP.dump.gpg
gpg --decrypt --output /tmp/worktrack-storage.tar.gz /path/to/worktrack-storage-STAMP.tar.gz.gpg
```
5. Run the checksum-verified restore script:
```bash
set -a && source /srv/worktrack/app/deploy/.env && set +a
export TARGET_STORAGE_DIR="$STORAGE_DATA_DIR"
bash /srv/worktrack/app/deploy/scripts/restore.sh /tmp/worktrack-db.dump /tmp/worktrack-storage.tar.gz
```
6. Run the automated verification drill (Acceptance Test T27):
```bash
bash /srv/worktrack/app/deploy/scripts/verify-restore-drill.sh
```
7. Build and start `worktrack-web`:
```bash
docker compose -f /srv/worktrack/app/deploy/docker-compose.yml \
  --env-file /srv/worktrack/app/deploy/.env up -d --build
```
8. Reconfigure DNS / reverse proxy TLS and verify sign-in as Admin and Owner, plus downloading an uploaded receipt/photo.
9. Remove temporary decrypted files from `/tmp`:
```bash
shred -u /tmp/worktrack-db.dump /tmp/worktrack-storage.tar.gz 2>/dev/null || rm -f /tmp/worktrack-db.dump /tmp/worktrack-storage.tar.gz
```