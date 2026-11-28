#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env}"
set -a; source "$ENV_FILE"; set +a
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/deploy/docker-compose.yml")
if [[ -f "$ROOT/deploy/docker-compose.override.yml" ]]; then COMPOSE+=(-f "$ROOT/deploy/docker-compose.override.yml"); fi
MODE="${1:---local}"
if [[ "$MODE" == '--rollback-image' ]]; then
 IMAGE="${2:?Supply a schema-compatible saved image tag}"
 docker image inspect "$IMAGE" >/dev/null
 OVERRIDE="$(mktemp)"; trap 'rm -f "$OVERRIDE"' EXIT
 printf 'services:\n  worktrack-web:\n    image: %s\n' "$IMAGE" > "$OVERRIDE"
 "${COMPOSE[@]}" -f "$OVERRIDE" up -d --no-build --no-deps worktrack-web
else
 [[ "$MODE" == '--local' || "$MODE" == '--update' ]] || { echo 'Use --local, --update, or --rollback-image TAG' >&2;exit 1; }
 bash "$ROOT/deploy/scripts/backup.sh"
 if [[ "$MODE" == '--update' ]]; then
  [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]] || { echo 'Local tracked corrections exist. Preserve them and reconcile the three corrected files using UPGRADING.md; nothing was discarded.' >&2;exit 1; }
  git -C "$ROOT" pull --ff-only
 fi
 PREVIOUS="worktrack-web:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
 if docker image inspect worktrack-web:local >/dev/null 2>&1; then docker image tag worktrack-web:local "$PREVIOUS";echo "Saved previous app image: $PREVIOUS (check schema compatibility before rollback)";fi
 "${COMPOSE[@]}" build worktrack-web
 bash "$ROOT/deploy/scripts/migrate.sh"
 "${COMPOSE[@]}" up -d --no-build --no-deps worktrack-web
fi
for attempt in $(seq 1 30); do
 if curl -fsS "http://${WORKTRACK_BIND_HOST:-127.0.0.1}:${WORKTRACK_BIND_PORT:-3080}/auth" >/dev/null; then echo 'Application HTTP health check passed. Complete role/financial/offline smoke tests before returning to service.';exit 0;fi
 sleep 2
done
echo 'Health check failed; preserve database and use a compatible saved image. No unrelated services were restarted.' >&2
exit 1
