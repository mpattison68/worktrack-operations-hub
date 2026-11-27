#!/usr/bin/env bash
set -euo pipefail

# WorkTrack single-command deployment & rollback script for self-hosted Linux VM.
# Usage:
#   bash deploy/scripts/deploy.sh                 # backup -> pull main -> migrate -> rebuild -> healthcheck
#   bash deploy/scripts/deploy.sh --ref v1.2.0    # deploy a specific git tag or commit
#   bash deploy/scripts/deploy.sh --rollback <sha> # roll back app container to a prior git commit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_DIR}/deploy/.env}"
COMPOSE_FILE="${REPO_DIR}/deploy/docker-compose.yml"
TARGET_REF="main"
MODE="deploy"
SKIP_BACKUP="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      TARGET_REF="${2:?Missing value for --ref}"
      shift 2
      ;;
    --rollback)
      MODE="rollback"
      TARGET_REF="${2:?Missing git commit/tag for --rollback}"
      shift 2
      ;;
    --skip-backup)
      SKIP_BACKUP="true"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Environment file not found at ${ENV_FILE}. Copy deploy/.env.example to deploy/.env first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$REPO_DIR"
PREVIOUS_SHA="$(git rev-parse --short HEAD)"
BIND_HOST="${WORKTRACK_BIND_HOST:-127.0.0.1}"
BIND_PORT="${WORKTRACK_BIND_PORT:-3080}"

echo "=== WorkTrack ${MODE} (current commit: ${PREVIOUS_SHA}) ==="

if [[ "$MODE" == "deploy" ]]; then
  if [[ "$SKIP_BACKUP" != "true" ]]; then
    echo "1/5 Taking pre-update database & storage backup..."
    bash "${SCRIPT_DIR}/backup.sh"
  else
    echo "1/5 Skipping backup (--skip-backup set)."
  fi

  echo "2/5 Fetching latest approved code from GitHub (${TARGET_REF})..."
  git fetch origin --tags
  if git show-ref --verify --quiet "refs/remotes/origin/${TARGET_REF}"; then
    git checkout "$TARGET_REF"
    git pull --ff-only origin "$TARGET_REF"
  else
    git checkout "$TARGET_REF"
  fi

  echo "3/5 Applying pending PostgreSQL migrations..."
  bash "${SCRIPT_DIR}/migrate.sh"
else
  echo "1/3 Rolling back repository checkout to ${TARGET_REF}..."
  echo "    NOTE: If a schema-breaking migration was applied, restore your pre-update DB backup with deploy/scripts/restore.sh."
  git fetch origin --tags
  git checkout "$TARGET_REF"
fi

NEW_SHA="$(git rev-parse --short HEAD)"
echo "Building and restarting worktrack-web container (${NEW_SHA})..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build --remove-orphans

echo "Waiting for health check at http://${BIND_HOST}:${BIND_PORT}/auth ..."
HEALTHY="false"
for _ in $(seq 1 30); do
  if curl -fsS "http://${BIND_HOST}:${BIND_PORT}/auth" >/dev/null 2>&1; then
    HEALTHY="true"
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != "true" ]]; then
  echo "ERROR: worktrack-web failed health check after 60s." >&2
  docker compose -f "$COMPOSE_FILE" logs --tail=50 worktrack-web >&2
  echo "To roll back to previous commit: bash deploy/scripts/deploy.sh --rollback ${PREVIOUS_SHA}" >&2
  exit 1
fi

echo "SUCCESS: WorkTrack ${NEW_SHA} is live and healthy on http://${BIND_HOST}:${BIND_PORT}"
echo "Previous commit recorded for rollback: ${PREVIOUS_SHA}"