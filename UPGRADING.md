# Existing WorkTrack VM — candidate upgrade procedure

**Run only after the isolated acceptance checklist passes. This is not authorization to deploy immediately. No reset or import is part of these steps.**

Security-review baseline: application commit `446a6679f9cf34b9fdcc1c6119ce25f6a7577c04` completed a deep scan with no findings on 28 November 2026. The focused review subsequently adds **0024** for financial security controls: **24 migrations total**, no new environment variables or proxy changes. Record the final corrected release commit separately; it has passed regression/concurrency checks but needs a fresh deep scan before production approval. Nothing here authorizes live deployment.

Known installation: `/srv/worktrack/app`; backend `/srv/worktrack/supabase/docker`; app `worktrack.clickcraft.tech` on localhost 3080; API `worktrack-api.clickcraft.tech` through Envoy on localhost 8400; PostgreSQL 17.6/Supavisor; Nginx Proxy Manager and external `npm-proxy` network. Keep the existing Compose project name and all actual overlays. Do not replace the backend or proxy.

## 1. Preserve the actual installation

Run on the VM, not in Lovable:

```bash
cd /srv/worktrack/app
umask 077
export ENV_FILE="/srv/worktrack/app/deploy/.env"
SAFE="/var/backups/worktrack/pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$SAFE"
chmod 700 "$SAFE"
git rev-parse HEAD > "$SAFE/old-commit"
git status --porcelain=v1 > "$SAFE/git-status"
git diff --binary HEAD > "$SAFE/tracked-corrections.patch"
cp -a deploy "$SAFE/deploy"
cp -a /srv/worktrack/supabase/docker/.env "$SAFE/supabase.env"
cp -a /srv/worktrack/supabase/docker/docker-compose.worktrack.yml "$SAFE/" # if present
OLD_IMAGE="$(docker inspect -f '{{.Image}}' worktrack-web)"
OLD_TAG="worktrack-web:pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
docker image tag "$OLD_IMAGE" "$OLD_TAG"
printf '%s\n' "$OLD_TAG" > "$SAFE/old-image-tag"
set -a
source "$ENV_FILE"
set +a
export SUPABASE_CONFIG_DIR="/srv/worktrack/supabase/docker"
```

If your environment file, Storage directory or overlay paths differ, use their **actual existing paths**. Copy every extra overlay/config file into the protected backup. Never print `.env`, private keys, full rendered Compose configuration or service-role keys into chat or shared logs.

Use a direct/session-mode administrative PostgreSQL connection for migration/backup scripts; do not use transaction pooling for session advisory locks. Keep it localhost/private.

## 2. Quiesce and back up

Temporarily put only the two WorkTrack NPM hosts into maintenance/block external requests, stop field devices and other WorkTrack writers, then stop only the app. Stopping the web container alone does not stop phones calling the API directly. Do not stop unrelated containers.

```bash
C=(docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.yml)
if test -f deploy/docker-compose.override.yml; then
  C+=(-f deploy/docker-compose.override.yml)
fi
# Add any additional existing overlays and the actual existing project name here.
"${C[@]}" stop worktrack-web
export BACKUP_QUIESCED_CONFIRM='ALL WRITERS STOPPED'
bash deploy/scripts/backup.sh
```

The old installed backup script may not yet produce the new manifest. Preserve its backup too; after updating source in step 3, run the new script before migrations. Its manifest must contain database/storage/configuration checksums and `quiesced: true`. Verify an isolated full restore before live upgrade. Do not treat checksums alone as proof of recovery.

## 3. Update code without discarding the manual corrections

The three original corrected paths are `Dockerfile`, migration `202611270006_increment_e_reports_vehicles_notifications.sql`, and `deploy/scripts/create-user.sh`. Their upstream corrections now exist; do not blindly reapply the old patch afterward.

```bash
git fetch origin
read -r -p 'Approved release commit (hex SHA): ' RELEASE
[[ "$RELEASE" =~ ^[0-9a-f]{7,40}$ ]] || exit 1
git rev-parse --verify "${RELEASE}^{commit}"
git diff HEAD "$RELEASE" -- Dockerfile deploy/scripts/create-user.sh \
  db/migrations/202611270006_increment_e_reports_vehicles_notifications.sql \
  deploy/docker-compose.yml
```

