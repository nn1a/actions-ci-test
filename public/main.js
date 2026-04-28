const API_BASE = '';

const DEFAULT_OPTIONS = {
  job_types: ['deploy-staging'],
  services: ['billing-api', 'auth-api', 'web-frontend'],
  environments: ['staging', 'prod'],
};

let currentRunFilters = {
  requester: '',
  request_id: '',
};

async function init() {
  try {
    const me = await fetch(`${API_BASE}/api/me`).then((r) => r.json());
    const options = await fetchOptions();
    renderLoggedIn(me, options);
    loadRuns(currentRunFilters);
  } catch {
    renderNotLoggedIn();
  }
}

async function fetchOptions() {
  try {
    const res = await fetch(`${API_BASE}/api/options`);
    if (!res.ok) {
      return DEFAULT_OPTIONS;
    }

    const data = await res.json();
    return {
      job_types: Array.isArray(data.job_types) && data.job_types.length ? data.job_types : DEFAULT_OPTIONS.job_types,
      services: Array.isArray(data.services) && data.services.length ? data.services : DEFAULT_OPTIONS.services,
      environments: Array.isArray(data.environments) && data.environments.length
        ? data.environments
        : DEFAULT_OPTIONS.environments,
    };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function renderNotLoggedIn() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-section">
      <p>Sign in with GitHub to trigger workflows</p>
      <a href="/auth/github/login" class="btn">Sign in with GitHub</a>
    </div>
  `;
}

function renderLoggedIn(user, options) {
  document.getElementById('user-info').textContent = `Logged in as ${user.github_login}`;

  const jobTypeOptions = buildOptionsHtml(options.job_types, 'Select a job type');
  const serviceOptions = buildOptionsHtml(options.services, 'Select a service');
  const environmentOptions = buildOptionsHtml(options.environments, 'Select an environment');

  const app = document.getElementById('app');
  app.innerHTML = `
    <form id="request-form">
      <div class="form-group">
        <label for="job-type">Job Type</label>
        <select id="job-type" name="job_type" required>
          ${jobTypeOptions}
        </select>
      </div>

      <div class="form-group">
        <label for="service">Service</label>
        <select id="service" name="service" required>
          ${serviceOptions}
        </select>
      </div>

      <div class="form-group">
        <label for="version">Version</label>
        <input type="text" id="version" name="version" placeholder="e.g., 1.14.2" required />
      </div>

      <div class="form-group">
        <label for="environment">Environment</label>
        <select id="environment" name="environment" required>
          ${environmentOptions}
        </select>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn">Submit Request</button>
        <button type="button" class="btn btn-secondary" onclick="logOut()">Log Out</button>
      </div>
      <div class="loading" id="loading">Submitting...</div>
    </form>

    <div id="alerts"></div>

    <div class="runs-section">
      <h2>Recent Runs</h2>
      <form id="runs-filter-form" class="form-group" style="margin-bottom: 12px;">
        <div class="form-group">
          <label for="filter-requester">Requester</label>
          <input type="text" id="filter-requester" placeholder="e.g., nn1a" />
        </div>
        <div class="form-group">
          <label for="filter-request-id">Request ID</label>
          <input type="text" id="filter-request-id" placeholder="e.g., req_20260429..." />
        </div>
        <div class="form-actions" style="margin-top: 8px;">
          <button type="submit" class="btn btn-secondary">Apply Filters</button>
          <button type="button" id="clear-filters" class="btn btn-secondary">Clear</button>
        </div>
      </form>
      <ul class="runs-list" id="runs-list"></ul>
    </div>
  `;

  document.getElementById('request-form').addEventListener('submit', submitRequest);
  document.getElementById('runs-filter-form').addEventListener('submit', applyRunFilters);
  document.getElementById('clear-filters').addEventListener('click', clearRunFilters);
}

function buildOptionsHtml(values, placeholder) {
  return [`<option value="">${placeholder}</option>`]
    .concat(values.map((value) => `<option value="${value}">${value}</option>`))
    .join('');
}

async function submitRequest(e) {
  e.preventDefault();

  const loading = document.getElementById('loading');
  const alerts = document.getElementById('alerts');
  alerts.innerHTML = '';
  loading.classList.add('active');

  try {
    const csrfRes = await fetch(`${API_BASE}/api/csrf-token`);
    const csrfData = await csrfRes.json();
    const csrfToken = csrfData.csrf_token;

    const formData = new FormData(document.getElementById('request-form'));
    const body = {
      job_type: formData.get('job_type'),
      parameters: {
        service: formData.get('service'),
        version: formData.get('version'),
        environment: formData.get('environment'),
      },
    };

    const res = await fetch(`${API_BASE}/api/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }

    alerts.innerHTML = `
      <div class="alert alert-success">
        Request submitted successfully!<br/>
        Request ID: <code>${data.request_id}</code>
      </div>
    `;

    document.getElementById('request-form').reset();
    setTimeout(() => loadRuns(currentRunFilters), 1000);
  } catch (error) {
    alerts.innerHTML = `
      <div class="alert alert-error">
        Error: ${error.message}
      </div>
    `;
  } finally {
    loading.classList.remove('active');
  }
}

async function loadRuns(filters = currentRunFilters) {
  try {
    const params = new URLSearchParams();
    if (filters.requester) {
      params.set('requester', filters.requester);
    }
    if (filters.request_id) {
      params.set('request_id', filters.request_id);
    }
    const query = params.toString();
    const res = await fetch(`${API_BASE}/api/runs${query ? `?${query}` : ''}`);
    const data = await res.json();
    const runs = data.runs || [];

    const runsList = document.getElementById('runs-list');
    if (!runsList) return;

    if (runs.length === 0) {
      runsList.innerHTML = '<li style="padding: 12px; color: #586069;">No runs yet</li>';
      return;
    }

    runsList.innerHTML = runs
      .slice(0, 10)
      .map(
        (run) => `
      <li class="run-item">
        <div class="run-name">${run.run_name}</div>
        <span class="run-status status-${run.conclusion || run.status}">${run.conclusion || run.status}</span>
        <a href="${run.html_url}" target="_blank" class="run-link">View</a>
      </li>
    `,
      )
      .join('');
  } catch (error) {
    console.error('Failed to load runs:', error);
  }
}

function applyRunFilters(e) {
  e.preventDefault();
  const requester = document.getElementById('filter-requester').value.trim();
  const requestId = document.getElementById('filter-request-id').value.trim();
  currentRunFilters = {
    requester,
    request_id: requestId,
  };
  loadRuns(currentRunFilters);
}

function clearRunFilters() {
  document.getElementById('filter-requester').value = '';
  document.getElementById('filter-request-id').value = '';
  currentRunFilters = {
    requester: '',
    request_id: '',
  };
  loadRuns(currentRunFilters);
}

async function logOut() {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    location.reload();
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

init();
