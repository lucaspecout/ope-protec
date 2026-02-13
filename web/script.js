const STORAGE_KEYS = {
  token: 'token',
};

let token = localStorage.getItem(STORAGE_KEYS.token);
let pendingCurrentPassword = '';

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');
const dashboardError = document.getElementById('dashboard-error');

function setVisibility(element, isVisible) {
  element.classList.toggle('hidden', !isVisible);
  element.hidden = !isVisible;
}

function showApp() {
  setVisibility(loginView, false);
  setVisibility(appView, true);
}

function showLogin() {
  setVisibility(appView, false);
  setVisibility(loginView, true);
  setVisibility(passwordForm, false);
  setVisibility(loginForm, true);
  pendingCurrentPassword = '';
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    logout();
    throw new Error('Session expirée, veuillez vous reconnecter.');
  }

  if (!response.ok) {
    let message = 'Une erreur est survenue.';
    try {
      const payload = await response.json();
      message = payload.detail || message;
    } catch {
      // Ignore JSON parse errors.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function normalizeRisk(value) {
  if (!value) return 'vert';
  const level = String(value).toLowerCase();
  if (['vert', 'green'].includes(level)) return 'vert';
  if (['orange', 'amber'].includes(level)) return 'orange';
  if (['rouge', 'red'].includes(level)) return 'rouge';
  return level;
}


function normalizeAlertLevel(value) {
  if (!value) return 'green';
  const level = String(value).toLowerCase();
  if (['vert', 'green', 'vigilance verte'].includes(level)) return 'green';
  if (['jaune', 'yellow', 'vigilance jaune'].includes(level)) return 'yellow';
  if (['orange', 'amber', 'vigilance orange'].includes(level)) return 'orange';
  if (['rouge', 'red', 'vigilance rouge'].includes(level)) return 'red';
  return 'green';
}

function levelLabel(level) {
  return {
    green: 'Vert',
    yellow: 'Jaune',
    orange: 'Orange',
    red: 'Rouge',
  }[level] || 'Vert';
}

function setMiniMapLevels(meteoValue, riverValue) {
  const meteoLevel = normalizeAlertLevel(meteoValue);
  const riverLevel = normalizeAlertLevel(riverValue);

  const meteoClasses = ['meteo-green', 'meteo-yellow', 'meteo-orange', 'meteo-red'];
  const riverClasses = ['river-green', 'river-yellow', 'river-orange', 'river-red'];

  const isereShape = document.getElementById('isere-shape');
  const meteoChip = document.getElementById('meteo-chip');
  const riverChip = document.getElementById('river-chip');
  const riverPaths = document.querySelectorAll('.river');

  isereShape.classList.remove(...meteoClasses);
  isereShape.classList.add(`meteo-${meteoLevel}`);

  meteoChip.classList.remove(...meteoClasses);
  meteoChip.classList.add(`meteo-${meteoLevel}`);

  riverChip.classList.remove(...riverClasses);
  riverChip.classList.add(`river-${riverLevel}`);

  riverPaths.forEach((path) => {
    path.classList.remove(...riverClasses);
    path.classList.add(`river-${riverLevel}`);
  });

  document.getElementById('meteo-level').textContent = levelLabel(meteoLevel);
  document.getElementById('river-level').textContent = levelLabel(riverLevel);
}

function renderLogs(logs) {
  document.getElementById('logs').innerHTML = logs
    .map((log) => `<li>${new Date(log.created_at).toLocaleString()} - ${log.event_type}</li>`)
    .join('');
}

async function loadDashboard() {
  try {
    dashboardError.textContent = '';
    const data = await api('/dashboard');
    document.getElementById('vigilance').textContent = data.vigilance;
    document.getElementById('crues').textContent = data.crues;
    setMiniMapLevels(data.vigilance, data.crues);

    const riskValue = normalizeRisk(data.global_risk);
    const risk = document.getElementById('risk');
    risk.textContent = riskValue;
    risk.className = riskValue;

    document.getElementById('crisis').textContent = data.communes_crise;
    renderLogs(data.latest_logs || []);
  } catch (error) {
    dashboardError.textContent = error.message;
  }
}

async function loadMunicipalities() {
  try {
    const municipalities = await api('/municipalities');
    const list = document.getElementById('municipalities-list');
    list.innerHTML = municipalities.map((m) => `
      <li>
        <strong>${m.name}</strong> — ${m.manager} (${m.phone})
        <button data-id="${m.id}" class="crisis-toggle">${m.crisis_mode ? 'Retirer crise' : 'Mode crise'}</button>
      </li>
    `).join('');

    document.querySelectorAll('.crisis-toggle').forEach((button) => {
      button.addEventListener('click', async () => {
        await api(`/municipalities/${button.dataset.id}/crisis`, { method: 'POST' });
        await loadMunicipalities();
        await loadDashboard();
      });
    });
  } catch (error) {
    dashboardError.textContent = error.message;
  }
}

async function login(username, password) {
  try {
    const payload = new URLSearchParams({ username, password });
    const data = await api('/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload,
    });

    loginError.textContent = '';
    token = data.access_token;
    localStorage.setItem(STORAGE_KEYS.token, token);

    if (data.must_change_password) {
      pendingCurrentPassword = password;
      setVisibility(loginForm, false);
      setVisibility(passwordForm, true);
      return;
    }

    showApp();
    await loadDashboard();
    await loadMunicipalities();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

async function updatePassword(newPassword) {
  try {
    await api('/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        current_password: pendingCurrentPassword,
        new_password: newPassword,
      }),
    });

    passwordError.textContent = '';
    pendingCurrentPassword = '';
    showApp();
    await loadDashboard();
    await loadMunicipalities();
  } catch (error) {
    passwordError.textContent = error.message;
  }
}

function logout() {
  localStorage.removeItem(STORAGE_KEYS.token);
  token = null;
  showLogin();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  login(formData.get('username'), formData.get('password'));
});

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(passwordForm);
  updatePassword(formData.get('new_password'));
});

document.getElementById('municipality-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  try {
    await api('/municipalities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: formData.get('name'),
        phone: formData.get('phone'),
        email: formData.get('email'),
        manager: formData.get('manager'),
      }),
    });
    event.target.reset();
    await loadMunicipalities();
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

document.getElementById('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  try {
    await api('/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: formData.get('event_type'),
        description: formData.get('description'),
      }),
    });
    event.target.reset();
    await loadDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.querySelectorAll('.menu-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.menu-btn').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');

    document.querySelectorAll('.panel').forEach((panel) => setVisibility(panel, false));
    setVisibility(document.getElementById(button.dataset.target), true);
  });
});

(async () => {
  if (!token) {
    showLogin();
    return;
  }

  showApp();
  await loadDashboard();
  await loadMunicipalities();
})();
