# WorkTrack — Troubleshooting & Operations Reference

## 1. Checking Logs & Health
```bash
# Container status and health
docker compose -f /srv/worktrack/app/deploy/docker-compose.yml ps

# Live WorkTrack web server logs
docker compose -f /srv/worktrack/app/deploy/docker-compose.yml logs -f --tail=100 worktrack-web

# Direct localhost health check (bypasses reverse proxy)
curl -I http://127.0.0.1:3080/auth

# Self-hosted Supabase logs (from your Supabase docker directory)
docker compose logs -f --tail=100 auth rest storage kong db
```

## 2. Common Issues & Fixes

### App shows "Synthetic dev mode" instead of "Connected to Supabase"
- **Cause:** `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` was empty when the Docker image was built.
- **Fix:** Verify both values are set in `deploy/.env`, then rebuild with `--no-cache`:
  ```bash
  docker compose -f /srv/worktrack/app/deploy/docker-compose.yml \
    --env-file /srv/worktrack/app/deploy/.env build --no-cache worktrack-web
  docker compose -f /srv/worktrack/app/deploy/docker-compose.yml \
    --env-file /srv/worktrack/app/deploy/.env up -d
  ```

### Docker build succeeds, but container crashes with "Cannot find module .output/server/index.mjs"
- **Cause:** Nitro defaulted to `cloudflare-module` instead of `node-server`.
- **Fix:** Confirm `ENV NITRO_PRESET=node-server` is present in `Dockerfile` (already included in the updated `Dockerfile`).

### Sign-in succeeds in Auth, then immediately signs out with "No active business membership found"
- **Cause:** The user exists in `auth.users` but has no active row in `public.memberships`.
- **Fix:** Verify the user's membership row:
  ```bash
  set -a && source /srv/worktrack/app/deploy/.env && set +a
  psql "$DATABASE_URL" -c "SELECT business_id, user_id, email, role, active FROM public.memberships;"
  ```
  Or re-run `deploy/scripts/create-user.sh` / insert the missing `public.memberships` row.

### Password reset email link redirects to localhost or fails
- **Cause:** `SITE_URL` or `ADDITIONAL_REDIRECT_URLS` in self-hosted Supabase `.env` is missing your production domain.
- **Fix:** Set `SITE_URL=https://app.<your-domain>` and `ADDITIONAL_REDIRECT_URLS=https://app.<your-domain>/reset-password,https://app.<your-domain>/auth`, then restart Supabase `auth`:
  ```bash
  docker compose up -d auth
  ```

### Photo / receipt upload fails with 403 or 413
- **403 Forbidden:** Ensure migration `db/migrations/202611270008_storage_objects_rls.sql` has been applied (`bash deploy/scripts/migrate.sh`) and the user has an active row in `public.memberships` for that `business_id`.
- **413 Request Entity Too Large:** Increase `client_max_body_size 15m;` in Nginx (or `max_size 15MB` in Caddy) on the `api.*` proxy block and reload the proxy.

### GPS or Camera permission denied on Vuyo's phone
- **Cause:** Mobile browsers block Geolocation and Camera APIs on plain `http://`, invalid/self-signed TLS certificates, or if a reverse proxy sends a restrictive `Permissions-Policy` header.
- **Fix:**
  1. Confirm valid HTTPS certificate on `https://app.<your-domain>`.
  2. Confirm reverse proxy sends `Permissions-Policy: geolocation=(self), camera=(self)`.
  3. In Android Chrome: tap the lock/tune icon in the address bar -> **Permissions** -> allow **Location** and **Camera**.

### PWA "Install app" prompt does not appear or offline mode fails
- **Cause:** Service workers require HTTPS with a valid certificate, and `src/lib/offline/pwa-register.ts` intentionally disables service workers on Lovable preview hostnames (`*.lovable.app`).
- **Fix:**
  1. Access WorkTrack via your own HTTPS domain (`https://app.<your-domain>`).
  2. Verify `https://app.<your-domain>/manifest.webmanifest` and `https://app.<your-domain>/sw.js` both return HTTP `200`.
  3. In Chrome DevTools -> **Application** -> **Service Workers**, confirm `sw.js` is activated.

### Map background is blank on the Assessments screen
- **Cause:** OpenStreetMap tile requests (`https://{s}.tile.openstreetmap.org/...`) are blocked offline or by a corporate firewall.
- **Note:** GPS waypoint capture and WGS-84 distance calculations continue working offline; map tiles load again when connectivity returns.

### Finance (Increment D) or Vehicles / Weekly Reports (Increment E) data is not shared across devices yet
- **Cause:** See the **Deployment Readiness Review** in `DEPLOYMENT.md`. As of the current codebase, `increment-d-repository.ts` (writes and most reads) and `increment-e-repository.ts` still use browser `localStorage` rather than live Supabase queries, even though the PostgreSQL tables exist in migrations `0005` and `0006`.
- **Fix:** Complete the live Supabase repository wiring for Increments D and E before using those modules across multiple devices in production.

### Port conflict on startup (`address already in use`)
- **Fix:** Change `WORKTRACK_BIND_PORT` in `deploy/.env` (e.g. `3081`) and update the upstream port in your reverse proxy config, then re-run `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`.