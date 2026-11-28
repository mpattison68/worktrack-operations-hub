#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL securely in the environment}"
command -v psql >/dev/null
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# One connection holds the advisory lock throughout all migrations. Strip only
# standalone transaction boundary statements; each migration and its history row
# then commit together. Never replay existing history (including corrected 0006).
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"
cat > "$TMP" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(78364291);
CREATE TABLE IF NOT EXISTS public.schema_migrations_worktrack (
 filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.schema_migrations_worktrack FROM PUBLIC, anon, authenticated;
SELECT to_regclass('public.businesses') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.schema_migrations_worktrack WHERE filename='202611270001_increment_a_foundation.sql') AS needs_baseline \gset
\if :needs_baseline
\echo Existing schema has no verified migration baseline. STOP: use baseline-existing-migrations.sh after confirming migrations 0001-0008.
\quit 3
\endif
SQL
while IFS= read -r file; do
 base="$(basename "$file")"
 [[ "$base" =~ ^[0-9]+_[a-zA-Z0-9_]+\.sql$ ]] || { echo "Invalid migration filename: $base" >&2; exit 1; }
 cat >> "$TMP" <<SQL
SELECT EXISTS (SELECT 1 FROM public.schema_migrations_worktrack WHERE filename = '$base') AS applied \gset
\if :applied
\echo Skipping $base
\else
\echo Applying $base
BEGIN;
SQL
 # Existing BEGIN/COMMIT wrappers are not nested: remove only whole-line wrappers.
 sed -E '/^[[:space:]]*(BEGIN|COMMIT|START TRANSACTION);[[:space:]]*(--.*)?$/Id' "$file" >> "$TMP"
 printf "\nINSERT INTO public.schema_migrations_worktrack(filename) VALUES ('%s');\nCOMMIT;\n\\endif\n" "$base" >> "$TMP"
done < <(printf '%s\n' "$ROOT"/db/migrations/*.sql | LC_ALL=C sort)
printf '\nSELECT pg_advisory_unlock(78364291);\n' >> "$TMP"
PGDATABASE="$DATABASE_URL" psql -X -f "$TMP"
echo 'All migrations applied; history and schema committed atomically.'
