const STORAGE_KEYS = {
  token: 'token',
  activePanel: 'activePanel',
};

let token = localStorage.getItem(STORAGE_KEYS.token);
let pendingCurrentPassword = '';
let currentUser = null;
let activePanelId = localStorage.getItem(STORAGE_KEYS.activePanel) || 'dashboard-panel';

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');
const dashboardError = document.getElementById('dashboard-error');

function sanitizeCredentialParamsFromUrl() {
  const url = new URL(window.location.href);
  const sensitiveParams = ['username', 'password', 'token'];
  const hadSensitiveParams = sensitiveParams.some((param) => url.searchParams.has(param));

  if (!hadSensitiveParams) {
    return;
  }

  sensitiveParams.forEach((param) => url.searchParams.delete(param));
  const safeUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, '', safeUrl);
  loginError.textContent = 'Pour votre sécurité, saisissez vos identifiants dans le formulaire (pas dans l\'URL).';
}

function setVisibility(element, isVisible) {
  element.classList.toggle('hidden', !isVisible);
  element.hidden = !isVisible;
}

function canEdit() {
  return ['admin', 'ope'].includes(currentUser?.role);
}

function canManageUsers() {
  return ['admin', 'ope'].includes(currentUser?.role);
}

function setActivePanel(panelId) {
  activePanelId = panelId;
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);

  document.querySelectorAll('.menu-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.target === panelId);
  });

  document.querySelectorAll('.panel').forEach((panel) => {
    setVisibility(panel, panel.id === panelId);
  });
}

function restoreActivePanel() {
  const panelExists = document.getElementById(activePanelId);
  const usersPanelRequested = activePanelId === 'users-panel';
  const allowedPanelId = panelExists && (!usersPanelRequested || canManageUsers())
    ? activePanelId
    : 'dashboard-panel';
  setActivePanel(allowedPanelId);
}


function roleLabel(role) {
  return {
    admin: 'Admin',
    ope: 'Opérateur',
    securite: 'Sécurité',
    visiteur: 'Visiteur',
    mairie: 'Mairie',
  }[role] || role;
}

function updateUsersSummary(users = []) {
  const total = users.length;
  const mairie = users.filter((user) => user.role === 'mairie').length;
  const privileged = users.filter((user) => ['admin', 'ope'].includes(user.role)).length;
  document.getElementById('users-total').textContent = total;
  document.getElementById('users-mairie').textContent = mairie;
  document.getElementById('users-privileged').textContent = privileged;
}

function renderUsers(users = []) {
  const table = document.getElementById('users-table');
  if (!table) {
    return;
  }

  if (users.length === 0) {
    table.innerHTML = '<tr><td colspan="5" class="muted">Aucun compte disponible pour votre rôle.</td></tr>';
    return;
  }

  table.innerHTML = users
    .map((user) => `
      <tr>
        <td><strong>${user.username}</strong></td>
        <td>${roleLabel(user.role)}</td>
        <td>${user.municipality_name || '-'}</td>
        <td>${new Date(user.created_at).toLocaleDateString()}</td>
        <td>${user.must_change_password ? '<span class="badge warning">Mot de passe à changer</span>' : '<span class="badge success">Actif</span>'}</td>
      </tr>
    `)
    .join('');
}

async function loadUsers() {
  if (!canManageUsers()) {
    return;
  }

  try {
    const users = await api('/auth/users');
    updateUsersSummary(users);
    renderUsers(users);
    document.getElementById('user-error').textContent = '';
  } catch (error) {
    document.getElementById('user-error').textContent = error.message;
  }
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

function applyRoleVisibility() {
  document.getElementById('current-role').textContent = currentUser?.role || '-';
  document.getElementById('current-commune').textContent = currentUser?.municipality_name || 'Toutes';

  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  const usersMenu = document.querySelector('.menu-btn[data-target="users-panel"]');
  setVisibility(usersMenu, canManageUsers());
  setVisibility(document.getElementById('users-create-card'), canManageUsers());
  restoreActivePanel();
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
      if (Array.isArray(payload.detail)) {
        message = payload.detail.map((issue) => issue.msg || issue).join(' · ');
      } else if (typeof payload.detail === 'string') {
        message = payload.detail;
      }
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

const LEVEL_COLORS = {
  green: { meteo: '#2eb85c', river: '#2f9e44' },
  yellow: { meteo: '#ffd43b', river: '#f59f00' },
  orange: { meteo: '#ff922b', river: '#f76707' },
  red: { meteo: '#fa5252', river: '#e03131' },
};

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
  isereShape.style.fill = LEVEL_COLORS[meteoLevel].meteo;

  meteoChip.classList.remove(...meteoClasses);
  meteoChip.classList.add(`meteo-${meteoLevel}`);
  meteoChip.style.backgroundColor = LEVEL_COLORS[meteoLevel].meteo;

  riverChip.classList.remove(...riverClasses);
  riverChip.classList.add(`river-${riverLevel}`);
  riverChip.style.backgroundColor = LEVEL_COLORS[riverLevel].river;

  riverPaths.forEach((path) => {
    path.classList.remove(...riverClasses);
    path.classList.add(`river-${riverLevel}`);
    path.style.stroke = LEVEL_COLORS[riverLevel].river;
  });

  document.getElementById('meteo-level').textContent = levelLabel(meteoLevel);
  document.getElementById('river-level').textContent = levelLabel(riverLevel);
}

function extractMeteoCauses(...values) {
  const knownCauses = [
    'pluie-inondation',
    'pluie',
    'inondation',
    'neige-verglas',
    'neige',
    'verglas',
    'orages',
    'orages violents',
    'vent violent',
    'canicule',
    'grand froid',
    'avalanches',
  ];

  const text = values
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' | ');

  const matches = knownCauses.filter((cause) => text.includes(cause));
  return [...new Set(matches)];
}

