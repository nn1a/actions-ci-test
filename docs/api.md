# API Contract

## Overview

This API assumes:

- End users authenticate with GitHub OAuth.
- The backend is stateless.
- The backend triggers GitHub Actions with a service identity.
- The backend does not persist request history in a database.

## Authentication

Use one of the following session models:

1. Signed HTTP-only cookie
2. JWT stored in an HTTP-only cookie

The client must never send `requested_by` directly. The backend derives requester identity from the authenticated session.

## Endpoints

### `GET /auth/github/login`

Redirect the browser to GitHub OAuth.

### `GET /auth/github/callback`

Handle the OAuth callback.

Responsibilities:

- Verify OAuth state
- Exchange code for token
- Fetch current GitHub user profile
- Issue signed session
- Redirect to UI

### `POST /auth/logout`

Clear the current session.

Response:

```json
{
  "ok": true
}
```

### `GET /api/me`

Return the current authenticated user.

Response:

```json
{
  "github_login": "alice",
  "github_user_id": 12345678,
  "display_name": "Alice Kim",
  "avatar_url": "https://avatars.githubusercontent.com/u/12345678"
}
```

### `GET /api/csrf-token`

Return a CSRF token for use in POST requests.

This endpoint is authenticated and requires a valid session. The token should be sent in the `X-CSRF-Token` header for POST requests.

Response:

```json
{
  "csrf_token": "eyJub25jZSI6IjM2NTcyZGY2MjZlNjYzYzgyZTgyYWI2ZjM0Y2Y1YzAwIiwiZXhwIjoxNjEyMzQ1NjAwfQ.signature"
}
```

### `POST /api/requests`

Trigger a GitHub Actions workflow through `repository_dispatch`.

Required headers:

- `X-CSRF-Token`: CSRF token obtained from `GET /api/csrf-token`

Request body:

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

Validation rules:

- `job_type` must be one of the allowed job identifiers.
- `parameters.service` must be from a controlled allowlist.
- `parameters.environment` must be from a controlled allowlist.
- `parameters.version` must match a safe version pattern such as `^[A-Za-z0-9._-]+$`.

Response:

```json
{
  "request_id": "req_20260428T101203Z_alice_a1b2c3",
  "status": "accepted",
  "repository": "org/repo",
  "event_type": "manual-job-requested"
}
```

Failure examples:

`401 Unauthorized`

```json
{
  "error": "unauthenticated"
}
```

`403 Forbidden`

```json
{
  "error": "not_allowed_for_job_type"
}
```

`400 Bad Request`

```json
{
  "error": "invalid_parameter",
  "field": "parameters.version"
}
```

### `GET /api/runs`

Return recent workflow runs from GitHub Actions.

Query params:

- `per_page`: optional, default `20`
- `page`: optional, default `1`

Response:

```json
{
  "runs": [
    {
      "run_id": 987654321,
      "status": "completed",
      "conclusion": "success",
      "run_name": "deploy-staging by alice (req_20260428T101203Z_alice_a1b2c3)",
      "created_at": "2026-04-28T10:12:10Z",
      "html_url": "https://github.com/org/repo/actions/runs/987654321"
    }
  ]
}
```

### `GET /api/runs/:runId`

Return details for a specific GitHub Actions run.

Response:

```json
{
  "run_id": 987654321,
  "status": "in_progress",
  "conclusion": null,
  "run_name": "deploy-staging by alice (req_20260428T101203Z_alice_a1b2c3)",
  "html_url": "https://github.com/org/repo/actions/runs/987654321"
}
```

## Dispatch Mapping

`POST /api/requests` should translate the client request into the following GitHub dispatch body:

```json
{
  "event_type": "manual-job-requested",
  "client_payload": {
    "request_id": "req_20260428T101203Z_alice_a1b2c3",
    "requested_by": {
      "github_login": "alice",
      "github_user_id": 12345678,
      "display_name": "Alice Kim"
    },
    "requested_at": "2026-04-28T10:12:03Z",
    "job_type": "deploy-staging",
    "parameters": {
      "service": "billing-api",
      "version": "1.14.2",
      "environment": "staging"
    }
  }
}
```

## Implementation Notes

- Keep the GitHub trigger credential only on the backend.
- Use the session identity as the source of truth for requester metadata.
- Return `request_id` immediately after GitHub accepts the dispatch.
- Do not claim a concrete run ID at trigger time unless a later lookup step is added.