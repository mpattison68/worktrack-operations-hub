<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## WorkTrack Architecture Rules

- **Portable Supabase client.** Use `@supabase/supabase-js` configured via `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (or `VITE_SUPABASE_PUBLISHABLE_KEY`) in `src/lib/supabase.ts` so the app runs identically on self-hosted Docker Compose Supabase and external Supabase with zero Lovable Cloud lock-in.
- **Dual data adapter.** Route all Increment A+ reads/writes through `src/lib/data/repository.ts`: live Supabase when env vars are set, or a clearly badged local synthetic dev store when no backend is configured yet.
- **Integer cents for money.** Store and compute all ZAR monetary values as integer cents (`bigint` in PostgreSQL, integer `number` in TypeScript); never use floating-point rand values for persistence or calculations.
- **Tenant & role boundary.** Enforce `business_id` isolation and `admin` / `owner` / `supervisor` permissions in both PostgreSQL RLS policies (`supabase/migrations/`) and client/server guards (`src/lib/permissions.ts`).
- **Portable SQL migrations.** Keep customer-owned SQL migrations in `db/migrations/` and synthetic dev seeds in `db/seed/` so they remain independent of Lovable Cloud and run cleanly via `deploy/scripts/migrate.sh` on self-hosted Supabase.
- **Translation-ready strings.** Keep user-facing UI strings in `src/i18n/en.ts` so isiXhosa (`xh`) can be added without refactoring components.

## Production hardening
- Use a stable, RLS-filtered bundle read and compare-and-swap database transactions for D/E repositories, because cross-device financial reads and writes must not rely on browser snapshots.
- Stamp partitioned offline mutations with the server business epoch and reject obsolete epochs, because an administrative reset must not resurrect old field data.
- Reserve evidence metadata before private upload and finalize afterward, because parent authorization and uploaded-file visibility must agree.
- Account administration uses authenticated portable server functions with the service key loaded only server-side, because browser role assertions cannot authorize Auth administration.
- Use pinned Bun and its frozen lockfile for the Node-targeted Docker build, because the VM build must reproduce the tested dependency graph.
- Reset only explicitly allowlisted application tables, because unrelated public tables must survive customer-business cleanup.

- Preserve raw financial tables for management and provide assigned-job operational projections to Supervisors, because UI-only financial redaction is not an access boundary.
- Keep payroll header, earnings, adjustments and approval in one source-validated database transaction, because separate requests can leave partial or stale payroll.
- Reset SQL before resumable Storage cleanup and retain maintenance until cleanup verification succeeds, because the services cannot share a transaction.
- Bootstrap legacy migration history only with explicit independently verified 0001–0008 confirmation, because an existing manually installed schema must never be replayed.
- Enforce financial source/verification/reversal integrity and serialize direct-table writes in database triggers as well as batch APIs, because authenticated callers can bypass browser workflow checks.
