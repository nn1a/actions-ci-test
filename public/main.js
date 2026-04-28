const API_BASE = '';

async function init() {
  try {
    const me = await fetch(`${API_BASE}/api/me`).then((r) => r.json());
    renderLoggedIn(me);
    loadRuns();
  } catch {
    renderNotLoggedIn();
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

function renderLoggedIn(user) {
  document.getElementById('user-info').textContent = `Logged in as ${user.github_login}`;

  const app = document.getElementById('app');
  app.innerHTML = `
    <form id="request-form">
      <div class="form-group">
        <label for="job-type">Job Type</label>
        <select id="job-type" name="job_type" required>
          <option value="">Select a job type</option>
          <option value="deploy-staging">Deploy to Staging</option>
        </select>
      </div>

      <div class="form-group">
        <label for="service">Service</label>
        <select id="service" name="service" required>
          <option value="">Select a service</option>
          <option value="billing-api">billing-api</option>
          <option value="auth-api">auth-api</option>
          <option value="web-frontend">web-frontend</option>
        </select>
      </div>

      <div class="form-group">
        <label for="version">Version</label>
        <input type="text" id="version" name="version" placeholder="e.g., 1.14.2" required />
      </div>

      <div class="form-group">
        <label for="environment">Environment</label>
        <select id="environment" name="environment" required>
          <option value="">Select an environment</option>
          <option value="staging">Staging</option>
          <option value="prod">Production</option>
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
      <ul class="runs-list" id="runs-list"></ul>
    </div>
  `;

  document.getElementById('request-form').addEventListener('submit', submitRequest);
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
    setTimeout(() => loadRuns(), 1000);
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

async function loadRuns() {
  try {
    const res = await fetch(`${API_BASE}/api/runs`);
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

async function logOut() {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    location.reload();
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

init();
