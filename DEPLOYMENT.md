# WorkTrack — existing VM deployment

**Release gate remains open. Do not apply this work to the live VM yet.** Read `docs/production-readiness-status.md` first.

## Existing installation to preserve

- App: `https://worktrack.clickcraft.tech`, localhost 3080.
- API: `https://worktrack-api.clickcraft.tech`, existing Envoy gateway on localhost 8400.
- PostgreSQL 17.6 via the existing Supavisor configuration.
- Nginx Proxy Manager and external Docker network `npm-proxy`.
- Repository `/srv/worktrack/app`; existing backend `/srv/worktrack/supabase/docker`.
- Preserve `deploy/.env`, `deploy/docker-compose.yml`, `deploy/docker-compose.override.yml`, backend `docker-compose.worktrack.yml`, existing credentials, Auth accounts and memberships.
- Existing Vuyo Contracting business `d7afd88f-4a5e-4dcd-8af9-c58e835f561e` must not be recreated.

Do not reinstall the backend, replace Nginx Proxy Manager, expose database ports, copy templates over working configuration, or remove unrelated containers.

## Candidate upgrade, after release approval

1. Stop and inspect any tracked local corrections before updating Git. Preserve them outside the repository; never use a destructive reset to get a clean tree.
2. Make and verify a current database, storage and configuration backup using `deploy/scripts/backup.sh`.
3. Restore it into a separate test VM. Test all forward migrations and the real workflows there first.
4. Reconcile the updated application Compose definition with the preserved local definition and override. Keep `npm-proxy` and existing port mappings.
5. Build with the pinned Bun lockfile and `NITRO_PRESET=node-server`. Do not substitute `npm install` in Docker.
6. Apply only pending migrations through `deploy/scripts/migrate.sh`. Existing applied migration 0006 must not be replayed; the forward migrations are 0009–0020. Twenty files exist in total.
7. Restart only the WorkTrack web service using **both** the working base Compose file and its preserved override.
8. Verify HTTPS, Auth, permissions, two-device reads/writes, private evidence, offline conflicts and backup restore before admitting field data.

`deploy/scripts/deploy.sh` is a candidate helper, not a substitute for these release checks. No deployment, migration, account change, import or reset was executed from this workspace.

## Reset and verified worker import

These are separate, explicit administrative operations, never part of upgrade. The verified register contains 13 workers: 11 road workers at R250/day, Andile with an unconfirmed Supervisor rate, and an unnamed Cook at R500/week. Start dates, normal hours, calendar and cook proration still require explicit management input.

The scripts default to dry-run and require an authorized Admin, a recent matching backup and typed confirmations for execution. The reset uses an application-table allowlist, preserves the business/Auth identities and advances the offline epoch. Storage cleanup is separate from SQL and can fail partially; orphan objects and recovery must be audited before approving live execution.

## Android

Valid HTTPS is required. Follow `docs/android-field-trial-checklist.md` on physical Android devices. Offline service-worker behavior is deliberately disabled in editor previews; map tiles require connectivity. Desktop mobile emulation does not count as an Android field trial.
