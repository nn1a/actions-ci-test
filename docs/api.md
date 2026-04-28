# API Contract

## Overview

This backend is a stateless API server for:

- GitHub OAuth sign-in
- Request validation and authorization
- GitHub Actions trigger and run lookup

The browser must never send requester identity directly. Identity is derived from the authenticated session.

Every response includes `X-Request-Id` for request correlation.

## Session and Security Model

- Session: signed HTTP-only cookie (`portal_session`)
- CSRF: signed token from `GET /api/csrf-token`, sent via `X-CSRF-Token`
- Request validation: allowlist + strict pattern checks

## Endpoints

### `GET /health`

Health check.

Response:

```json
{
  "ok": true
}
```

### `GET /auth/github/login`

Redirect to GitHub OAuth authorize page.

Possible errors:

- `503 oauth_not_configured`
- `429 rate_limit_exceeded`

### `GET /auth/github/callback`

OAuth callback endpoint.

Behavior:

- Verify OAuth state
- Exchange code for token
- Load GitHub user profile
- Issue session cookie
- Redirect to `UI_REDIRECT_URL`

Possible errors:

- `400 invalid_oauth_state`
- `400 expired_oauth_state`
- `403 not_allowed_by_org_membership`
- `403 not_allowed_by_team_membership`
- `503 oauth_not_configured`
- `429 rate_limit_exceeded`

### `POST /auth/logout`

Clear session cookie.

Response:

```json
{
  "ok": true
}
```

### `GET /api/me`

Return authenticated user session payload.

Auth required: yes

Response example:

```json
{
  "github_login": "github-user",
  "github_user_id": 12345678,
  "display_name": "GitHub User",
  "avatar_url": "https://avatars.githubusercontent.com/u/12345678",
  "email": "user@example.com",
  "exp": 1777417367
}
```

### `GET /api/options`

Return dynamic UI options from server allowlist config.

Auth required: yes

Response example:

```json
{
  "job_types": ["deploy-staging"],
  "services": ["billing-api", "auth-api", "web-frontend"],
  "environments": ["staging", "prod"]
}
```

### `GET /api/csrf-token`

Issue CSRF token for write endpoints.

Auth required: yes

Response:

```json
{
  "csrf_token": "<signed-token>"
}
```

### `POST /api/requests`

Trigger workflow through GitHub `repository_dispatch`.

Auth required: yes

Headers:

- `X-CSRF-Token: <token>`

Body:

```json
{
  "job_type": "deploy-staging",
  "parameters": {
    "service": "billing-api",
    "version": "1.14.2",
    "environment": "staging"
  }
}
```

Response:

```json
{
  "request_id": "req_20260429T101203Z_github-user_a1b2c3",
  "status": "accepted",
  "repository": "org/repo",
  "event_type": "manual-job-requested"
}
```

Possible errors:

- `401 unauthenticated`
- `403 missing_csrf_token`
- `403 invalid_csrf_token`
- `403 not_allowed_for_job_type`
- `400 invalid_request_body`
- `400 invalid_parameter`
- `429 rate_limit_exceeded`
- `503 github_repository_not_configured`
- `503 github_trigger_credentials_not_configured`

### `GET /api/runs`

List workflow runs.

Auth required: yes

Query params:

- `per_page` (optional, default `20`, max `100`)
- `page` (optional, default `1`)
- `requester` (optional, exact requester match using run-name convention)
- `request_id` (optional, substring match in run-name)

Response example:

```json
{
  "runs": [
    {
      "run_id": 987654321,
      "status": "completed",
      "conclusion": "success",
      "run_name": "deploy-staging by github-user (req_20260429T101203Z_github-user_a1b2c3)",
      "created_at": "2026-04-29T10:12:10Z",
      "html_url": "https://github.com/org/repo/actions/runs/987654321"
    }
  ]
}
```

Possible errors:

- `401 unauthenticated`
- `503 github_repository_not_configured`
- `503 github_trigger_credentials_not_configured`

### `GET /api/runs/:runId`

Get one workflow run by run id.

Auth required: yes

Possible errors:

- `400 invalid_run_id`
- `401 unauthenticated`
- `503 github_repository_not_configured`
- `503 github_trigger_credentials_not_configured`

## Dispatch Mapping

`POST /api/requests` maps request + session identity to this payload:

```json
{
  "event_type": "manual-job-requested",
  "client_payload": {
    "request_id": "req_20260429T101203Z_github-user_a1b2c3",
    "requested_by": {
      "github_login": "github-user",
      "github_user_id": 12345678,
      "display_name": "GitHub User",
      "email": "user@example.com"
    },
    "requested_at": "2026-04-29T10:12:03Z",
    "job_type": "deploy-staging",
    "parameters": {
      "service": "billing-api",
      "version": "1.14.2",
      "environment": "staging"
    }
  }
}
```

## Notes

- Server startup does not require all runtime integrations to be configured.
- Missing OAuth or GitHub trigger/repository config is reported as `503` on relevant endpoints.
- Development mode can start with a default session secret, but production mode requires an explicit `SESSION_SECRET`.
- Simple in-memory rate limiting is applied to OAuth login, OAuth callback, and workflow trigger endpoints.
- OAuth login can be restricted by organization/team membership using `REQUIRED_GITHUB_ORG` and `REQUIRED_GITHUB_TEAM_SLUG`.
- Structured JSON logs are emitted with a per-request correlation id, also returned as `X-Request-Id`.
- `request_id` is returned immediately after GitHub accepts dispatch; run id is resolved separately via run APIs.