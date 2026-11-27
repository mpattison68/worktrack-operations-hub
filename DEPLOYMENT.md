# WorkTrack — Self-Hosted Linux VM Deployment Guide

This guide covers the deployment architecture, a factual **Deployment Readiness Review** of the current codebase, VM discovery commands, and 16 sequential installation steps for running WorkTrack independently on your own Linux VM alongside existing applications.

---

## 1. Deployment Architecture

WorkTrack runs as an isolated Docker Compose stack behind your existing reverse proxy (Nginx or Caddy), connected to a self-hosted Supabase Docker Compose stack on the same VM.

```text
Internet (HTTPS :443)
   |
   v
[ Your Existing Reverse Proxy (Nginx / Caddy + Let's Encrypt TLS) ]
   |                                  |
   | app.<your-domain>                | api.<your-domain>
   v (127.0.0.1:3080)                 v (127.0.0.1:8000 or custom port)
[ worktrack-web container ]        [ Self-hosted Supabase Kong Gateway ]
  (Node 22 + Nitro + React PWA)       |-- GoTrue Auth (invitation-only)
  Network: worktrack-internal         |-- PostgREST (RLS-enforced API)
                                      |-- Storage (worktrack-evidence private bucket)
                                      +-- PostgreSQL 15+ (127.0.0.1:5432 ONLY)
```

### Component Confirmation
- **Frontend & SSR shell:** React 19 + TanStack Start v1 built with `NITRO_PRESET=node-server` inside `Dockerfile` (`node:22-alpine`). Runs as a single non-root container (`worktrack-web`) on an isolated Docker network (`worktrack-internal`) bound only to `127.0.0.1:3080`.
- **Database:** PostgreSQL 15+ (bundled inside self-hosted Supabase). All 8 portable SQL migrations live in `db/migrations/` and are tracked in `public.schema_migrations_worktrack`.
- **Authentication:** Self-hosted Supabase GoTrue (`DISABLE_SIGNUP=true`, invitation-only, JWT + refresh tokens, password reset via your SMTP).
- **Is self-hosted Supabase required?** **Yes**, for the current architecture. WorkTrack's browser client (`src/lib/supabase.ts`) talks directly to Supabase Auth, PostgREST (enforced by PostgreSQL RLS), and Supabase Storage (`worktrack-evidence`). Running the official self-hosted Supabase Docker Compose stack gives you all four services on your VM with zero Lovable Cloud dependency.
- **File storage (photos, receipts, PDFs):** Private Supabase Storage bucket `worktrack-evidence` backed by a persistent host directory (`STORAGE_DATA_DIR`, e.g. `/srv/worktrack/supabase/docker/volumes/storage`). Survives all container rebuilds and upgrades.
- **External services:**
  - **OpenStreetMap tiles** (`tile.openstreetmap.org`) for map display in `RouteMapCanvas.tsx` (optional; GPS waypoint capture works offline without tiles).
  - **Google Fonts** (`fonts.googleapis.com`) in `src/routes/__root.tsx` (optional; degrades cleanly to system fonts).
  - **Your SMTP server** for password reset emails.
  - **Road-network routing:** None configured yet; distances use WGS-84 Vincenty geometry between captured waypoints plus optional manual override.
- **VM Specifications (dedicated headroom for WorkTrack + self-hosted Supabase alongside existing apps):**
  - **Minimum:** 2 vCPU, 4 GB free RAM (Docker build + Supabase stack), 25 GB free SSD disk.
  - **Recommended:** 4 vCPU, 8 GB free RAM, 50 GB+ SSD disk (allows comfortable room for photos, receipts, and 30 days of local backups).
- **Network Ports & Firewall:**
  - **Publicly open (already open for your existing proxy):** TCP `80` (HTTP redirect / ACME challenge) and TCP `443` (HTTPS).
  - **Localhost-only (`127.0.0.1`, NEVER exposed in firewall):** `3080` (`worktrack-web`), `8000` (Supabase Kong API), `5432` (PostgreSQL), `3000`/`54323` (Supabase Studio).
