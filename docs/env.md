# Environment Variables Guide

이 문서는 `.env` 각 항목의 실제 목적, 코드에서의 동작 방식, 설정 방법을 정리합니다.

## 먼저 이해할 것

현재 서버는 두 종류의 설정을 사용합니다.

1. 서버 부팅용 설정
- 서버를 띄우는 데 필요한 최소값
- 일부는 기본값이 있어 `.env` 없이도 부팅 가능

2. 기능 실행용 설정
- OAuth 로그인, GitHub Actions 트리거/조회에 필요
- 값이 없으면 해당 endpoint에서 `503` 오류를 반환

즉, 서버는 켜질 수 있어도 기능별 설정이 없으면 해당 기능은 막히는 구조입니다.

## 설정 우선순위

1. `.env` 파일 값
2. 없으면 코드 기본값(일부 변수만)
3. 기본값도 없으면 endpoint 호출 시 `503` 또는 기능 실패

## 항목별 설명

### `PORT`
- 목적: 서버 리스닝 포트
- 기본값: `3000`
- 예시:

```env
PORT=3000
```

### `UI_REDIRECT_URL`
- 목적: OAuth 완료 후 브라우저를 돌려보낼 URL
- 사용 위치: `GET /auth/github/callback`
- 기본값: `http://localhost:3000/`
- 예시:

```env
UI_REDIRECT_URL=http://localhost:3000/
```

### `SESSION_SECRET`
- 목적: 세션/CSRF 서명(HMAC) 키
- 사용 위치: 세션 쿠키 발급/검증, CSRF 토큰 발급/검증
- 기본값: `dev-only-session-secret-change-me` (개발용)
- 운영 권장: 충분히 긴 랜덤 문자열 사용
- 운영 동작: `NODE_ENV=production` 에서 기본값이면 서버 시작 실패
- 예시:

```env
SESSION_SECRET=replace-with-a-long-random-secret
```

### `NODE_ENV`
- 목적: 실행 환경 구분
- 기본값: `development`
- 현재 영향:
	- `production` 이면 기본 `SESSION_SECRET` 사용 금지
	- 그 외에는 개발 편의를 위해 기본 시크릿 허용, 경고 로그 출력
- 예시:

```env
NODE_ENV=production
```

### `COOKIE_SECURE`
- 목적: 쿠키 `Secure` 플래그 제어
- 기본값: `false`
- 권장:
- 로컬 HTTP: `false`
- HTTPS 운영: `true`
- 예시:

```env
COOKIE_SECURE=false
```

### `SESSION_TTL_SECONDS`
- 목적: 세션/CSRF 토큰 유효시간(초)
- 기본값: `28800` (8시간)
- 예시:

```env
SESSION_TTL_SECONDS=28800
```

## OAuth 관련

### `GITHUB_OAUTH_CLIENT_ID`
### `GITHUB_OAUTH_CLIENT_SECRET`
### `GITHUB_OAUTH_CALLBACK_URL`

- 목적: GitHub OAuth 로그인 연동
- 사용 endpoint:
- `GET /auth/github/login`
- `GET /auth/github/callback`
- 기본값:
- `GITHUB_OAUTH_CLIENT_ID`: 없음
- `GITHUB_OAUTH_CLIENT_SECRET`: 없음
- `GITHUB_OAUTH_CALLBACK_URL`: `http://localhost:3000/auth/github/callback`
- 미설정 동작: 위 endpoint 호출 시 `503 oauth_not_configured`
- 예시:

```env
GITHUB_OAUTH_CLIENT_ID=your-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-client-secret
GITHUB_OAUTH_CALLBACK_URL=http://localhost:3000/auth/github/callback
```

### `REQUIRED_GITHUB_ORG`
- 목적: OAuth 로그인 사용자가 반드시 속해야 하는 GitHub organization
- 사용 위치: `GET /auth/github/callback`
- 동작: 설정되면 로그인 완료 전에 `/user/orgs` 기준 membership 검증
- 미충족 시: `403 not_allowed_by_org_membership`
- 예시:

```env
REQUIRED_GITHUB_ORG=your-org
```

### `REQUIRED_GITHUB_TEAM_SLUG`
- 목적: OAuth 로그인 사용자가 반드시 속해야 하는 team slug
- 전제: `REQUIRED_GITHUB_ORG` 도 함께 설정되어야 함
- 사용 위치: `GET /auth/github/callback`
- 동작: 설정되면 `/orgs/{org}/teams/{team_slug}/memberships/{username}` 기준 검증
- 미충족 시: `403 not_allowed_by_team_membership`
- 예시:

```env
REQUIRED_GITHUB_ORG=your-org
REQUIRED_GITHUB_TEAM_SLUG=platform-team
```

## GitHub Actions 트리거 인증

둘 중 하나를 선택합니다.

### 방식 A: PAT 사용

