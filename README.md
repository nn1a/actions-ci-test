# GitHub Actions Trigger Portal Design

## Goal

Provide a Web UI where users sign in with GitHub OAuth, submit job parameters, and trigger GitHub Actions through a backend-managed identity.

Constraints:

- The backend should not require a database.
- The actor that triggers GitHub Actions is the backend service identity, not the logged-in end user.
- The workflow should still know who the real requester is.

## Recommended Architecture

### Components

1. Web UI
   - GitHub OAuth sign-in
   - Input form for job parameters
   - Recent run status view from GitHub API

2. Backend API
   - OAuth callback handling
   - Stateless session verification with signed cookie or JWT
   - Request validation and authorization
   - GitHub Actions trigger with a service identity
   - Optional run status proxy from GitHub API

3. GitHub
   - GitHub OAuth app for end-user authentication
   - GitHub App or service PAT for workflow triggering
   - GitHub Actions workflows that accept external dispatch payloads

### High-Level Flow

1. User signs in through GitHub OAuth.
2. Backend receives the OAuth callback and issues a signed session cookie or JWT.
3. User submits a job request in the Web UI.
4. Backend validates the session, checks authorization, and generates a `request_id`.
5. Backend triggers GitHub Actions using a backend-managed identity.
6. Backend passes `request_id` and requester metadata in the dispatch payload.
7. Workflow records the requester metadata in `run-name`, logs, and step summary.
8. Web UI reads run status from GitHub API.

## Identity Model

Two identities must be kept separate.

### 1. Execution Identity

This is the GitHub identity used by the backend to call the GitHub API.

- Recommended: GitHub App
- Acceptable for MVP: fine-grained PAT from a service account
- Visible as the GitHub Actions trigger actor

### 2. Requester Identity

This is the real user who logged in to the Web UI with GitHub OAuth.

- Captured from the OAuth profile
- Included in the dispatch payload
- Shown inside the workflow summary and logs

This separation is the core design rule. The GitHub UI actor will normally be the backend identity. The real requester must be carried as explicit metadata.

## Why `repository_dispatch`

Use `repository_dispatch` instead of `workflow_dispatch` for this design.

Reasons:

- The backend is already the control plane, so the built-in workflow form is not needed.
- `client_payload` is flexible and fits richer metadata.
- The workflow can receive both operational parameters and requester context in one event.

## Stateless Backend Design

The backend can remain stateless if it avoids persistent request storage.

### What the backend keeps

- Signed session cookie or JWT
- In-memory config and secrets
- No persistent request table

### What the backend does not keep

- No database for request history
- No workflow-to-request mapping table
- No approval queue state

### Consequences

Benefits:

- Simpler operations
- No DB provisioning or migrations
- Easier initial rollout

Tradeoffs:

- Limited audit history outside GitHub
- Harder per-user search at scale
- No durable approval workflow
- Weaker duplicate request protection

This is acceptable for a lightweight internal portal, but not ideal for strict audit or approval requirements.

## Request Payload Contract

The backend should generate a compact payload and avoid passing secrets directly.

Example payload:

```json
{
  "event_type": "manual-job-requested",
  "client_payload": {
    "request_id": "req_20260428_101203_alice_a1b2c3",
    "requested_by": {
      "github_login": "alice",
      "github_user_id": 12345678,
      "display_name": "Alice Kim",
      "email": "alice@example.com"
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

Rules:

- `request_id` must be unique enough for logs and support investigation.
- `requested_by.github_login` is the minimum required requester field.
- Avoid secret values in `client_payload`.
- If values are large or sensitive, pass only a reference token and let the workflow fetch details from a secure system.

## Request ID Strategy Without a DB

Because there is no database, the backend should generate deterministic-enough IDs that are searchable.

Recommended format:

```text
req_<utc timestamp>_<github login>_<short random suffix>
```

Example:

```text
req_20260428T101203Z_alice_a1b2c3
```

This gives:

- Human-readable investigation data
- A stable string to search in GitHub logs
- A low-friction correlation key for the UI

## API Contract

### 1. Start OAuth login

`GET /auth/github/login`

Behavior:

- Redirects the user to GitHub OAuth

### 2. OAuth callback

`GET /auth/github/callback`

Behavior:

- Exchanges the OAuth code for user identity
- Issues a signed session cookie or JWT
- Redirects back to the UI

### 3. Current user

`GET /api/me`

Response example:

```json
{
  "github_login": "alice",
  "github_user_id": 12345678,
  "display_name": "Alice Kim"
}
```

### 4. Trigger workflow

`POST /api/requests`

Request example:

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

Response example:

```json
{
  "request_id": "req_20260428T101203Z_alice_a1b2c3",
  "triggered_repository": "org/repo",
  "event_type": "manual-job-requested",
  "requested_by": "alice",
  "status": "accepted"
}
```

Behavior:

- Read user identity from the signed session
- Validate inputs against a whitelist
- Generate `request_id`
- Call GitHub `repository_dispatch`
- Return the generated `request_id`

### 5. List recent runs

`GET /api/runs?per_page=20`

Behavior:

- Proxy GitHub Actions run list for a target repository or workflow
- Optionally filter on the UI side by `request_id` or requester name shown in `run-name`

Response example:

```json
{
  "runs": [
    {
      "run_id": 987654321,
      "status": "in_progress",
      "conclusion": null,
      "run_name": "deploy-staging by alice (req_20260428T101203Z_alice_a1b2c3)",
      "html_url": "https://github.com/org/repo/actions/runs/987654321"
    }
  ]
}
```

## Authorization Model

Authentication and authorization should remain in the backend.

Examples:

- Only allow users in a specific GitHub org or team
- Restrict production jobs to a smaller allowlist
- Restrict job types by role or GitHub team membership

This is important because the backend identity has the actual trigger authority.

## GitHub Actions Workflow Example

```yaml
name: External Request