function setMeteoCauseText(causes) {
  const causeNode = document.getElementById('meteo-cause');
  if (!causes || causes.length === 0) {
    causeNode.textContent = 'Aucun phénomène signalé.';
    return;
  }

  causeNode.textContent = causes.map((cause) => cause.charAt(0).toUpperCase() + cause.slice(1)).join(' · ');
}

async function loadExternalRisks() {
  try {
    const payload = await api('/external/isere/risks');
    const meteo = payload?.meteo_france || {};
    const causes = extractMeteoCauses(meteo.bulletin_title, meteo.info_state);
    setMeteoCauseText(causes);
  } catch {
    setMeteoCauseText([]);
  }
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
    setMeteoCauseText(extractMeteoCauses(data.vigilance_risk_type));

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
        ${canEdit() ? `<button data-id="${m.id}" class="crisis-toggle">${m.crisis_mode ? 'Retirer crise' : 'Mode crise'}</button>` : ''}
      </li>
    `).join('');

    document.querySelectorAll('.crisis-toggle').forEach((button) => {
      button.addEventListener('click', async () => {
        await api(`/municipalities/${button.dataset.id}/crisis`, { method: 'POST' });
        await loadMunicipalities();
        await loadDashboard();
      });
    });

    const options = municipalities.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    document.getElementById('log-municipality').innerHTML = '<option value="">Toutes / non précisé</option>' + options;
    document.getElementById('user-mairie-name').innerHTML = '<option value="">Sélectionner une commune</option>' + municipalities.map((m) => `<option value="${m.name}">${m.name}</option>`).join('');
  } catch (error) {
    dashboardError.textContent = error.message;
  }
}

async function loadCurrentUser() {
  currentUser = await api('/auth/me');
  applyRoleVisibility();
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
    await loadCurrentUser();
    await loadDashboard();
    await loadExternalRisks();
    await loadMunicipalities();
    await loadUsers();
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
    await loadCurrentUser();
    await loadDashboard();
    await loadExternalRisks();
    await loadMunicipalities();
    await loadUsers();
  } catch (error) {
    passwordError.textContent = error.message;
  }
}

function logout() {
  localStorage.removeItem(STORAGE_KEYS.token);
  token = null;
  currentUser = null;
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
    await loadExternalRisks();
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
        municipality_id: formData.get('municipality_id') || null,
      }),
    });
    event.target.reset();
    await loadDashboard();
    await loadExternalRisks();
  } catch (error) {
    dashboardError.textContent = error.message;
  }
});

document.getElementById('user-role').addEventListener('change', (event) => {
  setVisibility(document.getElementById('user-mairie-name'), event.target.value === 'mairie');
});

document.getElementById('user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const role = formData.get('role');
  const municipalityName = formData.get('municipality_name') || null;

  if (role === 'mairie' && !municipalityName) {
    document.getElementById('user-error').textContent = 'Sélectionnez une commune pour créer un compte mairie.';
    return;
  }

  try {
    await api('/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
        role,
        municipality_name: municipalityName,
      }),
    });
    document.getElementById('user-error').textContent = 'Compte créé avec succès.';
    event.target.reset();
    setVisibility(document.getElementById('user-mairie-name'), false);
    await loadUsers();
  } catch (error) {
    document.getElementById('user-error').textContent = error.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', logout);

document.querySelectorAll('.menu-btn').forEach((button) => {
  button.addEventListener('click', () => {
    setActivePanel(button.dataset.target);
  });
});

(async () => {
  sanitizeCredentialParamsFromUrl();

  if (!token) {
    showLogin();
    return;
  }

  showApp();
  try {
    await loadCurrentUser();
    await loadDashboard();
    await loadExternalRisks();
    await loadMunicipalities();
    await loadUsers();
  } catch {
    logout();
  }
})();
