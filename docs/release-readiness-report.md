# WorkTrack — implementation and release-readiness report

28 November 2026. Updated after completing manual opening loan liabilities, customer receivables, agreed repayment schedules, general financial transaction reversals (all 7 types), Owner loan/receipt workflows, offline field operations (bulk crew attendance, exceptions, overtime, interruptions/rain/vehicle breakdowns/downtime, progress/comments), and attendance verification guards. **Release verdict: ready for isolated VM and physical Android acceptance testing; not yet cleared for live production deployment until those environmental checks and a fresh deep security scan on this commit pass.** No production database, Auth account, VM, reset or import was accessed or changed.

## 1. Authoritative persistence

Configured production sessions now use the portable database adapter for these previously incomplete modules:

| Module | Database reads/writes now implemented | Verification obtained |
|---|---|---|
| Finance / Money | Accounts, wage payments and allocations, journal headers/lines, expenses, pre-purchase requests/review, transfers, reconciliations, customer milestones/partial receipts (Admin & Owner), settlements, manual opening loans with balanced non-cash ledger reconciliation, loan advances/repayments (Owner repayments with Admin confirmation), agreed repayment schedules with explicit instalment allocation, general financial reversals (all 7 types), restricted grants and explicit forecast assumptions | Isolated PGlite DB/RLS/trigger tests + synthetic end-to-end reversal/loan/Owner workflow tests. Full real-service financial flow still needs VM09/10. |
| Vehicles | Register/private VIN and cost, checks, defects/resolution and service/fuel records | Isolated register/check/stop-use/defect/alert read-back. Actual handset/offline checks still needed. |
| Weekly reports | Submit, return, resubmit, approve, amendment and ordered immutable review snapshots | Full repository review/amendment/read-back regression passes in isolated database. |
| Notifications | Persisted deduplicated alerts, preferences and per-user read/ack receipts | Persisted alert test; fixed returned alert IDs to match stored IDs. SMTP delivery/scheduler not established. |
| Evidence | Reserve metadata, upload private bytes, finalize metadata, parent selection and signed reads | Implementation present; actual Storage service success/failure/retry/orphan cases unexecuted. |
| Progress / attendance / payroll | Existing production CRUD plus queued offline capture/replay (bulk crew attendance, individual exceptions, exception resets, overtime, work interruptions/rain/vehicle breakdowns/downtime, and daily progress/comments), Supervisor attendance verification guards, and atomic source-validated payroll save/approval | Payroll role/rollback/correction/stale-source, attendance verification, and offline restart/idempotency tests pass. Real API/two-device flows remain environmental tests. |
| Assessments | Database assessments/waypoints and atomic scope-plus-planned-job approval with edit versions | Scope/job rollback and Owner lock-bypass regression passes. |

“Implemented” here means a production database code path exists—not that every function has passed a live Supabase end-to-end test. The D/E batch adapter is transactional and RLS-filtered, with a stable bundle snapshot and compare-and-swap updates; nested JSON is now cloned so editing review history cannot mutate the comparison baseline.

## 2. localStorage and offline authority

No configured-production domain repository intentionally uses localStorage as its authoritative database. Synthetic A–E stores remain authoritative **only in development synthetic mode**. Production does not silently fall back to them on failure.

Remaining browser storage is intentional: Auth tokens/session hydration, UI selections where present, and legacy development waypoint data. The old localStorage waypoint capture/reconnect path has been disabled for production; complete production drafts go to the partitioned IndexedDB queue. IndexedDB also stores permitted operational references and pending evidence/mutations; it is not authoritative approved payroll/finance. Reference cache excludes payroll/finance bundles and wage rules, strips worker openings, and checks role/assignment audience and business epoch before hydration.

A field device that is genuinely offline cannot receive immediate remote revocation; test account/role changes, reconnect and partition wipe on hardware.

## 3. Three original deployment defects

1. **Migration 0006 helper/type defect:** undefined `is_business_member` calls replaced by `has_business_role` and explicitly typed `public.app_role[]`. Corrected source is saved. Do not replay the already applied migration; forward migrations handle upgrades.
2. **Docker dependency defect:** Node 22 retained; Bun pinned to 1.4.4, `bun.lock` and `bunfig.toml` copied, frozen install used; Node Nitro target retained. Frozen installation passed here; actual Linux Docker image remains unexecuted.
3. **create-user psql substitution defect:** wrapper delegates to Python and SQL is supplied on stdin rather than broken `psql -c` variable substitution. Account creation now creates a missing business only inside the membership transaction and compensates a failed new-account link. Existing VM identities must not be recreated.

The repository corrections exist. GitHub synchronization itself cannot be verified from the available Git-sync tools; see section 10.

## 4. New migrations

Original 0001–0008 remain the installation baseline. Fifteen forward migrations now exist (**23 migrations total**):