- **Lovable Independence:**
  - Zero runtime calls to Lovable Cloud.
  - `src/lib/lovable-error-reporting.ts` is a passive no-op when `window.__lovableEvents` is absent.
  - `@lovable.dev/vite-tanstack-config` is a public npm build-time devDependency; setting `ENV NITRO_PRESET=node-server` in `Dockerfile` builds a standalone Node.js server.

---

## 2. Deployment Readiness Review (Current Codebase Audit)

A full code audit was performed before preparing this guide. Here is the exact status of what is ready versus what remains incomplete:

### Fixed during this deployment preparation
1. **`Dockerfile` Nitro runtime target:** Added `ENV NITRO_PRESET=node-server`, non-root `node` user, and `sw.js` copy guard so Docker builds a working Node.js server instead of defaulting to a Cloudflare Worker bundle.
2. **Private storage RLS policies:** Added `db/migrations/202611270008_storage_objects_rls.sql` so authenticated users can upload/read objects under their own `<business_id>/...` path in `worktrack-evidence` while blocking cross-tenant/public access.
3. **Restore drill script table names:** Fixed `deploy/scripts/verify-restore-drill.sh` to check `journal_entries` and `assets` (matching migrations `0005`/`0006`) and all 8 migrations.
4. **Missing deployment files added:** `.dockerignore`, root `.env.example`, `deploy/Caddyfile.example`, dual-subdomain `deploy/nginx.conf`, single-command `deploy/scripts/deploy.sh`, and `deploy/scripts/create-user.sh`.

### Implemented & Wired to Live Supabase
- **Authentication & Roles (`src/lib/auth-context.tsx`, `src/lib/supabase.ts`):** Password sign-in, session refresh, password reset, and active `public.memberships` hydration.
- **Increment A (`src/lib/data/repository.ts`):** Businesses, memberships, invitations (DB record), jobs, worker roles, effective-dated pay rules (including OT rates), workers, assignments, rate overrides, and audit events.
- **Increment B (`src/lib/data/assessment-repository.ts`):** Benchmarks, site assessments, multi-waypoint GPS routes, revisions, and approval workflow.
- **Increment C (`src/lib/data/increment-c-repository.ts`):** Daily progress, interruptions, team/worker attendance, and payroll runs.
- **Increment F (`src/lib/offline/sync-engine.ts`):** Partitioned IndexedDB offline queue, idempotency keys, conflict detection, image compression/EXIF stripping, and binary upload to private bucket `worktrack-evidence`.
- **Database Schema (`db/migrations/202611270001`–`0008`):** Complete SQL tables, triggers, and RLS policies for Increments A–F.

### Incomplete / Known Gaps Before Full Multi-Device Production Use
1. **Increment D Finance repository (`src/lib/data/increment-d-repository.ts`):** Only reads `expenses` from Supabase; all Increment D write functions (wage payments, expenses, transfers, cash reconciliations, customer receipts, loans) and other reads still use browser `localStorage`. **Impact:** Finance entries saved on Vuyo's phone will not yet appear on Admin's desktop until Increment D's Supabase adapter is wired to migration `0005`.
2. **Increment E Reports, Vehicles & Notifications (`src/lib/data/increment-e-repository.ts`):** Currently 100% browser `localStorage` (0 live Supabase queries), even though migration `0006` defines all tables and RLS policies. **Impact:** Vehicle checks, weekly reports, and notifications will not sync across devices until Increment E's Supabase adapter is wired.
3. **Evidence attachment metadata sync (`src/lib/offline/sync-engine.ts`):** Uploads binary files to `supabase.storage.from("worktrack-evidence")`, but does not yet insert the companion metadata row into `public.evidence_attachments`.
4. **Admin email invitations (`src/routes/settings.tsx`):** Submitting the Invite form records a row in `public.invitations` but does not yet call the GoTrue Admin Invite API (because the browser must never hold `SUPABASE_SERVICE_ROLE_KEY`). Until a server-side invite endpoint is added, create new Auth accounts on the VM with `deploy/scripts/create-user.sh`.
5. **Not yet tested on live hardware:** All 8 SQL migrations, Docker image build on Linux, SMTP email delivery, physical Android PWA/GPS trial (T26), and isolated-VM backup/restore drill (T27) have not yet been executed against a live PostgreSQL/VM environment.

