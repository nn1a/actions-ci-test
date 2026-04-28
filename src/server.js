import crypto from 'node:crypto';

import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const config = loadConfig();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());
app.use(express.static('public'));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/auth/github/login', (_req, res) => {
  const state = issueSignedToken(
    { nonce: crypto.randomBytes(16).toString('hex') },
    config.sessionSecret,
    10 * 60,
  );

  res.cookie(config.oauthStateCookieName, state, buildCookieOptions(config, 10 * 60 * 1000));

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', config.githubOauthClientId);
  authorizeUrl.searchParams.set('redirect_uri', config.githubOauthCallbackUrl);
  authorizeUrl.searchParams.set('scope', 'read:user user:email');
  authorizeUrl.searchParams.set('state', state);

  res.redirect(authorizeUrl.toString());
});

app.get('/auth/github/callback', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const storedState = req.cookies[config.oauthStateCookieName];

    if (!code || !state || !storedState || state !== storedState) {
      return res.status(400).json({ error: 'invalid_oauth_state' });
    }

    const statePayload = verifySignedToken(state, config.sessionSecret);
    if (!statePayload) {
      return res.status(400).json({ error: 'expired_oauth_state' });
    }

    const accessToken = await exchangeCodeForAccessToken(code, config);
    const { user, email } = await fetchGithubUser(accessToken, config);

    enforceAllowedGithubLogin(user.login, config);

    const sessionToken = issueSignedToken(
      {
        github_login: user.login,
        github_user_id: user.id,
        display_name: user.name || user.login,
        avatar_url: user.avatar_url,
        email,
      },
      config.sessionSecret,
      config.sessionTtlSeconds,
    );

    res.clearCookie(config.oauthStateCookieName, buildCookieOptions(config, 0));
    res.cookie(
      config.sessionCookieName,
      sessionToken,
      buildCookieOptions(config, config.sessionTtlSeconds * 1000),
    );

    return res.redirect(config.uiRedirectUrl);
  } catch (error) {
    return next(error);
  }
});

app.post('/auth/logout', (_req, res) => {
  res.clearCookie(config.sessionCookieName, buildCookieOptions(config, 0));
  res.json({ ok: true });
});

app.get('/api/me', requireSession(config), (req, res) => {
  res.json(req.session);
});

app.get('/api/csrf-token', requireSession(config), (req, res) => {
  const csrfToken = issueSignedToken(
    { nonce: crypto.randomBytes(16).toString('hex') },
    config.sessionSecret,
    config.sessionTtlSeconds,
  );
  res.json({ csrf_token: csrfToken });
});

