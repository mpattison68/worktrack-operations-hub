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
- [ ] Increment F: Offline IndexedDB sync engine, conflict resolution UI, security/RLS audit, Android field trial & VM handover (held at Increment E boundary pending user review)