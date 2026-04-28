# Actions CI Portal

GitHub OAuth 로그인 사용자가 Web UI에서 요청을 보내고, 백엔드 서비스 계정으로 GitHub Actions를 트리거하는 경량 포털입니다.

핵심 원칙:

- DB 없이 동작
- 실행 주체(backend identity)와 실제 요청자(requested_by) 분리
- 요청자 정보는 dispatch payload, run-name, summary에 기록

## 주요 기능

- GitHub OAuth 로그인
- Stateless 세션 쿠키
- CSRF 보호
- `repository_dispatch` 기반 Actions 트리거
- 최근 실행 목록 조회
- requester/request_id 필터
- UI 폼 옵션 동적 로딩 (`/api/options`)

## 빠른 시작

1. 의존성 설치

```bash
npm install
```

2. 환경변수 설정

```bash
cp .env.example .env
```

세부 설정은 [docs/env.md](docs/env.md) 참조.

3. 서버 실행

```bash
npm run start
```

4. 브라우저 접속

- `http://localhost:3000`

## API 요약

- `GET /health`
- `GET /auth/github/login`
- `GET /auth/github/callback`
- `POST /auth/logout`
- `GET /api/me`
- `GET /api/options`
- `GET /api/csrf-token`
- `POST /api/requests`
- `GET /api/runs`
- `GET /api/runs/:runId`

상세 계약은 [docs/api.md](docs/api.md) 참조.

## 동작 모델

1. 사용자가 GitHub OAuth로 로그인
2. 백엔드가 세션 쿠키 발급
3. 사용자가 요청 파라미터 제출
4. 백엔드가 검증 후 `repository_dispatch` 호출
5. 워크플로우가 요청자 메타데이터를 포함해 실행

실행 actor는 백엔드 계정이고, 실제 요청자는 payload의 `requested_by`로 추적합니다.

## 테스트

- 구문 체크

```bash
npm run check
```

- OAuth 스모크 테스트

```bash
npm run e2e:oauth
```

- dispatch 포함 테스트

```bash
RUN_DISPATCH=true npm run e2e:oauth
```

## 참고 문서

- [docs/env.md](docs/env.md): `.env` 항목별 목적/동작/설정 방법
- [docs/api.md](docs/api.md): API 계약
- [docs/backend-notes.md](docs/backend-notes.md): 구현/운영 메모
- [examples/repository-dispatch.yml](examples/repository-dispatch.yml): 워크플로우 예시