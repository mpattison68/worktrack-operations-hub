# WorkTrack — Road-Verge Operations Hub

WorkTrack is a mobile-first web application and Progressive Web App (PWA) for managing South African road-verge clearing operations: job assessments with GPS route waypoints, daily progress tracking, team attendance, integer-cent ZAR payroll, field expenses, cash/loan ledger tracking, weekly reports, vehicle pre-use safety checks, private photo/receipt evidence, and offline sync.

Production runs independently on a customer-owned Linux VM using Docker Compose and self-hosted Supabase — with **zero runtime dependency on Lovable Cloud**.

## Architecture Summary
- **Frontend & SSR shell**: React 19, TanStack Start v1 / TanStack Router, Tailwind CSS v4, Vite, Leaflet (OpenStreetMap tiles), Recharts, and Workbox (`vite-plugin-pwa`).
- **Backend & Data**: Self-hosted Supabase (PostgreSQL with Row Level Security, GoTrue Auth, PostgREST, private Supabase Storage bucket `worktrack-evidence`, the existing Envoy API gateway).
- **Development mode**: Only in development, when `VITE_SUPABASE_URL` and the public key are unset, the app runs in a clearly badged synthetic browser-storage mode (`Synthetic dev mode`) for UI testing without a database.
- **Authoritative specification**: [`docs/specification.md`](docs/specification.md)

## Production release gate

**Not cleared for live deployment.** Read [`docs/production-readiness-status.md`](docs/production-readiness-status.md) for tested changes and outstanding validation. The existing VM, business, accounts and local overrides were not changed.

## Documentation
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — Deployment architecture, deployment readiness review, VM sizing, and 16-step self-hosted VM installation guide
- [`CONFIGURATION.md`](CONFIGURATION.md) — Environment variables, self-hosted Supabase Auth/SMTP/Storage config, reverse proxy (Nginx & Caddy), and security settings
- [`BACKUP_AND_RESTORE.md`](BACKUP_AND_RESTORE.md) — Automated daily backups, encryption, off-site sync, retention, and full VM disaster recovery
- [`UPGRADING.md`](UPGRADING.md) — Single-command updates from GitHub, migration safety, health checks, and rollback
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — Common build, Auth, RLS, Storage, HTTPS, GPS, and PWA issues
- [`docs/android-field-trial-checklist.md`](docs/android-field-trial-checklist.md) — Physical Android handset test checklist (T26)
- [`docs/vm-backup-and-handover-runbook.md`](docs/vm-backup-and-handover-runbook.md) — Isolated-VM restore drill and handover runbook (T27/T28)

## Local Development
Requires Node.js 22+ (or Bun).

```bash
git clone <your-private-github-repo-url>
cd worktrack
bun install --frozen-lockfile
bun run dev
```

Run the automated test suite:
```bash
bunx vitest run
```
