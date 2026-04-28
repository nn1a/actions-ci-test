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

TEST_PORT="${E2E_PORT:-3900}"

echo "[e2e] Starting backend server"
PORT="$TEST_PORT" node src/server.js >/tmp/actions-ci-e2e.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..30}; do
  if curl -fsS "http://localhost:${TEST_PORT}/health" >/dev/null 2>/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "[e2e] Backend process exited early"
    cat /tmp/actions-ci-e2e.log || true
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "http://localhost:${TEST_PORT}/health" >/dev/null 2>/dev/null; then
  echo "[e2e] Backend did not become healthy"
  cat /tmp/actions-ci-e2e.log || true
  exit 1
fi

echo "[e2e] Validating OAuth login redirect"
HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
curl -sS -D "$HEADERS_FILE" -o "$BODY_FILE" "http://localhost:${TEST_PORT}/auth/github/login"
LOCATION="$(grep -i '^location:' "$HEADERS_FILE" | sed 's/\r$//' | awk '{print $2}')"
REQUEST_ID_HEADER_VALUE="$(grep -i '^x-request-id:' "$HEADERS_FILE" | sed 's/\r$//' | awk '{print $2}')"

if [[ -z "$LOCATION" ]]; then
  echo "[e2e] Missing OAuth redirect location"
  echo "[e2e] Response headers:"
  cat "$HEADERS_FILE" || true
  echo "[e2e] Response body:"
  cat "$BODY_FILE" || true
  exit 1
fi

if [[ -z "$REQUEST_ID_HEADER_VALUE" ]]; then
  echo "[e2e] Missing X-Request-Id header on OAuth redirect"
  cat "$HEADERS_FILE" || true
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

if [[ "$LOCATION" != *"scope=read%3Auser+user%3Aemail+read%3Aorg"* ]]; then
  echo "[e2e] OAuth location missing expected read:org scope"
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
CALLBACK_RESPONSE="$(curl -sS "http://localhost:${TEST_PORT}/auth/github/callback?code=dummy&state=invalid")"
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
ME_HEADERS_FILE="$(mktemp)"
ME_BODY_FILE="$(mktemp)"
curl -sS -D "$ME_HEADERS_FILE" -o "$ME_BODY_FILE" -b "portal_session=${SESSION_TOKEN}" "http://localhost:${TEST_PORT}/api/me"
ME_RESPONSE="$(cat "$ME_BODY_FILE")"
if [[ "$ME_RESPONSE" != *"\"github_login\":\"e2e-user\""* ]]; then
  echo "[e2e] /api/me check failed: $ME_RESPONSE"
  exit 1
fi

ME_REQUEST_ID_HEADER_VALUE="$(grep -i '^x-request-id:' "$ME_HEADERS_FILE" | sed 's/\r$//' | awk '{print $2}')"
if [[ -z "$ME_REQUEST_ID_HEADER_VALUE" ]]; then
  echo "[e2e] Missing X-Request-Id header on /api/me"
  cat "$ME_HEADERS_FILE" || true
  exit 1
fi

OPTIONS_RESPONSE="$(curl -sS -b "portal_session=${SESSION_TOKEN}" "http://localhost:${TEST_PORT}/api/options")"
if [[ "$OPTIONS_RESPONSE" != *"job_types"* ]]; then
  echo "[e2e] /api/options check failed: $OPTIONS_RESPONSE"
  exit 1
fi

CSRF_TOKEN="$(curl -sS -b "portal_session=${SESSION_TOKEN}" "http://localhost:${TEST_PORT}/api/csrf-token" | jq -r '.csrf_token')"
if [[ -z "$CSRF_TOKEN" || "$CSRF_TOKEN" == "null" ]]; then
  echo "[e2e] Failed to get CSRF token"
  exit 1
fi

if [[ "${RUN_DISPATCH:-false}" == "true" ]]; then
  echo "[e2e] Triggering dispatch request"
  REQUEST_RESPONSE="$(curl -sS -X POST "http://localhost:${TEST_PORT}/api/requests" \
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