app.post('/api/requests', requireSession(config), requireCsrfToken(config), async (req, res, next) => {
  try {
    const requestBody = validateRequestBody(req.body, config);
    enforceAllowedGithubLogin(req.session.github_login, config);

    const requestId = buildRequestId(req.session.github_login);
    const payload = {
      event_type: config.githubEventType,
      client_payload: {
        request_id: requestId,
        requested_by: {
          github_login: req.session.github_login,
          github_user_id: req.session.github_user_id,
          display_name: req.session.display_name,
          email: req.session.email || null,
        },
        requested_at: new Date().toISOString(),
        job_type: requestBody.job_type,
        parameters: requestBody.parameters,
      },
    };

    await githubRequest(config, `/repos/${config.githubRepositoryOwner}/${config.githubRepositoryName}/dispatches`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    res.status(202).json({
      request_id: requestId,
      status: 'accepted',
      repository: `${config.githubRepositoryOwner}/${config.githubRepositoryName}`,
      event_type: config.githubEventType,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/runs', requireSession(config), async (req, res, next) => {
  try {
    const perPage = parsePositiveInteger(req.query.per_page, 20, 100);
    const page = parsePositiveInteger(req.query.page, 1, 1000);
    const response = await githubRequest(
      config,
      `/repos/${config.githubRepositoryOwner}/${config.githubRepositoryName}/actions/runs?per_page=${perPage}&page=${page}`,
    );

    res.json({
      runs: (response.workflow_runs || []).map((run) => ({
        run_id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        run_name: run.display_title || run.name,
        created_at: run.created_at,
        html_url: run.html_url,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/runs/:runId', requireSession(config), async (req, res, next) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!/^\d+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid_run_id' });
    }

    const run = await githubRequest(
      config,
      `/repos/${config.githubRepositoryOwner}/${config.githubRepositoryName}/actions/runs/${runId}`,
    );

    return res.json({
      run_id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      run_name: run.display_title || run.name,
      created_at: run.created_at,
      html_url: run.html_url,
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json(error.body);
  }

  console.error(error);
  return res.status(500).json({ error: 'internal_server_error' });
});

app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});

function loadConfig() {
  const githubTriggerToken = process.env.GITHUB_TRIGGER_TOKEN;
  const githubAppId = process.env.GITHUB_APP_ID;
  const githubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const githubAppInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (!githubTriggerToken && !(githubAppId && githubAppPrivateKey && githubAppInstallationId)) {
    throw new Error(
      'Either GITHUB_TRIGGER_TOKEN or (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID) must be set',
    );
  }

  return {
    port: Number(process.env.PORT || 3000),
    uiRedirectUrl: getRequiredEnv('UI_REDIRECT_URL'),
    sessionSecret: getRequiredEnv('SESSION_SECRET'),
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 28800),
    githubOauthClientId: getRequiredEnv('GITHUB_OAUTH_CLIENT_ID'),
    githubOauthClientSecret: getRequiredEnv('GITHUB_OAUTH_CLIENT_SECRET'),
    githubOauthCallbackUrl: getRequiredEnv('GITHUB_OAUTH_CALLBACK_URL'),
    githubTriggerToken,
    githubAppId,
    githubAppPrivateKey,
    githubAppInstallationId,
    githubRepositoryOwner: getRequiredEnv('GITHUB_REPOSITORY_OWNER'),
    githubRepositoryName: getRequiredEnv('GITHUB_REPOSITORY_NAME'),
    githubEventType: process.env.GITHUB_EVENT_TYPE || 'manual-job-requested',
    githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || 'https://api.github.com',
    allowedJobTypes: parseCsv(process.env.ALLOWED_JOB_TYPES || 'deploy-staging'),
    allowedServices: parseCsv(process.env.ALLOWED_SERVICES || 'billing-api,auth-api,web-frontend'),
    allowedEnvironments: parseCsv(process.env.ALLOWED_ENVIRONMENTS || 'staging,prod'),
    allowedGithubLogins: parseCsv(process.env.ALLOWED_GITHUB_LOGINS || ''),
    sessionCookieName: 'portal_session',
    oauthStateCookieName: 'portal_oauth_state',
  };
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseCsv(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildCookieOptions(config, maxAge) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function issueSignedToken(payload, secret, ttlSeconds) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signature = signValue(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token, secret) {
  const [encodedPayload, signature] = String(token || '').split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signValue(encodedPayload, secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function requireSession(config) {
  return (req, _res, next) => {
    const token = req.cookies[config.sessionCookieName];
    const session = verifySignedToken(token, config.sessionSecret);

    if (!session) {
      return next(new HttpError(401, { error: 'unauthenticated' }));
    }

    req.session = session;
    return next();
  };
}

function requireCsrfToken(config) {
  return (req, _res, next) => {
    const csrfToken = req.headers['x-csrf-token'] || req.body?.csrf_token;
    
    if (!csrfToken) {
      return next(new HttpError(403, { error: 'missing_csrf_token' }));
    }

    const payload = verifySignedToken(csrfToken, config.sessionSecret);
    if (!payload) {
      return next(new HttpError(403, { error: 'invalid_csrf_token' }));
    }

    return next();
  };
}

function validateRequestBody(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, { error: 'invalid_request_body' });
  }

  const jobType = String(body.job_type || '').trim();
  if (!config.allowedJobTypes.includes(jobType)) {
    throw new HttpError(400, { error: 'invalid_parameter', field: 'job_type' });
  }

  const parameters = body.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new HttpError(400, { error: 'invalid_parameter', field: 'parameters' });
  }

  const service = String(parameters.service || '').trim();
  if (!config.allowedServices.includes(service)) {
    throw new HttpError(400, { error: 'invalid_parameter', field: 'parameters.service' });
  }

  const environment = String(parameters.environment || '').trim();
  if (!config.allowedEnvironments.includes(environment)) {
    throw new HttpError(400, { error: 'invalid_parameter', field: 'parameters.environment' });
  }

  const version = String(parameters.version || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new HttpError(400, { error: 'invalid_parameter', field: 'parameters.version' });
  }

  return {
    job_type: jobType,
    parameters: {
      service,
      environment,
      version,
    },
  };
}

function enforceAllowedGithubLogin(githubLogin, config) {
  if (config.allowedGithubLogins.length === 0) {
    return;
  }

  if (!config.allowedGithubLogins.includes(githubLogin)) {
    throw new HttpError(403, { error: 'not_allowed_for_job_type' });
  }
}

function buildRequestId(githubLogin) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `req_${timestamp}_${githubLogin}_${suffix}`;
}

async function exchangeCodeForAccessToken(code, config) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.githubOauthClientId,
      client_secret: config.githubOauthClientSecret,
      code,
      redirect_uri: config.githubOauthCallbackUrl,
    }),
  });

  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new HttpError(502, { error: 'oauth_token_exchange_failed' });
  }

  return body.access_token;
}

