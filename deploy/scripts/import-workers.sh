#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
set -a; source "${ENV_FILE:-$ROOT/deploy/.env}"; set +a
exec python3 "$ROOT/deploy/scripts/business-admin.py" import "$@"
