# WorkTrack — VM Backup/Restore Drill & Production Handover Runbook (T27 & T28)

This runbook is completely independent of Lovable and governs staging/production operations on your Linux VM.

## 1. Architecture & Lovable Independence (T28)
- **Frontend**: Built from this git repository using `Dockerfile` (`bun`/`npm` build -> Node/Nitro server behind your Nginx/Caddy TLS reverse proxy).
- **Backend**: Official self-hosted Supabase Docker Compose stack (PostgreSQL, GoTrue Auth, PostgREST, Storage, Kong API Gateway).
- **Portability verification (T28)**:
  1. Confirm `.env` contains only your VM's `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (never a service role key in `VITE_*`).
  2. Build and run with `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`.
  3. Verify DNS/firewall blocks external Lovable hosts if desired — login, jobs, assessments, progress, attendance, payroll, expenses, reports, vehicle checks, private photos, and offline sync continue operating solely against your VM.

## 2. Nightly Encrypted Backups (RPO 24h / RTO 8h)
1. Set `DATABASE_URL` and `STORAGE_DATA_DIR` (path to Supabase storage volume) in a root-only env file (`/etc/worktrack/backup.env`, `chmod 600`).
2. Run nightly via cron or systemd timer:
   ```bash
   set -a && source /etc/worktrack/backup.env && set +a
   bash deploy/scripts/backup.sh
   ```
3. Encrypt generated `.dump` and `.tar.gz` files with `age` or `gpg` and sync to off-VM storage (e.g. encrypted S3/Backblaze/offsite rsync).

## 3. Isolated-VM Restore Drill Protocol (Acceptance Test T27)
Run before go-live and quarterly thereafter on a clean staging/isolated VM:
1. Copy the latest encrypted DB dump, storage tarball, and `.sha256` files to the isolated VM and decrypt.
2. Run restore:
   ```bash
   export DATABASE_URL="postgres://postgres:<pass>@127.0.0.1:5432/postgres"
   export TARGET_STORAGE_DIR="/srv/supabase/volumes/storage"
   bash deploy/scripts/restore.sh /tmp/worktrack-db-STAMP.dump /tmp/worktrack-storage-STAMP.tar.gz
   ```
3. Run automated verification checks:
   ```bash
   bash deploy/scripts/verify-restore-drill.sh
   ```
4. Manual verification:
   - Sign in as Admin, Owner, and Supervisor on the restored staging URL.
   - Confirm Supervisor still cannot view payroll, rates, loans, or VINs (T21).
   - Open an uploaded receipt/photo and verify signed URL download succeeds while direct unauthenticated bucket access returns 400/403.
   - Record drill date, restore duration (must be < 8h RTO), and operator sign-off.

## 4. Production Deployment & Rollback
1. Take a fresh backup before applying any migration (`deploy/scripts/backup.sh`).
2. Pull approved git tag, run `bash deploy/scripts/migrate.sh`, then rebuild and restart `worktrack-web`.
3. Record the git commit SHA and latest migration filename in your change log.
4. **Rollback**:
   - Schema-compatible app rollback: redeploy the previous tagged Docker image.
   - Schema-breaking rollback: restore the pre-migration verified backup via `deploy/scripts/restore.sh` (explicitly accounting for any transactions captured after the backup timestamp).

## 5. Plain-English Quick Guides
### Owner (Mobile Field Use)
- **Before driving**: Open **More -> Truck check**. If any red safety item has a problem or wasn't checked, stop immediately — do not drive that truck.
- **During the day**: Log work cleared in **Work**, capture expenses in **Money -> Expenses** (snap a receipt photo or enter a reason), and save site photos in **More -> Photos**.
- **No signal?**: Keep capturing. Items show **Saved on phone** until signal returns, then upload automatically. Tap the top sync badge any time to check status or tap **Sync now**.
- **End of week**: Review **More -> Weekly report** and submit for Admin approval.

### Management / Admin (Desktop)
- **User onboarding**: Invite Owner and Supervisor accounts from **Settings**; assign Supervisors only to their authorised jobs.
- **Approvals**: Review and approve Site Assessments (baseline Rev 1), Weekly Attendance & Payroll runs, Weekly Reports, and critical Vehicle Defect resolutions.
- **Monitoring**: Review header **Alerts** for cash shortfalls, open critical vehicle defects, missing receipts, and returned reports.