Inspect the saved patch and any other local modifications. **Only after reviewing those specific backed-up paths**, restore their tracked working versions to the old HEAD so the fast-forward can apply:

```bash
git restore --source=HEAD --staged --worktree -- Dockerfile \
  deploy/scripts/create-user.sh \
  db/migrations/202611270006_increment_e_reports_vehicles_notifications.sql \
  deploy/docker-compose.yml
git merge --ff-only "$RELEASE"
```

Stop on any conflict or additional tracked correction. Never use `reset --hard`, `clean`, a force push, or a blanket restore. Never replace existing `.env` files or recreate existing users/businesses.

## 4. Reconcile Compose and runtime configuration

Keep the new application definition's Node/Bun build and server-side environment entries, and merge the **existing** port/network corrections from `$SAFE/deploy`. Preserve `deploy/docker-compose.override.yml` and its `npm-proxy` external network. Do not copy the old base file wholesale over the new one: it may omit newly required server environment settings.

Required configuration, using existing values:

- Browser build: `VITE_SUPABASE_URL=https://worktrack-api.clickcraft.tech` and the existing `VITE_SUPABASE_ANON_KEY`.
- Runtime server: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (existing public key), and `SUPABASE_SERVICE_ROLE_KEY` server-only. The new base Compose maps these; preserve that mapping.
- Existing `DATABASE_URL` and actual `STORAGE_DATA_DIR`; export `SUPABASE_CONFIG_DIR` for backups.
- Existing app localhost port 3080 and Envoy localhost port 8400; no new public PostgreSQL or admin port.

Rebuild `C` using the **actual same project name and complete overlay list**. Review resolved configuration privately; do not publish its secret-bearing output. Confirm `docker network inspect npm-proxy` succeeds.

## 5. Baseline previously applied migrations — only if needed

Read the existing `public.schema_migrations_worktrack` history. If it already records 0001–0008 correctly, skip baselining. If those migrations were manually installed without history, independently verify their tables, types, functions, grants and policies before recording the baseline:

```bash
export WORKTRACK_BASELINE_CONFIRM='VERIFIED MIGRATIONS 0001-0008'
bash deploy/scripts/baseline-existing-migrations.sh
unset WORKTRACK_BASELINE_CONFIRM
```

This records only the original eight filenames, **without executing their SQL**. It does not mark 0009–0024 applied. `migrate.sh` now refuses an existing schema lacking that baseline rather than replaying it.

## 6. Take the new-format backup, build, migrate and start

```bash
export BACKUP_QUIESCED_CONFIRM='ALL WRITERS STOPPED'
bash deploy/scripts/backup.sh
"${C[@]}" build worktrack-web
bash deploy/scripts/migrate.sh
"${C[@]}" up -d --no-build --no-deps worktrack-web
"${C[@]}" ps
curl -fsS http://127.0.0.1:3080/auth >/dev/null
```

There are **24 migration files**: eight original (`202611270001`–`202611270008`) and sixteen forward upgrades (`202611280009`–`202611280024`). No new server-side environment variables or Nginx Proxy Manager / Envoy reverse proxy changes are required for `0021`–`0024`. Check `public.schema_migrations_worktrack` (expect 24 rows) and run the restore verifier on the isolated copy before promoting.

Migration **0024** serializes direct financial writes and enforces opening, verification, schedule and reversal integrity. It deliberately stops on inconsistent legacy openings, reversal targets/postings, restricted flags, evidence states or schedule ownership. It does **not** automatically create postings, mark evidence verified, reverse transactions or delete history. Preserve the failure and inspect the restored copy; obtain an independently verified correction before retrying. Do not disable its triggers or modify migration history to force success. Confirm the corrected release's regression tests and a fresh deep scan before production promotion. Validate any earlier `NOT VALID` constraints only after investigating legacy inconsistencies; never fabricate history.

Remove WorkTrack maintenance only after Admin/Owner/Supervisor, financial read-back, evidence and offline smoke checks pass. Do not execute `reset-business.sh` or `import-workers.sh` here.

## Recovery

A prior image may be incompatible with new epoch/approval APIs. Use `deploy.sh --rollback-image TAG` only for a tested schema-compatible image; there is no `--ref` or `--rollback` option. Prefer a tested roll-forward repair while writes remain blocked. `restore.sh` deliberately refuses the source production database; full recovery is an isolated replacement/promotion procedure, not an automatic in-place rollback.
