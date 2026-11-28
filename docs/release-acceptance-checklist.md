# Separate environmental acceptance checklist

All tests below are **UNEXECUTED** here. Run against an isolated restored copy, never use the live business as a test fixture. Record date, tester, release SHA, database migration history, device/build, expected/actual result and evidence. A failed check blocks release. Reset/import remain separate explicit operations.

## Linux VM and real-service checks

| ID | Procedure | Pass condition |
|---|---|---|
| VM01 | Restore a protected backup to a different database fingerprint and empty isolated Storage/config paths. | DB, Auth identities, metadata, files and configuration restore; source DB/production paths are refused. |
| VM02 | Compare original schema and migration history; baseline only independently verified 0001–0008 when absent; migrate twice. | Old SQL never replays; 0009–0023 apply once; second run skips all 23; failed migration and its history record roll back together; `verify-restore-drill.sh` confirms >= 23 migrations and RLS on `financial_reversals` and `loan_repayment_schedules`. |
| VM03 | Build the Node 22 image with frozen Bun; use preserved project name, base/overlays and `npm-proxy`. | Image starts non-root; HTTPS/Auth works; app 3080/API Envoy 8400 unchanged; unrelated containers/ports unaffected. |
| VM04 | Sign in with restored existing Admin, Owner and assigned Supervisor accounts. Try cross-business and direct REST reads. | Existing identities/memberships intact; Supervisor sees only assigned operational projections, not contract/cash/rates/VIN/payroll/report money. |
| VM05 | Owner saves a payroll draft. Admin approves, corrects with a reason, then reloads from another device. | Complete header/earnings/adjustments persist; only Admin approves; one current approved revision; prior revision/lines immutable. |
| VM06 | Inject unknown attendance, unconfirmed/missing OT rates, overlap, changed source input and failed child insertion. Retry after another device changes the week. | Approval blocked; no partial run or stale approval; explicit conflict/recalculate result. |
| VM07 | Submit/return/resubmit/approve/amend a real weekly report. Attempt direct forged/reordered/deleted history and Owner approval. | Ordered history persists; exact submitted snapshot locks; comments/reasons required; role and concurrency violations fail. |
| VM08 | Approve scope and force waypoint/storage/network failure; then retry. Try Owner reopening approved scope. | Scope, route and linked planned job commit together or none; no duplicate job; Owner cannot unlock it. |
| VM09 | Capture wages/allocations, partial expense payments, partial customer receipts (Admin & Owner), transfers, manual opening loan with non-cash ledger entry, loan advances/repayments (Owner repayment + Admin confirmation, explicit scheduled instalment allocation), grants, and Admin reversals across all 7 financial transaction types. | Read-back balances match integer-cent sources/journals; opening loan reconciles to `loan_liability` with R0.00 variance; reversals preserve originals, block duplicates, require Admin & reason, and update cash, receivables, allocations, schedules, and loan balances without distorting profitability. |
| VM10 | Repeat writes and simultaneous allocations/confirmations from two devices, including after a request times out. | No duplicate postings/over-allocation; conflict or safe retry, not silent overwrite. |
| VM11 | Upload each allowed evidence type, reload on another device, download signed URL; test forbidden parent, wrong tenant/epoch, oversized file and upload/finalization failure. | Private bytes and finalized metadata agree; unauthorized reads fail; retries do not duplicate; orphan cleanup/recovery is recorded. |
| VM12 | Create/invite an isolated user; change role/assignments/active flag, password/email, and attempt last-Admin removal and cross-business linking. | Server authorization, existing-account protection, last-Admin protection and session behavior correct; SMTP invitations/resets deliver to the configured domain. |
| VM13 | Capture a critical vehicle problem offline and online; clear it only with authorized resolution. | STOP DO NOT USE agrees with server outcome/defect; unauthorized clearance fails; persisted alert acknowledgement uses real notification ID. |
| VM14 | Test empty business and explicitly entered planning/forecast inputs. | No fabricated jobs, progress curves, worker liabilities or R171,000 shortage; unconfigured forecast/planning is clearly unconfirmed. |
| VM15 | Verify fresh backup artifacts, actual config/overlays, off-site encrypted copies, scheduled success/failure alerts and retention. Time a full restore. | Backup catalog/checksums plus real recovery work; plaintext is protected; restore role/ownership/Storage permissions verified; target RPO 24h/RTO 8h evidenced. |

