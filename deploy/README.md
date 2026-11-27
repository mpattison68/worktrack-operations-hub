# WorkTrack — Self-Hosted Deployment Assets

This directory contains the Docker Compose stack, reverse proxy templates, environment template, and operations scripts for running WorkTrack on your own Linux VM.

## Contents
- `docker-compose.yml` — isolated `worktrack-web` container bound to `127.0.0.1:3080`
- `.env.example` — environment template (copy to `deploy/.env`, never commit)
- `nginx.conf` — Nginx reverse proxy examples for `app.*` and `api.*`
- `Caddyfile.example` — Caddy reverse proxy examples for `app.*` and `api.*`
- `scripts/migrate.sh` — idempotent SQL migration runner for `db/migrations/*.sql`
- `scripts/deploy.sh` — single-command backup, pull, migrate, rebuild, healthcheck, and `--rollback`
- `scripts/create-user.sh` — server-side helper to create Auth users and `public.memberships` rows
- `scripts/backup.sh` — PostgreSQL dump + private storage archive + SHA-256 + optional GPG + retention
- `scripts/restore.sh` — checksum-verified PostgreSQL + storage restore
- `scripts/verify-restore-drill.sh` — automated post-restore RLS and bucket verification (T27)

For complete step-by-step instructions, see the root guides:
- `../DEPLOYMENT.md`
- `../CONFIGURATION.md`
- `../BACKUP_AND_RESTORE.md`
- `../UPGRADING.md`
- `../TROUBLESHOOTING.md`