on:
  repository_dispatch:
    types: [manual-job-requested]

run-name: >
  ${{ github.event.client_payload.job_type }}
  by ${{ github.event.client_payload.requested_by.github_login }}
  (${{ github.event.client_payload.request_id }})

jobs:
  run:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - name: Print request metadata
        run: |
          echo "Request ID: ${{ github.event.client_payload.request_id }}"
          echo "Requested by: ${{ github.event.client_payload.requested_by.github_login }}"
          echo "Requested at: ${{ github.event.client_payload.requested_at }}"
          echo "Job type: ${{ github.event.client_payload.job_type }}"

      - name: Write workflow summary
        run: |
          {
            echo "## External Request"
            echo ""
            echo "- Request ID: ${{ github.event.client_payload.request_id }}"
            echo "- Requested by: ${{ github.event.client_payload.requested_by.github_login }}"
            echo "- Job type: ${{ github.event.client_payload.job_type }}"
            echo "- Service: ${{ github.event.client_payload.parameters.service }}"
            echo "- Version: ${{ github.event.client_payload.parameters.version }}"
            echo "- Environment: ${{ github.event.client_payload.parameters.environment }}"
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Execute job
        env:
          SERVICE: ${{ github.event.client_payload.parameters.service }}
          VERSION: ${{ github.event.client_payload.parameters.version }}
          ENVIRONMENT: ${{ github.event.client_payload.parameters.environment }}
        run: |
          echo "Run deployment logic here"
          echo "service=$SERVICE version=$VERSION environment=$ENVIRONMENT"
```

## Backend Trigger Example

Example GitHub API call:

```http
POST /repos/{owner}/{repo}/dispatches
Accept: application/vnd.github+json
Authorization: Bearer <backend-service-token>
X-GitHub-Api-Version: 2022-11-28
```

Body:

```json
{
  "event_type": "manual-job-requested",
  "client_payload": {
    "request_id": "req_20260428T101203Z_alice_a1b2c3",
    "requested_by": {
      "github_login": "alice",
      "github_user_id": 12345678
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

## Security Boundaries

### Browser

- Never call GitHub Actions trigger APIs directly from the browser
- Never expose the backend service token to the client

### Backend

- Store GitHub trigger credentials only on the server
- Validate every request parameter against allowed values
- Bind the requester identity from the session, not from client-supplied fields
- Use CSRF protection if cookie-based sessions are used

### Workflow

- Treat dispatch payload as untrusted input
- Do not interpolate raw user values directly into shell commands
- Prefer environment variables and explicit validation before execution

## Operational Limits of No-DB Design

This design is intentionally lightweight, but it has clear limits.

Not ideal for:

- Multi-step approvals
- Durable audit requirements
- Strong duplicate prevention
- Complex search across historical requests
- Large file uploads or long structured input

If one of those becomes important, the next step is not necessarily a relational DB. A small durable store such as Redis, S3-compatible object storage, or GitHub Issues can cover some cases first.

## MVP Recommendation

For an initial implementation:

1. Use GitHub OAuth for login.
2. Use signed cookie or JWT for a stateless backend session.
3. Use a GitHub App as the backend trigger identity.
4. Use `repository_dispatch` with `request_id` and `requested_by` metadata.
5. Display recent runs directly from GitHub Actions API.
6. Put requester information into `run-name` and `GITHUB_STEP_SUMMARY`.

## Current Implementation

The workspace now includes a minimal Node.js backend skeleton in `src/server.js` with these endpoints:

- `GET /health`
- `GET /auth/github/login`
- `GET /auth/github/callback`
- `POST /auth/logout`
- `GET /api/me`
- `POST /api/requests`
- `GET /api/runs`
- `GET /api/runs/:runId`

Supporting files:

- `package.json`
- `.env.example`
- `examples/repository-dispatch.yml`
- `docs/api.md`
- `docs/backend-notes.md`

Current limitation:

- The code uses `GITHUB_TRIGGER_TOKEN` for the backend trigger identity. A GitHub App based trigger flow can be added later if needed.

## Local Run

1. Copy `.env.example` to `.env` and fill in the real values.
2. Run `npm install`.
3. Run `npm start`.
4. Open `GET /auth/github/login` from the browser.

## Next Build Steps

1. Add CSRF protection for cookie-authenticated write endpoints.
2. Replace `GITHUB_TRIGGER_TOKEN` with a GitHub App installation token flow if stricter credential management is needed.
3. Build a minimal form that submits `job_type` and `parameters`.
4. Add a recent runs page that links to GitHub Actions run URLs.
5. Reassess whether a durable store is needed after initial internal usage.