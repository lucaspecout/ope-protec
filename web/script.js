const apiBase = '/api';
let token = localStorage.getItem('token');

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
}

function showLogin() {
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
  passwordForm.classList.add('hidden');
  loginForm.classList.remove('hidden');
}

async function apiFetch(path, options = {}) {
  const headers = {
    ...authHeaders(),
    ...(options.headers || {}),
  };
  if (!Object.prototype.hasOwnProperty.call(headers, 'Content-Type')) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 403) {
    showLogin();
  }
  return response;
}

async function loadDashboard() {
  const res = await apiFetch('/dashboard');
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('vigilance').textContent = data.vigilance;
  document.getElementById('crues').textContent = data.crues;
  const risk = document.getElementById('risk');
  risk.textContent = data.global_risk;
  risk.className = data.global_risk;
  document.getElementById('crisis').textContent = data.communes_crise;
  document.getElementById('logs').innerHTML = data.latest_logs
    .map((l) => `<li>${new Date(l.created_at).toLocaleString()} - ${l.event_type}</li>`)
    .join('');
}

async function loadMunicipalities() {
  const res = await apiFetch('/municipalities', { headers: { Accept: 'application/json' } });
  if (!res.ok) return;
  const municipalities = await res.json();
  const list = document.getElementById('municipalities-list');
  list.innerHTML = municipalities.map((m) => `
    <li>
      <strong>${m.name}</strong> — ${m.manager} (${m.phone})
      <button data-id="${m.id}" class="crisis-toggle">${m.crisis_mode ? 'Retirer crise' : 'Mode crise'}</button>
    </li>
  `).join('');

  document.querySelectorAll('.crisis-toggle').forEach((button) => {
    button.addEventListener('click', async () => {
      await apiFetch(`/municipalities/${button.dataset.id}/crisis`, { method: 'POST', headers: { Accept: 'application/json' } });
      await Promise.all([loadMunicipalities(), loadDashboard()]);
    });
  });
}

async function login(username, password) {
  const body = new URLSearchParams({ username, password });
  const res = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    loginError.textContent = 'Identifiants invalides.';
    return;
  }

  loginError.textContent = '';
  const data = await res.json();
  token = data.access_token;
  localStorage.setItem('token', token);

  if (data.must_change_password) {
    loginForm.classList.add('hidden');
    passwordForm.classList.remove('hidden');
    return;
  }

  showApp();
  await Promise.all([loadDashboard(), loadMunicipalities()]);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  await login(formData.get('username'), formData.get('password'));
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(passwordForm);
  const res = await apiFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({
      current_password: formData.get('current_password'),
      new_password: formData.get('new_password'),
    }),
  });

  if (!res.ok) {
    passwordError.textContent = 'Impossible de modifier le mot de passe.';
    return;
  }

  passwordError.textContent = '';
  showApp();
  await Promise.all([loadDashboard(), loadMunicipalities()]);
});

document.getElementById('municipality-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  await apiFetch('/municipalities', {
    method: 'POST',
    body: JSON.stringify({
      name: formData.get('name'),
      phone: formData.get('phone'),
      email: formData.get('email'),
      manager: formData.get('manager'),
    }),
  });
  event.target.reset();
  await Promise.all([loadMunicipalities(), loadDashboard()]);
});

document.getElementById('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  await apiFetch('/logs', {
    method: 'POST',
    body: JSON.stringify({
      event_type: formData.get('event_type'),
      description: formData.get('description'),
    }),
  });
  event.target.reset();
  await loadDashboard();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  token = null;
  showLogin();
});

document.querySelectorAll('.menu-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.menu-btn').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');

    document.querySelectorAll('.panel').forEach((panel) => panel.classList.add('hidden'));
    document.getElementById(button.dataset.target).classList.remove('hidden');
  });
});

if (token) {
  showApp();
  Promise.all([loadDashboard(), loadMunicipalities()]);
} else {
  showLogin();
}
