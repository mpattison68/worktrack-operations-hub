# WorkTrack — Self-Hosted Linux VM Deployment Skeleton

This deployment skeleton runs WorkTrack independently of Lovable on a customer-owned Linux VM using Docker Compose and the official self-hosted Supabase stack.

## Prerequisites
1. Official self-hosted Supabase Docker Compose stack (Postgres, GoTrue Auth, PostgREST, Storage, Kong API Gateway) configured with unique secrets, SMTP, and redirect allowlists (`https://supabase.com/docs/guides/self-hosting/docker`).
2. Keep Postgres (5432) and Supabase Studio bound to localhost/private network only — never expose them publicly.
3. Existing reverse proxy (Nginx/Caddy) with TLS terminating HTTPS for `app.*` and `api.*`.

## Deployment Steps (Increment A)
1. Copy `deploy/.env.example` to `deploy/.env` and set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and server-side `DATABASE_URL`.
2. Apply SQL migrations:
   ```bash
   set -a && source deploy/.env && set +a
   bash deploy/scripts/migrate.sh
   ```
3. Staging only (never production): optionally load synthetic fixtures from `db/seed/synthetic_dev_fixtures.sql`.
4. Create the first business admin user via Supabase Auth admin API / invite flow and insert their `public.memberships` row with role `'admin'`.
5. Build and start the WorkTrack web container:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```
6. Configure your reverse proxy using `deploy/nginx.conf` as a reference.
7. Schedule nightly backups with `deploy/scripts/backup.sh` and validate restores to an isolated VM using `deploy/scripts/restore.sh` (Acceptance Test T27).