---

## 3. Collect Your Existing VM Details (Optional — Send Back for Tailored Configs)

If you want exact port numbers and reverse-proxy snippets tailored to your VM, run these read-only commands and share the output:
```bash
uname -a && cat /etc/os-release | grep PRETTY_NAME
nproc && free -h && df -h / /var /srv 2>/dev/null
docker --version && docker compose version
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}"
sudo ss -tulpn | grep -E ':(80|443|3000|3080|5432|8000|8443)\b'
which nginx caddy traefik certbot psql git 2>&1 || true
```

---

## 4. Step-by-Step Installation Instructions (16 Steps)

### Step 1: Check available VM resources
```bash
nproc && free -h && df -h
```
**Success check:** At least 2 vCPU, 4 GB free RAM, and 25 GB free disk space on the partition where Docker stores volumes (typically `/` or `/var/lib/docker`).

### Step 2: Check existing applications, containers, and occupied ports
```bash
docker ps --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}"
sudo ss -tulpn | grep -E ':(80|443|3080|5432|8000)\b' || echo "Ports 3080/5432/8000 are free"
```
**Success check:** Note which reverse proxy owns `:80`/`:443` (Nginx, Caddy, or Traefik). If `3080`, `5432`, or `8000` is already in use by another app, choose unused localhost ports (e.g., `3081`, `5433`, `8400`) in Steps 6–7 so nothing conflicts.

### Step 3: Install missing prerequisites
Skip anything already installed in Step 2 (Ubuntu/Debian example):
```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates gnupg postgresql-client python3
# Install Docker + Compose plugin only if missing:
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Log out and back in for docker group membership to take effect."
fi
```
**Success check:** `docker compose version`, `psql --version`, and `git --version` all print version numbers.

### Step 4: Create the isolated WorkTrack directory structure
```bash
sudo mkdir -p /srv/worktrack /var/backups/worktrack
sudo chown -R "$USER":"$USER" /srv/worktrack
sudo chmod 700 /var/backups/worktrack
```
**Success check:** `ls -ld /srv/worktrack /var/backups/worktrack` shows both directories with correct ownership/permissions.

### Step 5: Connect to and clone your private GitHub repository
Generate a dedicated read-only SSH deploy key on the VM:
```bash
ssh-keygen -t ed25519 -C "worktrack-vm-deploy" -f ~/.ssh/worktrack_github -N ""
cat ~/.ssh/worktrack_github.pub
```
Add the printed public key in GitHub: **Repository -> Settings -> Deploy keys -> Add deploy key** (read-only). Then configure SSH and clone:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github-worktrack
  HostName github.com
  User git
  IdentityFile ~/.ssh/worktrack_github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
git clone git@github-worktrack:<YOUR-GITHUB-USER>/<YOUR-REPO>.git /srv/worktrack/app
```
**Success check:** `ls /srv/worktrack/app/Dockerfile` exists and `git -C /srv/worktrack/app status` is clean.

### Step 6: Generate secure credentials and configure `deploy/.env`
Generate unique secrets (never reuse across apps):
```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)"
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)"
```
Copy the WorkTrack env template:
```bash
cp /srv/worktrack/app/deploy/.env.example /srv/worktrack/app/deploy/.env
chmod 600 /srv/worktrack/app/deploy/.env
```
You will fill `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `DATABASE_URL` immediately after Step 7.
**Success check:** `stat -c '%a %n' /srv/worktrack/app/deploy/.env` prints `600`.

