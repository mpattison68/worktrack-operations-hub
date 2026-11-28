# WorkTrack Roadmap

- [x] Preserve `docs/specification.md` and create `docs/implementation-plan.md`
- [x] Increment A: Design system, i18n (`en`), SAST/ZAR formatters, PWA manifest
- [x] Increment A: Portable Supabase client + synthetic dev adapter + auth (`/auth`, `/reset-password`) + RBAC permissions
- [x] Increment A: Mobile bottom nav + desktop sidebar + connection status bar + disabled stubs for B–F
- [x] Increment A: Business settings, memberships/invitations, and Job configuration
- [x] Increment A: Worker roles, effective-dated pay rules, worker roster, rate override requests, and job assignments
- [x] Increment A: Portable SQL migration (`db/migrations/`) and synthetic seed (`db/seed/`)
- [x] Increment A: Self-hosted Linux VM deployment skeleton (`Dockerfile`, `deploy/`)
- [x] Increment A: Unit & integration tests + browser verification
- [x] Increment B: 7-step assessment wizard, GPS/manual fallback, tappable verge diagram, sizing/benchmark/budget, admin approval & immutable scope revisions, portable SQL migration, T01–T04/T24 tests
- [x] Increment B Extension: Multi-waypoint GPS route capture, interactive Leaflet map editing, full-precision geodesic calculations, offline waypoint sync queue, `assessment_route_points` SQL migration, weekly-progress route projection helpers, updated spec/docs, and 10 acceptance tests
- [x] Increment C: Daily progress (interval union, full-completion overlap, rework exclusion, GPS snapping), interruptions log, Mon–Sun weekly attendance with individual exceptions, integer-cent payroll (midweek splits, OT/weekend classes, immutable approved revisions, worker statements), portable SQL migration (`202611270004`), and T05–T11/T21/T25 acceptance tests
- [x] Increment D: Bulk wage payments & allocations, mobile expenses with receipt photos/missing-receipt reasons, balanced cash ledger & transfer matching, customer milestones/receipts, zero-interest loan tracking & restricted funding guards, interactive weekly cash shortfall forecast, portable SQL migration (`202611270005`), and T12–T17/T21/T23 acceptance tests
- [x] Increment E: Auto-assembled Mon–Sun weekly reports (submit/return/approve/amend revision lock), management dashboard with Recharts charts & drilldowns, formula-injection-safe CSV/Excel/PDF exports, vehicle/equipment register & daily pre-use safety checks with STOP DO NOT USE defect workflow, deduplicated in-app notifications & preferences, portable SQL migration (`202611270006`), and T18/T21/T22 acceptance tests
- [x] Increment F: Guarded `vite-plugin-pwa` service worker, partitioned IndexedDB offline sync engine (T19/T20/T22/T26), conflict resolution UI, logout unsynced warning & local wipe, private `/photos` evidence capture, portable SQL migration (`202611270007`), VM backup/restore drill scripts (`backup.sh`, `restore.sh`, `verify-restore-drill.sh`), Android field trial & handover runbooks, and acceptance tests
## Production readiness (28 November 2026) — release gate OPEN
- [x] Candidate pinned-Bun Docker corrections and transactional migration runner; frozen install and script syntax verified
- [x] Implement D/E database adapters, isolated migration tests, explicit forecasts and private evidence paths
- [x] Implement tenant/actor/epoch guards, account administration, offline capture paths and controlled reset/import helpers
- [x] Preserve verified 13-worker requirements; no live reset/import executed
- [x] Record 68 passing tests and limitations in `docs/production-readiness-status.md`
- [x] Complete atomic payroll/scope approval and report review regressions; remaining real-service transaction/retry matrix is in environmental checklist
- [ ] Verify Auth administration, SMTP, private storage failures/orphans, and two-device offline/reset behavior (requires isolated service environment)
- [ ] Validate reset/import exact counts, rates, repeatability and recovery against a restored database (requires backup and management pay-calendar inputs)
- [ ] Reconcile preserved VM overrides and run Node Docker, PostgreSQL 17.6 upgrade and full backup/restore drills (requires isolated VM)
- [ ] Run physical Android trial and approve production release (requires customer devices and completed checks above)

## Implementation and release-readiness report request
- [x] Complete atomic payroll approval and source validation, strict weekly-report revisions, and atomic linked scope/job approval
- [x] Fix confirmed reset/import, cache and notification defects; add regression coverage
- [x] Re-run complete tests and document exact persistence, migration and security status
- [x] Write detailed isolated-VM/Android acceptance checklist and existing-VM upgrade procedure
- [x] Commit completed changes; distinguish local commit from unverifiable GitHub sync status

## Explicit implementation limits
- Scheduled SMTP email digests remain intentionally deferred; authentication password recovery (`/reset-password`) is implemented and requires isolated-VM SMTP verification.
- Completed in latest release: general financial transaction reversals (all 7 types), balanced non-cash opening loan reconciliation, Owner customer-receipt & loan-repayment workflows with Admin confirmation and instalment allocation, and offline field operations (bulk crew attendance, exceptions, exception reset, overtime, interruptions/rain/vehicle breakdown/downtime, progress/comments).
- Fresh deep security scan completed against `446a6679f9cf34b9fdcc1c6119ce25f6a7577c04`: no findings; real-service security verification remains an isolated-environment gate.

## Security review before isolated acceptance testing
- [x] Run quick and deep scans against the requested saved application commit; record backend and stale dependency-scan limitations
- [x] Correct financial control gaps in forward migration 0024 and paired repository writes; add 13 database regressions including all seven reversal types
- [x] Rerun complete automated suite: 14 files / 101 tests passed; shell syntax and Python compilation passed; automatic build OK
- [x] Run one separate two-session local PostgreSQL 17.12 direct-write concurrency/rollback drill; no production connection
- [x] Update release report, 24-migration acceptance checklist and cautious existing-VM upgrade procedure with limitations
- [x] Commit corrected release and report exact final SHA in handover
- [ ] Fresh deep scan of corrective release before production approval (requested scan covered original 446a667; corrective changes require a subsequent saved-snapshot scan)
