#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
elif [[ -f .env.example ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.example
  set +a
fi

: "${PORT:=3000}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"
: "${GITHUB_OAUTH_CLIENT_ID:?GITHUB_OAUTH_CLIENT_ID is required}"
: "${GITHUB_OAUTH_CALLBACK_URL:?GITHUB_OAUTH_CALLBACK_URL is required}"

echo "[e2e] Starting backend server"
node src/server.js >/tmp/actions-ci-e2e.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://localhost:${PORT}/health" >/dev/null; then
  echo "[e2e] Backend did not become healthy"
  exit 1
fi

echo "[e2e] Validating OAuth login redirect"
HEADERS_FILE="$(mktemp)"
curl -sS -D "$HEADERS_FILE" -o /dev/null "http://localhost:${PORT}/auth/github/login"
LOCATION="$(grep -i '^location:' "$HEADERS_FILE" | sed 's/\r$//' | awk '{print $2}')"

if [[ -z "$LOCATION" ]]; then
  echo "[e2e] Missing OAuth redirect location"
  exit 1
fi

if [[ "$LOCATION" != https://github.com/login/oauth/authorize* ]]; then
  echo "[e2e] Unexpected OAuth location: $LOCATION"
  exit 1
fi

if [[ "$LOCATION" != *"client_id=${GITHUB_OAUTH_CLIENT_ID}"* ]]; then
  echo "[e2e] OAuth location missing client_id"
  exit 1
fi

ENCODED_CALLBACK="$(python3 - <<'PY'
import os
import urllib.parse
print(urllib.parse.quote(os.environ['GITHUB_OAUTH_CALLBACK_URL'], safe=''))
PY
)"
if [[ "$LOCATION" != *"redirect_uri=${ENCODED_CALLBACK}"* ]]; then
  echo "[e2e] OAuth location missing redirect_uri"
  exit 1
fi

echo "[e2e] Validating callback state protection"
CALLBACK_RESPONSE="$(curl -sS "http://localhost:${PORT}/auth/github/callback?code=dummy&state=invalid")"
if [[ "$CALLBACK_RESPONSE" != *"invalid_oauth_state"* ]]; then
  echo "[e2e] Callback state protection check failed: $CALLBACK_RESPONSE"
  exit 1
fi

echo "[e2e] Creating signed session token"
SESSION_TOKEN="$(SESSION_SECRET="$SESSION_SECRET" node - <<'NODE'
import crypto from 'node:crypto';

const secret = process.env.SESSION_SECRET;
const payload = {
  github_login: 'e2e-user',
  github_user_id: 10101010,
  display_name: 'E2E User',
  email: 'e2e@example.com',
};

const body = {
  ...payload,
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
process.stdout.write(`${encoded}.${signature}`);
NODE
)"

echo "[e2e] Validating authenticated endpoints"
ME_RESPONSE="$(curl -sS -b "portal_session=${SESSION_TOKEN}" "http://localhost:${PORT}/api/me")"
if [[ "$ME_RESPONSE" != *"\"github_login\":\"e2e-user\""* ]]; then
  echo "[e2e] /api/me check failed: $ME_RESPONSE"
  exit 1
fi

OPTIONS_RESPONSE="$(curl -sS -b "portal_session=${SESSION_TOKEN}" "http://localhost:${PORT}/api/options")"
if [[ "$OPTIONS_RESPONSE" != *"job_types"* ]]; then
  echo "[e2e] /api/options check failed: $OPTIONS_RESPONSE"
  exit 1
fi

CSRF_TOKEN="$(curl -sS -b "portal_session=${SESSION_TOKEN}" "http://localhost:${PORT}/api/csrf-token" | jq -r '.csrf_token')"
if [[ -z "$CSRF_TOKEN" || "$CSRF_TOKEN" == "null" ]]; then
  echo "[e2e] Failed to get CSRF token"
  exit 1
fi

if [[ "${RUN_DISPATCH:-false}" == "true" ]]; then
  echo "[e2e] Triggering dispatch request"
  REQUEST_RESPONSE="$(curl -sS -X POST "http://localhost:${PORT}/api/requests" \
    -b "portal_session=${SESSION_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${CSRF_TOKEN}" \
    -d '{"job_type":"deploy-staging","parameters":{"service":"billing-api","version":"1.14.2","environment":"staging"}}')"
  if [[ "$REQUEST_RESPONSE" != *"\"status\":\"accepted\""* ]]; then
    echo "[e2e] Dispatch trigger failed: $REQUEST_RESPONSE"
    exit 1
  fi
  echo "[e2e] Dispatch response: $REQUEST_RESPONSE"
else
  echo "[e2e] RUN_DISPATCH=false, skipping /api/requests trigger"
fi

echo "[e2e] PASS"
