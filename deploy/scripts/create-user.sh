#!/usr/bin/env bash
set -euo pipefail

# WorkTrack server-side helper to create a user in self-hosted Supabase Auth (GoTrue)
# and link them to a business in public.memberships.
# Run ONLY on the VM using server-side credentials in deploy/.env (never in browser).
#
# Usage:
#   bash deploy/scripts/create-user.sh \
#     --email "admin@company.co.za" \
#     --name "Mark Pattison" \
#     --role "admin" \
#     --business-name "My Road Verge Business"
#
# Optional: pass --business-id <uuid> to add a user (e.g. Vuyo as 'owner') to an existing business.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/../.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${VITE_SUPABASE_URL:?Set VITE_SUPABASE_URL in deploy/.env}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in deploy/.env (server-side only)}"
: "${DATABASE_URL:?Set DATABASE_URL in deploy/.env}"

EMAIL=""
FULL_NAME=""
ROLE=""
BUSINESS_ID=""
BUSINESS_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --name) FULL_NAME="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --business-id) BUSINESS_ID="$2"; shift 2 ;;
    --business-name) BUSINESS_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$EMAIL" || -z "$FULL_NAME" || -z "$ROLE" ]]; then
  echo "Usage: $0 --email <email> --name <full_name> --role <admin|owner|supervisor> [--business-id <uuid> | --business-name <name>]" >&2
  exit 1
fi

if [[ "$ROLE" != "admin" && "$ROLE" != "owner" && "$ROLE" != "supervisor" ]]; then
  echo "ERROR: --role must be admin, owner, or supervisor." >&2
  exit 1
fi

read -rsp "Enter initial temporary password for ${EMAIL} (min 12 chars): " USER_PASSWORD
echo
if [[ ${#USER_PASSWORD} -lt 12 ]]; then
  echo "ERROR: Password must be at least 12 characters." >&2
  exit 1
fi

PAYLOAD="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2], "email_confirm": True, "user_metadata": {"full_name": sys.argv[3]}}))' "$EMAIL" "$USER_PASSWORD" "$FULL_NAME")"
unset USER_PASSWORD

AUTH_RESPONSE="$(curl -fsS -X POST "${VITE_SUPABASE_URL%/}/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")"

USER_ID="$(python3 -c 'import json,sys; data=json.loads(sys.stdin.read()); print(data.get("id",""))' <<< "$AUTH_RESPONSE")"
if [[ -z "$USER_ID" ]]; then
  echo "ERROR: Could not extract created user ID from GoTrue response." >&2
  exit 1
fi
echo "Created Supabase Auth user ${EMAIL} (id: ${USER_ID})."

if [[ -z "$BUSINESS_ID" ]]; then
  if [[ -z "$BUSINESS_NAME" ]]; then
    echo "ERROR: Provide --business-id <uuid> or --business-name <name>." >&2
    exit 1
  fi
  BUSINESS_ID="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v bname="$BUSINESS_NAME" -tAc \
    "INSERT INTO public.businesses (name) VALUES (:'bname') RETURNING id;")"
  echo "Created business '${BUSINESS_NAME}' (id: ${BUSINESS_ID})."
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v uid="$USER_ID" \
  -v bid="$BUSINESS_ID" \
  -v uemail="$EMAIL" \
  -v fname="$FULL_NAME" \
  -v urole="$ROLE" <<'SQL'
INSERT INTO public.profiles (id, email, full_name)
VALUES (:'uid'::uuid, :'uemail', :'fname')
ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;

INSERT INTO public.memberships (business_id, user_id, email, full_name, role, active)
VALUES (:'bid'::uuid, :'uid'::uuid, :'uemail', :'fname', :'urole'::public.app_role, true)
ON CONFLICT (business_id, user_id) DO UPDATE
  SET role = EXCLUDED.role, full_name = EXCLUDED.full_name, active = true;
SQL

echo "SUCCESS: Linked ${EMAIL} as '${ROLE}' in business ${BUSINESS_ID}."
echo "Ask the user to sign in and change their password via the Reset password flow."