| File prefix | Purpose |
|---|---|
| `202611280009_production_persistence` | D/E transactional CAS, epochs, idempotency, financial/safety/tenant guards |
| `202611280010_private_evidence_and_reset_epoch` | Private metadata reservation/finalization and scoped Storage |
| `202611280011_user_administration` | Admin authorization/throttling and membership management |
| `202611280012_controlled_worker_import` | Stable unique worker import keys |
| `202611280013_epoch_and_operational_security` | Maintenance/epoch enforcement and operational actor/access guards |
| `202611280014_receipts_settlements_forecasts` | Partial receipt/settlement histories and saved assumptions |
| `202611280015_private_asset_data_and_history` | Private VIN/costs, per-user alert receipts, payroll-child immutability |
| `202611280016_confirmed_planning_and_financial_guards` | Explicit planning defaults and transfer/loan/source guards |
| `202611280017_atomic_assessments_and_offline_capture` | Atomic route/draft capture, replay and stable bundle reads |
| `202611280018_atomic_approval_workflows` | Atomic payroll, source validation, strict report transitions and linked scope/job approval |
| `202611280019_bidirectional_financial_integrity` | Recorded grant sources, bidirectional postings, transfer locks, allocation locking and review-trigger repair |
| `202611280020_operational_read_boundaries` | Assigned operational projections, raw financial read denial, progress reviewer guard and private replay receipts |
| `202611280021_attendance_verification_and_guards` | Supervisor attendance reported/verified workflow, approved-week lock, assignment/hours checks, and progress insert hardening |
| `202611280022_loan_opening_and_repayment_schedule` | Manual opening loan metadata & immutability lock, `loan_repayment_schedules`, and duplicate payment reference guards |
| `202611280023_reversals_owner_workflows_and_offline_ops` | `financial_reversals` (all 7 types), balanced non-cash `loan_opening` ledger reconciliation, Owner customer-receipt & loan-repayment RLS/verification, instalment `schedule_id` link, and offline interruption / exception-reset capture |

All files end `.sql`. The entire **23-file chain** executes in isolated PGlite with test Auth/Storage scaffolding; PostgreSQL 17.6 extensions, actual grants/PostgREST/Storage and existing legacy data still need testing. New uniqueness constraints may expose existing inconsistencies; do not delete or invent history to force an upgrade through.

## 5. Approval gaps found and completed now

The previous “approval workflows outstanding” statement included genuine implementation defects:

- Payroll header/earnings/adjustments/approval were separate requests, leaving partial drafts after failures. Owner draft was blocked by direct-table Admin-only writes. The old approval audit also passed text to a UUID column. **Fixed:** one permission-checked atomic RPC, source fingerprint, revision guard, complete-worker/earnings checks, server-derived reviewer identity, unknown/unconfirmed/overlap approval blocking and retained immutable corrections.
- Report review mutated nested arrays shared with the CAS baseline and hit a JSON operator-precedence error. History checks used containment rather than exact ordered prefixes. **Fixed:** cloned snapshots, corrected triggers, explicit state/revision rules, exact retained history, required return comments and exact submitted snapshot locking. Submit/return/resubmit/approve/amend/read-back passes.
- Scope approval created a planned job before assessment persistence and permitted a privileged Owner save to reopen approved scope. **Fixed:** job, job revision, assessment and waypoints share one transaction; Owner cannot unlock submitted/approved records.

These approval implementations are complete for the described paths and pass isolated regressions. Real-service UI/API, concurrent clients, SMTP and physical-device acceptance remain **verification**, not missing approval code.

## 6. Test breakdown

### Previous completed run

**68 passed, 0 failed, 0 skipped** across 11 Vitest files. Those were not 68 live-VM tests.

| Suite | Previous passed | Current passed | Coverage |
|---|---:|---:|---|
| Increment A domain | 6 | 6 | Domain validation and rate maintenance |
| Increment A permissions | 4 | 4 | Role/tenant permissions |
| Increment A migration | 3 | 3 | Portable schema/grant rules |
| Increment B assessments | 7 | 7 | Sizing, verges, scope/planning |
| Increment B waypoints | 6 | 6 | Geometry, route ordering/sync helpers |
| Increment C progress/payroll | 12 | 12 | Interval union, completion/rework, rates/OT, attendance/payroll arithmetic |
| Increment D finance | 8 | 8 | Allocation, ledger/cash/loan/restricted-funding calculations |
| Loan & contract financials | — | 1 | Zero opening state, R256,900 opening loan, R440,000 contract partial receipts, advances, schedules, overdue forecast, final settlement, exports & role guards |
| Reversals, Owner workflows & offline ops | — | 3 | All 7 financial reversals, non-cash opening ledger reconciliation, Owner receipts/repayments & instalment allocation, offline bulk attendance/exceptions/overtime/interruptions restart & idempotent sync |
| Increment E reports/vehicles | 4 | 4 | Report locks/exports and safety evaluation |
| Increment F sync | 6 | 6 | Queue/PWA/partition and sync rules |
| Routing | 1 | 1 | Route/access wiring |
| Production database | 11 | 26 | Complete 23-migration chain, isolated SQL/RLS, adapter read-back, CAS, approvals/rollback/corrections, attendance verification, opening loan & schedules, reversals, Owner RLS, and offline interruption idempotency |
| Administration script wrapper | — | 1 | Runs four Python planning/control unit checks |
| **Total Vitest** | **68** | **88** | **14 current files** |

