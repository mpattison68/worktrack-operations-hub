#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set the existing database connection securely}"
[[ "${WORKTRACK_BASELINE_CONFIRM:-}" == 'VERIFIED MIGRATIONS 0001-0008' ]] || { echo 'Requires WORKTRACK_BASELINE_CONFIRM=VERIFIED MIGRATIONS 0001-0008 after independent schema verification.' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
{
 cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(78364291);
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['businesses','memberships','jobs','job_revisions','workers','pay_rules','assessments','assessment_route_points','progress_entries','attendance_entries','payroll_runs','journal_entries','expenses','assets','weekly_reports','notifications','evidence_attachments','sync_idempotency_keys'] LOOP
 IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'Existing migration baseline incomplete: %',tab;END IF;
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS public.schema_migrations_worktrack(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON public.schema_migrations_worktrack FROM PUBLIC,anon,authenticated;
SQL
 for file in "$ROOT"/db/migrations/20261127000[1-8]_*.sql; do
  printf "INSERT INTO public.schema_migrations_worktrack(filename) VALUES ('%s') ON CONFLICT DO NOTHING;\n" "$(basename "$file")"
 done
 printf 'COMMIT;\n'
} | PGDATABASE="$DATABASE_URL" psql -X -v ON_ERROR_STOP=1
printf '%s\n' 'Recorded verified 0001-0008 filenames only; their SQL was NOT replayed. No later migration was baselined.'