## Controlled reset/import drill — restored isolated environment only

1. Seed **synthetic** fixture history, approved revisions, receipts, loans, reversals, evidence, two tenants and an unrelated application table. Do not import real finance or historical worker liabilities as fixtures.
2. Run reset dry-run. Verify the business ID/name/Admin actor, exact application allowlist, dependency order, preserved Auth/settings/memberships/roles/rates/audit/chart and backup fingerprint/checksums.
3. With all writers stopped and a quiesced verified backup, request reset using the exact typed confirmations. Force a database failure: no evidence file should have been deleted first.
4. Force Storage cleanup failure after database reset: maintenance remains enabled and protected `reset-plan.json` supports explicit resume. Verify every tenant-prefix object, including orphan objects, is accounted for. Never declare success while objects remain.
5. Confirm SQL history cleared only for the target business, account openings zero and epoch advanced. Other tenant/application records and Auth identities remain unchanged.
6. Import dry-run requires management-confirmed effective date, normal hours/workdays and Cook proration. Confirm 13 verified identities, eleven R250/day rates, Cook R500/week and no invented Andile rate/contacts/assignments.
7. Execute explicitly only after dry-run approval. Repeat unchanged input: no duplicate workers/rules. Changed existing terms/identity must fail instead of silently retaining or overwriting them.
8. Run `business-admin.py verify --require-clean`. Verify zero opening balances and no jobs, attendance, progress, payroll/earnings/adjustments, allocations/payments, expenses/settlements, journals, receipts, transfers, reconciliations, loans/events, forecasts or operational/evidence history. No artificial zero transaction may exist.
9. Reconnect a device with pre-reset queued records: old epoch must be rejected, never recreate deleted history. Confirm discard/recovery path and logout partition wipe.

The script has not been run on the live business or against the real Storage service here; these are release conditions, not completed results.

## Physical Android field checks

| ID | Procedure | Pass condition |
|---|---|---|
| A01 / T26 | Install from the customer's HTTPS domain; grant GPS/camera permissions; use actual field GPS while safely stopped. | Standalone app, readable controls, correct accuracy warnings and mapped coordinates; no emulation substitution. |
| A02 | Load permitted references while online. Switch to airplane mode, close/reopen app, then capture assessment draft, bulk crew attendance (Mon–Fri), individual worker exception & reset, overtime, work interruptions (rain delay, vehicle breakdown, downtime) with comments, daily progress/comments, expense/receipt and vehicle check. | All records persist as pending in the correct business/user partition across app restarts; no false “uploaded/synced” status; reconnect syncs without duplication. |
| A03 | Reconnect with weak/interrupted network and restart during upload. | Dependency order, idempotent replay, retry/backoff and bytes/metadata read-back verified. |
| A04 | Edit the same attendance/assessment/expense on phone and desktop; reconnect with stale version. | Both versions shown, explicit resolution, no silent overwrite; a second concurrent change requires another review. |
| A05 | Switch accounts/businesses and test logout with pending records; change role/assignments online. | Warning before discard, partition wipe, no cross-account cached data; incompatible cached audience not hydrated. |
| A06 | Capture a critical safety failure without connectivity; reconnect and resolve as Owner/Admin. | Immediate phone stop-use display and durable server defect/alert; unauthorized clearance rejected. |
| A07 | Capture evidence without/with GPS consent; test MIME/size and signed URL expiry. | Location omitted without consent; intended EXIF stripping/compression/hash and private access verified on actual handset files. |
| A08 | Test no-network app shell, unavailable map tiles, battery constraints, phone restart and PWA update. | Cached app opens only on supported published/self-hosted origin; route capture does not require tiles; returning installs update without stale-cache failure. |

**Known implementation limits to test honestly:** copying a prior week's schedule and management approvals require an active connection; scheduled SMTP email digests remain intentionally deferred. Authentication password recovery (`/reset-password`) is required and implemented but its live SMTP delivery must be verified in VM12.
