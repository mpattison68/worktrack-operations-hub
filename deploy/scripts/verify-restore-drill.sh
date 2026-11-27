#!/usr/bin/env bash
set -euo pipefail

# WorkTrack Acceptance Test T27: Isolated-VM Restore Verification Drill
# Verifies database schema, RLS enforcement, key tables, and private storage bucket after restore.

: "${DATABASE_URL:?Set DATABASE_URL pointing to the restored isolated staging/drill database.}"

echo "1. Checking WorkTrack migration ledger..."
MIGRATION_COUNT="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM public.schema_migrations_worktrack;")"
echo "   Applied migrations: ${MIGRATION_COUNT}"
if [[ "${MIGRATION_COUNT:-0}" -lt 7 ]]; then
  echo "FAIL: Expected at least 7 WorkTrack migrations (Increments A-F)." >&2
  exit 1
fi

echo "2. Verifying Row Level Security is enabled on critical tenant tables..."
DISABLED_RLS="$(psql "$DATABASE_URL" -tAc "
  SELECT count(*)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN (
      'businesses', 'memberships', 'jobs', 'workers',
      'payroll_runs', 'expenses', 'ledger_entries',
      'weekly_reports', 'vehicle_assets', 'sync_idempotency_keys', 'evidence_attachments'
    )
    AND c.relrowsecurity = false;
")"
if [[ "${DISABLED_RLS:-1}" -ne 0 ]]; then
  echo "FAIL: One or more critical tenant tables have RLS disabled!" >&2
  exit 1
fi
echo "   RLS enabled on all checked tenant tables."

echo "3. Verifying private evidence storage bucket is NOT public..."
PUBLIC_BUCKET="$(psql "$DATABASE_URL" -tAc "
  SELECT coalesce(
    (SELECT CASE WHEN public THEN 1 ELSE 0 END FROM storage.buckets WHERE id = 'worktrack-evidence'),
    0
  );
")"
if [[ "${PUBLIC_BUCKET:-1}" -ne 0 ]]; then
  echo "FAIL: worktrack-evidence bucket is marked public!" >&2
  exit 1
fi
echo "   Storage bucket worktrack-evidence is private."

echo "4. Verifying record counts for smoke validation..."
psql "$DATABASE_URL" -c "
  SELECT 'businesses' AS table_name, count(*) FROM public.businesses
  UNION ALL SELECT 'memberships', count(*) FROM public.memberships
  UNION ALL SELECT 'jobs', count(*) FROM public.jobs
  UNION ALL SELECT 'evidence_attachments', count(*) FROM public.evidence_attachments;
"

echo "PASS: Isolated-VM database & storage metadata restore drill checks succeeded."
echo "Next manual steps: sign in as Admin/Owner/Supervisor via the restored app URL and download a signed private receipt URL."