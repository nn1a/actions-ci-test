# Backend Implementation Notes

## Preferred Stack Shape

Any backend stack is acceptable if it supports:

- GitHub OAuth login
- Signed stateless sessions
- Outbound GitHub API calls
- Strict request validation

Typical options:

- Node.js with Express, Fastify, or NestJS
- Java with Spring Boot
- Go with chi or Gin

## Required Secrets

### For GitHub OAuth

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_CALLBACK_URL`

### For backend-trigger identity

Preferred GitHub App:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID`

MVP fallback with service PAT:

- `GITHUB_TRIGGER_TOKEN`

### For session integrity

- `SESSION_SECRET`

## Minimal Request Handling Flow

### 1. Authenticate

- Redirect to GitHub OAuth
- Verify callback state
- Fetch GitHub user profile
- Issue signed session cookie

### 2. Authorize

- Check organization or team membership if needed
- Check whether the user can submit the requested `job_type`

### 3. Validate

- Only accept known job types
- Only accept known parameter keys
- Reject shell-sensitive or unexpected values

### 4. Trigger

- Generate `request_id`
- Build the dispatch payload from the server-side session identity
- Call GitHub `repository_dispatch`

### 5. Observe

- Return `request_id` to the UI
- Let the UI poll recent runs via backend or GitHub API proxy

## Safe Validation Pattern

The backend should avoid passing free-form command fragments. Inputs should map to known backend-defined options.

Good:

- `environment = staging | prod`
- `service = billing-api | auth-api | web-frontend`

Bad:

- `command = ./deploy.sh whatever-user-entered`
- `branch = arbitrary shell expression`

## Session Strategy

Preferred:

- HTTP-only cookie
- `Secure` enabled
- `SameSite=Lax` or stricter
- Short lifetime with re-login when needed

This keeps the backend stateless while avoiding local-storage token handling in the browser.

## How To Show Real Requester In Actions

The workflow actor will usually be the backend identity. To show the real requester:

1. Put requester metadata into `client_payload`
2. Include the requester login in `run-name`
3. Write requester info into `GITHUB_STEP_SUMMARY`
4. Print the `request_id` in logs

That is the practical replacement for Jenkins-style manual trigger metadata.

## Gaps In A No-DB Model

You should expect these gaps from day one:

- No durable audit ledger outside GitHub
- No pending approvals queue
- No strong idempotency guarantee
- No efficient historical search by requester

If one of these becomes necessary, add a small durable store rather than forcing more logic into GitHub Actions.