Latest full run: **88 passed, 0 failed, 0 skipped** across **14 test files**. The script wrapper contains **four passing Python unit checks**; do not double-count these as four additional Vitest tests. Shell syntax (`bash -n deploy/scripts/*.sh`) and Python compilation (`py_compile`) pass. Automatic application build passes.

New regressions initially exposed real UUID, JSON-expression and shared-snapshot failures; these were corrected and rerun. There is no remaining failed test in the final suite. Tests requiring real Auth/Storage/Docker/Postgres services or Android were **not run**, not skipped automated tests. The separate checklist contains 15 VM checks, nine controlled reset/import drill steps and eight Android checks; several are multi-step scenarios.

## 7. Reset/import completion and zero balances

**Scripts implemented; real execution/drill unverified. Neither was run live.**

Reset is explicit, business/name/Admin scoped, allowlisted and backed by a recent matching quiesced DB/Storage/config backup. It recomputes its plan after maintenance, clears SQL history first, advances the epoch and retains maintenance while a protected plan drives resumable Storage cleanup. It does not delete files before a failed SQL reset. Remaining/orphan tenant-prefix objects prevent a success declaration. The services cannot share one transaction; a cleanup failure is a visible pending administrative state, not an automatic rollback or completed reset.

Import defaults to dry-run, uses stable keys/IDs and transactionally validates identities and exact existing rate terms instead of silently ignoring conflicts. It requires explicit effective date, normal hours/workdays and Cook proration—those values were not inferred from “Verified.” Eleven road workers use 25000 cents/day; Cook uses 50000 cents/week; Andile's Supervisor rate remains absent/unconfirmed. No contacts, assignments, jobs, payroll or financial transactions are invented.

Clean-start assertions check all allowlisted operational/financial tables, account and worker opening balances, exact 13-worker distribution/identity and absent Supervisor pay. SQL history is removed, not offset by fake zero transactions. **This is a conditional implementation guarantee under the verified closed maintenance procedure, not a guarantee that the live database is already clean or that concurrent privileged writers cannot violate it.** The isolated Storage/reset/import drill must pass before authorizing execution.

## 8. Fictitious forecasts

The hardcoded R171,000 shortfall and default planned Wk1–Wk4 progress figures are removed from production calculations/display paths. Forecasts use explicit saved assumptions and actual account/receipt data; absent inputs are unconfirmed. Production scope fallback does not fabricate a 10 km job. Synthetic development fixtures still exist and must not be imported into production. Existing historical rows are not automatically reset by migrations.

## 9. Security and remaining implementation

The deep scan examined the prior saved commit and found raw assigned-job finance exposure and progress self-verification, plus a warning about human-reported attendance. This review implements database-side operational projections/raw-table denial and a server reviewer/actor guard, with regressions. It also closes arbitrary/reused/unposted ledger sources, transfer fact mismatch, allocation locking, receipt-total and Owner scope-unlock defects. The scan has **not re-certified the new commit**. The quick database scan was incomplete because this workspace is not connected to the actual backend. Do not call the application security-clean.

Attendance remains human-reported by authorized field staff: Admin must review before payroll approval; software cannot prove hours actually worked. Continue real RLS/storage/session/role-change abuse tests.

**Remaining deferred / unverified items:**
- **Intentionally deferred:** scheduled SMTP email notification digests.
- **Required & implemented, environmentally unverified:** authentication password recovery (`/reset-password`) and invitation emails (real SMTP delivery must be verified on the isolated VM).
- **Environment variables & reverse proxy:** no new server-side environment variables or Nginx Proxy Manager / Envoy reverse proxy changes were added in this release beyond `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and `STORAGE_DATA_DIR` documented in `deploy/.env.example` and `CONFIGURATION.md`.
- **Security re-scan:** a fresh deep security scan against this newly committed snapshot (covering opening loans, financial reversals, Owner workflows, and offline sync) must be triggered after this commit is saved.

**Implemented but environmentally unverified:** actual Node Docker build, Postgres 17.6 upgrade/legacy constraints, GoTrue account workflows and sessions, SMTP invitation/reset delivery, private Storage finalization/retry/orphan recovery, multi-device replay/conflicts, exact reset/import/drain guarantees, encrypted off-site scheduling, full restore and physical Android GPS/PWA.

## 10. Commit, GitHub and handover

Changes are committed locally when this request concludes. Lovable pushes through the connected Git integration afterward; the agent cannot inspect its connection/status or confirm remote delivery. Verify the new commit in Project settings → Git and the actual GitHub repository before fetching it on the VM. Do not infer synchronization from a local commit alone.

The exact non-destructive upgrade is `UPGRADING.md`. It preserves local corrections, environment and Compose overlays, baselines verified original migrations without replay, builds before applying pending migrations and restarts only WorkTrack. The separate detailed acceptance checklist is `docs/release-acceptance-checklist.md`. No upgrade command runs the business reset or worker import.
