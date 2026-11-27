# WorkTrack — Staged Implementation Plan (Increments A–F)

Authoritative source: `docs/specification.md` (Version 1.0, 26 November 2026).

## Delivery Approach
WorkTrack is built sequentially in six increments (A–F). Each increment ships working, persistent functionality with migrations, tests, and known limitations before proceeding to the next increment. Unbuilt increment modules are explicitly marked disabled rather than mocked.

## Increment A — Foundation, Auth, Permissions, Jobs, Workforce & VM Skeleton (Current)
- **Scope**:
  - Design system (high-contrast field-ready palette, 44px+ touch targets, `dd MMM yyyy` SAST dates, ZAR integer-cent formatting, `src/i18n/en.ts` dictionary).
  - Navigation: mobile bottom bar (`Home`, `Work`, `Workers`, `Money`, `More` → `Assess job`, `Truck check`, `Photos`, `Weekly report`, `Settings`) and desktop sidebar (`Overview`, `Assessments`, `Jobs`, `Workers`, `Payroll`, `Expenses`, `Cash flow`, `Loans`, `Vehicles`, `Reports`, `Settings`).
  - PWA web app manifest (`public/manifest.webmanifest`) and connection status bar (offline queue designed from A, full SW/IndexedDB sync completed in F).
  - Invitation-only authentication (`/auth`), password reset (`/reset-password`), role-based permissions (`admin`, `owner`, `supervisor`) scoped by `business_id`.
  - Business settings, memberships/invitations, job configuration with lifecycle states and contract values in ZAR cents.
  - Worker roles, effective-dated pay rules (non-overlapping date ranges, no invented statutory overtime rates), worker roster (preserving former workers), individual rate override requests/approvals, and job assignments.
  - Portable PostgreSQL schema & RLS migrations (`supabase/migrations/202611270001_increment_a_foundation.sql`) and separate synthetic dev fixtures (`supabase/seed/synthetic_dev_fixtures.sql`).
  - Self-hosted Linux VM deployment skeleton (`Dockerfile`, `deploy/docker-compose.yml`, `deploy/nginx.conf`, `deploy/.env.example`, `deploy/scripts/migrate.sh`, `backup.sh`, `restore.sh`, `deploy/README.md`).
- **Acceptance Gate Coverage**: T21 (role & cross-business isolation foundation), T11 (effective-dated rate range validation foundation), T28 (portable Supabase client & VM deployment skeleton).

## Increment B — Site Assessment, Sizing, Benchmark & Scope Revisions
- **Scope**: 7-step Assessment Wizard with save-and-resume, multi-waypoint GPS route capture (Start, intermediate Waypoints, End, Undo, Save incomplete route, poor-accuracy retry, duplicate/proximity checks, safety reminder, offline queue with deduplicated sync), interactive Leaflet route map (markers, polyline, segment & cumulative distances, add/move/insert/reorder/delete), full-precision WGS-84 geodesic distance calculation kept separate from road-network distance and manual contractual overrides, weekly-progress chainage projection helpers, single/dual carriageway tappable verge diagram (1–4 strips, shared median anti-double-count), clearing widths, difficulty selector (0.60–1.60), required activities, benchmark productivity & budget sizing, admin review/return/approval creating immutable job baseline revision and versioned scope amendments, and portable SQL migrations (`202611270002` & `202611270003`).
- **Acceptance Gate Coverage**: T01, T02, T03, T04, T04a, T04b, T24.

## Increment C — Daily Progress, Interruptions, Weekly Attendance & Payroll
- **Scope**: Daily/weekly work progress by chainage/verge/activity with interval union & full-completion overlap logic, rework tracking, interruptions log, weekly Mon–Sun team attendance pattern with individual worker exceptions, server-side integer-cent payroll calculation, effective-date midweek rate splits, and restricted worker statements.
- **Acceptance Gate Coverage**: T05, T06, T07, T08, T09, T10, T11, T25.

## Increment D — Wage Payments, Expenses, Balanced Ledger, Loans & Cash Forecast
- **Scope**: Bulk wage payment capture with allocation table and advance tracking, mobile expense capture with receipt photos and missing-receipt reasons, double-entry/balanced cash ledger (unrestricted vs restricted accounts), transfer matching without duplication, customer milestones/receipts, loan account tracking (R0 interest, repayments separate from opex), and weekly cash shortfall forecast.
- **Acceptance Gate Coverage**: T12, T13, T14, T15, T16, T17, T23.

## Increment E — Weekly Reports, Management Dashboard, Exports, Vehicles & Notifications
- **Scope**: Auto-assembled Mon–Sun weekly report with submit/return/approve/revision lock, management dashboard with planned vs actual charts and drilldowns, CSV/Excel/PDF exports (with CSV formula injection escaping), vehicle pre-use safety checks with immediate STOP DO NOT USE defect workflow, and deduplicated in-app/SMTP notifications.
- **Acceptance Gate Coverage**: T18, T22 (online/local defect workflow).

## Increment F — Offline Sync Engine, Security Hardening & Production Rollout
- **Scope**: Guarded `vite-plugin-pwa` service worker, IndexedDB partitioned by user/business, idempotent mutation queue with dependency ordering (record before attachment), revision conflict resolution UI (no silent LWW), logout unsynced warning & local data wipe, security/RLS penetration tests, Android field usability trial, backup/restore drill on isolated VM, and final handover runbook.
- **Acceptance Gate Coverage**: T19, T20, T22 (offline defect), T26, T27, T28.
- **Status**: Application code, portable SQL migration (`202611270007`), automated tests, backup/restore verification scripts, and Android/VM drill runbooks complete; physical Android handset field trial (T26) and isolated Linux VM restore execution (T27/T28) remain user-executed on customer hardware.