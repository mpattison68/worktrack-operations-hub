# Production-readiness status — 28 November 2026

## Release decision

**Not cleared for live deployment.** This is saved implementation work with isolated test evidence, not certification that every requested production workflow is finished. The live business, accounts, VM, configuration and data were not accessed or changed. Reset/import were not run.

## Implemented in this change

- Pinned Bun frozen-lock Docker dependency installation and Node server build target; transactional migration runner.
- Database-backed D/E bundle reads and compare-and-swap writes; tenant/actor/workflow/immutable-history guards; private vehicle fields and per-user notification receipts.
- Customer receipt and expense settlement histories, explicit saved forecasts and zero/unconfirmed production planning defaults.
- Authenticated account-management server functions and password/email controls; production does not silently fall back to synthetic data.
- Private evidence reservation, upload/finalization, parent selection and signed read URLs.
- Partitioned queue epochs, operational attendance/progress capture and assessment edit-version/idempotency controls.
- Explicit VM-only dry-run reset/import helpers, verified register, backups and isolated-restore tooling.

## Evidence actually obtained

- `bunx vitest run`: **11 files, 68 tests passed**.
- `production-database.test.ts`: 11 isolated PostgreSQL-compatible PGlite tests, including migration-chain execution, tenant/role rejection, balanced-posting rejection and API-shaped D/E repository operations.
- Latest automatic application build: passed.
- All deployment shell scripts: syntax passed; administration Python files: compilation passed.
- `bun install --frozen-lockfile`: passed under Bun 1.4.4.
- Chromium 390×844: synthetic mobile sign-in renders without horizontal overflow. This does **not** verify real account administration or a production business.

PGlite uses a test Auth/Storage schema; it does not validate the VM's PostgREST, GoTrue, storage service, extensions, Envoy, SMTP or Docker image.

## Open release work / validation

1. Exercise every real finance transaction, payroll draft/approval and weekly-report amendment through the full repositories, including partial receipts/settlements, immutable snapshots, repeated clicks and rollback after failure; harden any remaining non-atomic C/report workflow.
2. Verify account invites, existing-account linking, role changes, password/email changes and lockout prevention against the real Auth service in an isolated environment. Verify SMTP delivery; in-app notifications do not establish email delivery.
3. Run actual private upload/finalization/read/retry tests, including cleanup after upload failures and an orphan-object audit. Reset storage cleanup is not a transaction with SQL and its recovery procedure remains unproven.
4. Exercise attendance/progress/assessment offline capture, restart, duplicate reconnect, concurrent edits and reset-epoch rejection with two authenticated devices; audit legacy unpartitioned waypoint behavior and permitted cached references.
5. Run the reset/import dry-run and transaction/repeatability checks against a restored database, including exact 13-worker/rate verification and preservation of unrelated tables and accounts. Confirm management pay-calendar inputs before import.
6. Reconcile and test the preserved VM Compose overrides, Node Docker image, Postgres 17.6 migrations, Envoy/NPM connectivity, actual backup artifacts and isolated full restore.
7. Execute physical Android field and VM recovery drills. No live release gate is satisfied by the synthetic preview.

These remain on `roadmap.md`. Do not report the production-readiness request complete until they are verified.
