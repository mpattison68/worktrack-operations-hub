#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL (server-side PostgreSQL connection string) before running migrations.}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/../../db/migrations"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations_worktrack (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for file in $(ls -1 "$MIGRATIONS_DIR"/*.sql | sort); do
  base="$(basename "$file")"
  already="$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM public.schema_migrations_worktrack WHERE filename = '${base}'")"
  if [[ "$already" == "1" ]]; then
    echo "Skipping already-applied migration: $base"
    continue
  fi
  echo "Applying migration: $base"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations_worktrack (filename) VALUES ('${base}');"
done

echo "All WorkTrack migrations applied."