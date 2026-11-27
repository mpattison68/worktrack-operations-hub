# WorkTrack — Configuration Reference

This file documents every environment variable, self-hosted Supabase setting, reverse proxy rule, and external dependency used by the current WorkTrack codebase.

## 1. WorkTrack Application Environment (`deploy/.env`)
Copy `.env.example` (or `deploy/.env.example`) to `deploy/.env` and restrict permissions:
```bash
chmod 600 deploy/.env
```
Never commit `deploy/.env` to GitHub.

| Variable | Scope | Required | Description |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Public (build-time) | Yes | Public HTTPS URL of your self-hosted Supabase Kong API gateway (e.g. `https://api.worktrack.example.co.za`). Embedded into the client bundle at Docker build time. |
| `VITE_SUPABASE_ANON_KEY` | Public (build-time) | Yes | Self-hosted Supabase `ANON_KEY` JWT. Safe for browser use because PostgreSQL RLS enforces all tenant and role boundaries. |
| `DATABASE_URL` | Server-only | Yes | PostgreSQL connection string for `deploy/scripts/migrate.sh`, `backup.sh`, `restore.sh`, and `create-user.sh` (e.g. `postgresql://postgres:<password>@127.0.0.1:5432/postgres`). |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | For user creation | Self-hosted Supabase `SERVICE_ROLE_KEY`. Used ONLY on the VM by `deploy/scripts/create-user.sh`. **NEVER** put this in any `VITE_*` variable. |
| `STORAGE_DATA_DIR` | Server-only | Recommended | Host path to the self-hosted Supabase Storage volume (e.g. `/srv/worktrack/supabase/docker/volumes/storage`) so `backup.sh` archives uploaded photos and receipts. |
| `BACKUP_DIR` | Server-only | Optional | Local directory for dumps and storage archives (default `/var/backups/worktrack`). |
| `BACKUP_RETENTION_DAYS` | Server-only | Optional | Days to retain local backup files before automatic pruning (default `30`). |
| `BACKUP_GPG_RECIPIENT` | Server-only | Optional | GPG key ID/email for automatic `.gpg` encryption of each backup file. |
| `WORKTRACK_BIND_HOST` | Host port bind | Optional | Bind address on the VM (default `127.0.0.1` — keep localhost-only behind your reverse proxy). |
| `WORKTRACK_BIND_PORT` | Host port bind | Optional | Localhost port for `worktrack-web` (default `3080`; change if already occupied on your VM). |

> **Important:** Because `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are Vite build-time variables, changing either value requires rebuilding the container (`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`).

## 2. Self-Hosted Supabase Configuration (`supabase/docker/.env`)
Configure these settings in your official self-hosted Supabase `.env` file before starting the Supabase stack:

### Authentication & Invitation-Only Security
- `DISABLE_SIGNUP=true` — **Required.** WorkTrack is invitation-only; public self-registration must be disabled.
- `SITE_URL=https://app.worktrack.example.co.za` — Public WorkTrack app URL.
- `ADDITIONAL_REDIRECT_URLS=https://app.worktrack.example.co.za/reset-password,https://app.worktrack.example.co.za/auth` — Required so password-reset emails redirect back to WorkTrack.
- `ENABLE_EMAIL_AUTOCONFIRM=false` (admin-created users via `create-user.sh` pass `email_confirm: true`).
- `JWT_EXPIRY=3600` (1 hour access tokens; refresh tokens rotate automatically).

### SMTP (Password Resets & Email Notifications)
Configure your own SMTP provider (e.g. Postmark, Resend, Brevo, AWS SES, or your domain mail relay):
- `SMTP_ADMIN_EMAIL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SENDER_NAME=WorkTrack`

### Storage (`worktrack-evidence` Private Bucket)
- Migration `db/migrations/202611270007_increment_f_offline_sync_storage.sql` creates the private bucket `worktrack-evidence` (`public = false`, 10 MB limit, MIME allowlist: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`).
- Migration `db/migrations/202611270008_storage_objects_rls.sql` creates tenant-scoped `storage.objects` RLS policies matching `<business_id>/<entity_type>/<entity_id>/<file>`.
- Ensure Supabase Storage persists to a host directory or named Docker volume (default in official compose: `./volumes/storage`).

### Network Isolation (Existing VM Safety)
In your self-hosted Supabase `docker-compose.yml`:
- Bind PostgreSQL (`5432`) to `127.0.0.1:5432:5432` (or remove host port mapping if only accessed via `docker exec`), **never** `0.0.0.0:5432`.
- Bind Kong HTTP (`KONG_HTTP_PORT`, default `8000`) to `127.0.0.1:8000:8000` (or an unused port such as `127.0.0.1:8400:8000`) and expose it only via HTTPS through your reverse proxy (`api.worktrack.example.co.za`).
- Keep Supabase Studio bound to `127.0.0.1` only (access via SSH tunnel if needed, never publicly).

## 3. Reverse Proxy Configuration
- **Nginx**: see `deploy/nginx.conf` (includes both `app.*` and `api.*` server blocks, `client_max_body_size 15m` for 10 MB uploads, `Permissions-Policy: geolocation=(self), camera=(self)`, and `Cache-Control: no-cache` on `/sw.js`).
- **Caddy**: see `deploy/Caddyfile.example` (automatic Let's Encrypt TLS).

## 4. External Services Used by the Current Codebase
| Service | Where Used | Required? | Offline Behaviour / Self-Hosting Option |
| --- | --- | --- | --- |
| OpenStreetMap raster tiles (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`) | `src/components/RouteMapCanvas.tsx` | Only for map imagery | Offline GPS waypoint capture still works without map tiles (map background is blank). Can be swapped to a self-hosted tile server or commercial tile provider later. |
| Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | `src/routes/__root.tsx` | Optional (cosmetic) | Falls back cleanly to system sans-serif fonts offline or if blocked. |
| Road-network routing API (OSRM / Mapbox / Google) | None configured yet | No | Currently uses WGS-84 Vincenty geometry between captured waypoints with optional manual road-distance override. |
| SMTP server | Self-hosted Supabase GoTrue | Needed for password resets | Admin can still reset/set passwords via GoTrue Admin API if SMTP is not configured yet. |