#### `GITHUB_TRIGGER_TOKEN`
- 목적: GitHub API 호출용 bearer token
- 장점: 설정이 쉬움
- 주의: 권한 최소화, 노출 방지 필요

```env
GITHUB_TRIGGER_TOKEN=ghp_xxx
```

### 방식 B: GitHub App 사용 (권장)

#### `GITHUB_APP_ID`
#### `GITHUB_APP_PRIVATE_KEY`
#### `GITHUB_APP_INSTALLATION_ID`

- 목적: 앱 JWT 생성 후 installation token 교환
- 장점: 권한/수명/운영 관리가 더 안전
- 주의: private key 문자열 형식 관리 필요

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_APP_INSTALLATION_ID=98765432
```

## GitHub 대상 저장소

### `GITHUB_REPOSITORY_OWNER`
### `GITHUB_REPOSITORY_NAME`

- 목적: dispatch/run 조회 대상 repo 지정
- 사용 endpoint:
- `POST /api/requests`
- `GET /api/runs`
- `GET /api/runs/:runId`
- 미설정 동작: 위 endpoint 호출 시 `503 github_repository_not_configured`
- 예시:

```env
GITHUB_REPOSITORY_OWNER=your-org
GITHUB_REPOSITORY_NAME=your-repo
```

### `GITHUB_EVENT_TYPE`
- 목적: repository_dispatch event_type
- 기본값: `manual-job-requested`
- 예시:

```env
GITHUB_EVENT_TYPE=manual-job-requested
```

### `GITHUB_API_BASE_URL`
- 목적: GitHub API base URL 변경용 (기본 github.com)
- 기본값: `https://api.github.com`
- GHES 사용 시 변경 가능

```env
GITHUB_API_BASE_URL=https://api.github.com
```

## 입력 정책(검증/권한)

### `ALLOWED_JOB_TYPES`
### `ALLOWED_SERVICES`
### `ALLOWED_ENVIRONMENTS`

- 목적: UI 옵션/요청 검증 allowlist
- 형식: comma-separated
- 예시:

```env
ALLOWED_JOB_TYPES=deploy-staging
ALLOWED_SERVICES=billing-api,auth-api,web-frontend
ALLOWED_ENVIRONMENTS=staging,prod
```

### `ALLOWED_GITHUB_LOGINS`
- 목적: 요청 허용 사용자 제한
- 형식: comma-separated
- 빈 값이면 제한 없음
- 예시:

```env
ALLOWED_GITHUB_LOGINS=alice,bob
```

## 추천 템플릿

### 로컬 개발용 (최소)

```env
PORT=3000
UI_REDIRECT_URL=http://localhost:3000/
SESSION_SECRET=local-dev-only-secret
COOKIE_SECURE=false
SESSION_TTL_SECONDS=28800

GITHUB_OAUTH_CLIENT_ID=your-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-client-secret
GITHUB_OAUTH_CALLBACK_URL=http://localhost:3000/auth/github/callback

GITHUB_TRIGGER_TOKEN=your-token

GITHUB_REPOSITORY_OWNER=your-org
GITHUB_REPOSITORY_NAME=your-repo
GITHUB_EVENT_TYPE=manual-job-requested

ALLOWED_JOB_TYPES=deploy-staging
ALLOWED_SERVICES=billing-api,auth-api,web-frontend
ALLOWED_ENVIRONMENTS=staging,prod
ALLOWED_GITHUB_LOGINS=
```

### 운영 권장

- `COOKIE_SECURE=true`
- 강한 `SESSION_SECRET`
- GitHub App 방식 사용
- `ALLOWED_GITHUB_LOGINS` 또는 조직/팀 기반 권한 통제 적용
- `REQUIRED_GITHUB_ORG` / `REQUIRED_GITHUB_TEAM_SLUG` 로 로그인 단계에서 선제 차단

## 빠른 점검 방법

1. 서버 부팅 확인

```bash
npm run start
```

2. 헬스체크

```bash
curl -s http://localhost:3000/health
```

3. OAuth 설정 누락 점검

```bash
curl -s http://localhost:3000/auth/github/login
```

- 정상 설정이면 GitHub authorize URL로 redirect
- 미설정이면 `oauth_not_configured`

4. 트리거 설정 누락 점검

- 로그인 후 `POST /api/requests` 호출 시
- 미설정이면 `github_repository_not_configured` 또는 `github_trigger_credentials_not_configured`

## 추가 운영 메모

- OAuth 로그인, OAuth callback, workflow trigger endpoint에는 간단한 in-memory rate limit이 적용됩니다.
- 단일 인스턴스 기준 보호이며, 다중 인스턴스 환경에서는 Redis 같은 외부 저장소 기반 제한이 더 적합합니다.
- 모든 요청에는 `X-Request-Id` 헤더가 부여되며, 서버 로그도 같은 correlation id로 기록됩니다.