async function fetchGithubUser(accessToken, config) {
  const user = await githubRequest(config, '/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  let email = user.email || null;
  if (!email) {
    const emails = await githubRequest(config, '/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const primaryEmail = emails.find((entry) => entry.primary) || emails.find((entry) => entry.verified);
    email = primaryEmail?.email || null;
  }

  return { user, email };
}

let cachedInstallationToken = null;
let cachedTokenExpiration = 0;

function issueGithubAppJwt(config) {
  if (!config.githubAppId || !config.githubAppPrivateKey) {
    throw new Error('GitHub App credentials not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: Number(config.githubAppId),
    iat: now,
    exp: now + 300,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${header}.${body}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  const signature = sign.sign(
    {
      key: config.githubAppPrivateKey,
      format: 'pem',
      type: 'pkcs8',
    },
    'base64url',
  );

  return `${message}.${signature}`;
}

async function getInstallationToken(config) {
  if (config.githubTriggerToken) {
    return config.githubTriggerToken;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedInstallationToken && cachedTokenExpiration > now + 60) {
    return cachedInstallationToken;
  }

  const appJwt = issueGithubAppJwt(config);
  const response = await fetch(
    `${config.githubApiBaseUrl}/app/installations/${config.githubAppInstallationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  const body = await response.json();
  if (!response.ok || !body.token) {
    throw new HttpError(502, {
      error: 'github_app_token_exchange_failed',
      details: body,
    });
  }

  cachedInstallationToken = body.token;
  cachedTokenExpiration = Math.floor(new Date(body.expires_at).getTime() / 1000);

  return body.token;
}

async function githubRequest(config, path, options = {}) {
  const url = new URL(path, config.githubApiBaseUrl);
  const token = await getInstallationToken(config);
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'actions-ci-backend',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();
  const responseBody = responseText ? JSON.parse(responseText) : null;

  if (!response.ok) {
    throw new HttpError(502, {
      error: 'github_api_request_failed',
      status: response.status,
      details: responseBody,
    });
  }

  return responseBody;
}

function parsePositiveInteger(value, fallback, max) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

class HttpError extends Error {
  constructor(statusCode, body) {
    super(body.error);
    this.statusCode = statusCode;
    this.body = body;
  }
}