### Step 7: Set up self-hosted Supabase (Database, Auth, Storage)
Clone the official Supabase Docker Compose files into `/srv/worktrack/supabase` (isolated from other apps):
```bash
git clone --depth 1 https://github.com/supabase/supabase /srv/worktrack/supabase
cd /srv/worktrack/supabase/docker
cp .env.example .env
chmod 600 .env
```
Edit `/srv/worktrack/supabase/docker/.env` and set:
- `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` (generate matching HS256 JWTs for `ANON_KEY` and `SERVICE_ROLE_KEY` using Supabase's self-hosting key generator or `python3` with your `JWT_SECRET`).
- `DISABLE_SIGNUP=true`
- `SITE_URL=https://app.<your-domain>`
- `ADDITIONAL_REDIRECT_URLS=https://app.<your-domain>/reset-password,https://app.<your-domain>/auth`
- `API_EXTERNAL_URL=https://api.<your-domain>`
- `SUPABASE_PUBLIC_URL=https://api.<your-domain>`
- `SMTP_*` variables for password resets.

Bind Kong and Postgres to localhost only in `/srv/worktrack/supabase/docker/docker-compose.yml` (so Postgres `5432` and Studio are never publicly reachable), then start the stack:
```bash
cd /srv/worktrack/supabase/docker
docker compose -p worktrack-supabase up -d
```
Now update `/srv/worktrack/app/deploy/.env` with your `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and `STORAGE_DATA_DIR=/srv/worktrack/supabase/docker/volumes/storage`.
**Success check:** `docker compose -p worktrack-supabase ps` shows `db`, `auth`, `rest`, `storage`, and `kong` healthy, and `curl -s http://127.0.0.1:8000/auth/v1/health` returns JSON `{"version":...}`.

### Step 8: Apply WorkTrack database migrations
```bash
cd /srv/worktrack/app
set -a && source deploy/.env && set +a
bash deploy/scripts/migrate.sh
```
**Success check:** Prints `All WorkTrack migrations applied.` and:
```bash
psql "$DATABASE_URL" -c "SELECT filename, applied_at FROM public.schema_migrations_worktrack ORDER BY filename;"
```
lists all 8 migration files (`202611270001` through `202611270008`).

### Step 9: Build and start the WorkTrack Docker container
```bash
cd /srv/worktrack/app
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```
**Success check:**
```bash
docker compose -f deploy/docker-compose.yml ps
curl -I http://127.0.0.1:3080/auth
```
Container status is `Up ... (healthy)` and `curl -I` returns `HTTP/1.1 200 OK`.

### Step 10: Configure DNS subdomains
In your DNS provider, create two `A` records (and `AAAA` if your VM uses IPv6) pointing to your VM's public IP:
- `app.<your-domain>` -> `<VM_PUBLIC_IP>`
- `api.<your-domain>` -> `<VM_PUBLIC_IP>`

**Success check:** `dig +short app.<your-domain>` and `dig +short api.<your-domain>` both return your VM's IP address.

### Step 11: Integrate with your existing reverse proxy
- **If using Nginx:** Copy `deploy/nginx.conf` to `/etc/nginx/sites-available/worktrack.conf`, replace `app.worktrack.example.co.za` and `api.worktrack.example.co.za` (and upstream ports if changed), enable the symlink, test without restarting existing sites:
  ```bash
  sudo cp /srv/worktrack/app/deploy/nginx.conf /etc/nginx/sites-available/worktrack.conf
  sudo nano /etc/nginx/sites-available/worktrack.conf
  sudo ln -s /etc/nginx/sites-available/worktrack.conf /etc/nginx/sites-enabled/worktrack.conf
  sudo nginx -t && sudo systemctl reload nginx
  ```
- **If using Caddy:** Append the two server blocks from `deploy/Caddyfile.example` to your Caddyfile, update domain names, and run `sudo caddy validate && sudo systemctl reload caddy`.

**Success check:** `nginx -t` (or `caddy validate`) reports syntax OK and your existing hosted apps remain unaffected.

### Step 12: Configure HTTPS certificates
- **Nginx + Certbot:**
  ```bash
  sudo certbot --nginx -d app.<your-domain> -d api.<your-domain>
  sudo certbot renew --dry-run
  ```
- **Caddy:** Automatic upon reload; verify with `curl -I https://app.<your-domain>`.

**Success check:** `curl -I https://app.<your-domain>/auth` and `curl -s https://api.<your-domain>/auth/v1/health` both succeed over valid HTTPS with no certificate warnings.

### Step 13: Create the initial Administrator account (Mark)
```bash
cd /srv/worktrack/app
bash deploy/scripts/create-user.sh \
  --email "mark@<your-domain>" \
  --name "Mark Pattison" \
  --role "admin" \
  --business-name "<Your Business Name>"
```
Note the printed `business_id` UUID for Step 14.
**Success check:** Script prints `SUCCESS: Linked mark@... as 'admin' in business <UUID>`.

### Step 14: Create Vuyo's Owner account
Use the `business_id` printed in Step 13:
```bash
cd /srv/worktrack/app
bash deploy/scripts/create-user.sh \
  --email "vuyo@<your-domain>" \
  --name "Vuyo" \
  --role "owner" \
  --business-id "<BUSINESS_UUID_FROM_STEP_13>"
```
**Success check:** Script prints `SUCCESS: Linked vuyo@... as 'owner' in business <UUID>`.

### Step 15: Verify the application end-to-end
1. Open `https://app.<your-domain>` in a desktop browser.
2. Confirm the top bar shows **Connected to Supabase** (NOT `Synthetic dev mode`).
3. Sign in as Admin (Mark), open **Settings**, verify the business name and both members appear, and create one test job.
4. Sign out, sign in as Owner (Vuyo), confirm the job is visible and Admin-only rate-editing controls are locked.
5. Verify `https://app.<your-domain>/manifest.webmanifest` and `https://app.<your-domain>/sw.js` return HTTP `200`.

**Success check:** Both roles authenticate cleanly, data persists across browser reload, and browser DevTools Console shows zero CORS or 500 errors.

### Step 16: Install WorkTrack as a PWA on Vuyo's Android phone
1. Open `https://app.<your-domain>` in **Chrome for Android**.
2. Sign in with Vuyo's account.
3. Tap the Chrome menu (`⋮`) -> **Add to Home screen** -> **Install**.
4. Launch **WorkTrack** from the home-screen icon.
5. Open **Assessments** -> capture a GPS point (grant **Allow while using the app** for Location) and open **More -> Photos** -> take a test photo (grant Camera permission).
6. Follow `docs/android-field-trial-checklist.md` to confirm offline persistence across app restarts.

**Success check:** App launches full-screen without a browser URL bar, GPS coordinates and photos capture cleanly, and the top bar shows **Online / All synced**.

---

## 5. Mobile, GPS, Camera, and PWA Requirements

- **Valid HTTPS is mandatory:** Chrome/Safari refuse Geolocation, Camera (`getUserMedia` / file capture), Service Workers, and PWA installation on plain HTTP or self-signed certificates.
- **Reverse proxy headers:** `deploy/nginx.conf` and `deploy/Caddyfile.example` include `Permissions-Policy: geolocation=(self), camera=(self)` and `Cache-Control: no-cache` on `/sw.js`.
- **Service worker host guard:** `src/lib/offline/pwa-register.ts` intentionally blocks service-worker registration on Lovable preview domains (`*.lovable.app`) and enables it on your production HTTPS domain (`app.<your-domain>`).
- **GPS & Waypoints:** Captured via browser `navigator.geolocation.getCurrentPosition` with high-accuracy mode, accuracy badge warnings, and WGS-84 Vincenty distance calculation. Works offline; map background tiles require connectivity to `tile.openstreetmap.org`.
- **Photo & Receipt Uploads:** Compressed client-side with EXIF metadata stripped and SHA-256 checksummed before upload to the private `worktrack-evidence` bucket (max 10 MB, JPEG/PNG/WebP/PDF).