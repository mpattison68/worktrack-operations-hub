# WorkTrack — Updating & Rollback Guide

This guide describes the repeatable workflow for deploying changes developed in Lovable and synchronised to your private GitHub repository onto your Linux VM.

## 1. Single-Command Update Procedure
On your Linux VM, run:
```bash
cd /srv/worktrack/app
bash deploy/scripts/deploy.sh
```
To deploy a specific approved release tag or commit instead of `main`:
```bash
bash deploy/scripts/deploy.sh --ref v1.2.0
```

### What `deploy/scripts/deploy.sh` Does Automatically
1. Records the currently running Git commit SHA (for rollback).
2. Runs `deploy/scripts/backup.sh` to back up PostgreSQL and private storage before any change.
3. Runs `git fetch origin --tags` and fast-forwards to the requested branch/tag.
4. Runs `deploy/scripts/migrate.sh` to apply any new SQL files in `db/migrations/` (already-applied migrations tracked in `public.schema_migrations_worktrack` are skipped safely).
5. Rebuilds and restarts **only** the `worktrack-web` container (`docker compose up -d --build --remove-orphans`). Your PostgreSQL data, Auth users, financial records, and uploaded storage files are untouched.
6. Polls `http://127.0.0.1:${WORKTRACK_BIND_PORT}/auth` until healthy (up to 60 seconds). If health fails, it prints recent container logs and the exact rollback command.

## 2. Post-Update Verification Checklist
1. Check container status:
   ```bash
   docker compose -f /srv/worktrack/app/deploy/docker-compose.yml ps
   ```
   Status must show `Up ... (healthy)`.
2. Open `https://app.<your-domain>` in a browser, confirm the top bar shows **Connected to Supabase**, and sign in.
3. On mobile phones with the PWA installed, reopen the app; Workbox (`registerType: "autoUpdate"`) fetches the updated bundle automatically on the next navigation.

## 3. Rollback Procedure
### A. Application-only rollback (no destructive DB schema change)
Use the previous commit SHA printed by `deploy.sh`:
```bash
cd /srv/worktrack/app
bash deploy/scripts/deploy.sh --rollback <previous-commit-sha>
```

### B. Full rollback (if a new database migration caused an issue)
1. Stop `worktrack-web`:
   ```bash
   docker compose -f /srv/worktrack/app/deploy/docker-compose.yml stop worktrack-web
   ```
2. Restore the pre-update database dump created in Step 1 of `deploy.sh`:
   ```bash
   set -a && source /srv/worktrack/app/deploy/.env && set +a
   bash /srv/worktrack/app/deploy/scripts/restore.sh /var/backups/worktrack/worktrack-db-<STAMP>.dump
   ```
3. Roll back the app container:
   ```bash
   bash /srv/worktrack/app/deploy/scripts/deploy.sh --rollback <previous-commit-sha>
   ```

## 4. Updating Base Images & Dependencies
- **Node base image (`node:22-alpine`)**: Run `docker compose -f deploy/docker-compose.yml --env-file deploy/.env build --pull --no-cache` quarterly to pick up Alpine/Node security patches.
- **Self-hosted Supabase stack**: Always take a fresh `backup.sh` snapshot before pulling newer Supabase Docker images, and follow the official Supabase self-hosting release notes for any breaking GoTrue/Storage/Postgres changes.
- **npm packages**: Update dependencies in Lovable / GitHub, run `npm test`, then deploy via `deploy/scripts/deploy.sh`.