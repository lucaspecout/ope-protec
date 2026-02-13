const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel' };
let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
let pendingCurrentPassword = '';

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');

function setVisibility(node, visible) { node.classList.toggle('hidden', !visible); node.hidden = !visible; }
function canEdit() { return ['admin', 'ope'].includes(currentUser?.role); }
function canManageUsers() { return ['admin', 'ope'].includes(currentUser?.role); }

function showHome() {
  setVisibility(appView, false);
  setVisibility(loginView, false);
  setVisibility(homeView, true);
}

function showLogin() {
  setVisibility(appView, false);
  setVisibility(homeView, false);
  setVisibility(loginView, true);
  setVisibility(passwordForm, false);
  setVisibility(loginForm, true);
}

function showApp() {
  setVisibility(homeView, false);
  setVisibility(loginView, false);
  setVisibility(appView, true);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = 'Erreur API';
    try { const payload = await response.json(); message = payload.detail || message; } catch {}
    if (response.status === 401) logout();
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function setActivePanel(panelId) {
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === panelId));
  document.querySelectorAll('.view').forEach((panel) => setVisibility(panel, panel.id === panelId));
}

function roleLabel(role) { return { admin: 'Admin', ope: 'Opérateur', securite: 'Sécurité', visiteur: 'Visiteur', mairie: 'Mairie' }[role] || role; }

function paintMap(meteo, river) {
  const norm = (v) => ({ green: 'vert', yellow: 'jaune', orange: 'orange', red: 'rouge', vert: 'vert', jaune: 'jaune', rouge: 'rouge' }[(v || '').toLowerCase()] || 'vert');
  const colors = { vert: '#2eb85c', jaune: '#ffd43b', orange: '#ff922b', rouge: '#fa5252' };
  const riverColors = { vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' };
  const meteoLevel = norm(meteo);
  const riverLevel = norm(river);
  document.getElementById('isere-shape').style.fill = colors[meteoLevel];
  document.querySelectorAll('.river').forEach((r) => { r.style.stroke = riverColors[riverLevel]; });
  document.getElementById('meteo-level').textContent = meteoLevel;
  document.getElementById('river-level').textContent = riverLevel;
}

async function loadDashboard() {
  const dashboard = await api('/dashboard');
  document.getElementById('vigilance').textContent = dashboard.vigilance;
  document.getElementById('crues').textContent = dashboard.crues;
  const risk = document.getElementById('risk');
  risk.textContent = dashboard.global_risk;
  risk.className = dashboard.global_risk;
  document.getElementById('crisis').textContent = dashboard.communes_crise;
  document.getElementById('latest-logs').innerHTML = (dashboard.latest_logs || []).map((log) => `<li><strong>${log.event_type}</strong> · ${log.description}</li>`).join('') || '<li>Aucun événement</li>';
  paintMap(dashboard.vigilance, dashboard.crues);
}

async function loadExternalRisks() {
  const data = await api('/external/isere/risks');
  document.getElementById('meteo-status').textContent = `${data.meteo_france.status} · ${data.meteo_france.department}`;
  document.getElementById('meteo-info').textContent = data.meteo_france.info_state || data.meteo_france.bulletin_title || 'Pas de détail';
  document.getElementById('vigicrues-status').textContent = `${data.vigicrues.status} · niveau ${data.vigicrues.water_alert_level}`;
  document.getElementById('vigicrues-info').textContent = `Mise à jour: ${new Date(data.updated_at).toLocaleString()}`;
  const stations = (data.vigicrues.stations || []).slice(0, 8);
  document.getElementById('stations-list').innerHTML = stations.map((s) => `<li>${s.station || s.code} · ${s.river || 'Cours d\'eau'} · ${s.level} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible</li>';
}

async function loadMunicipalities() {
  const municipalities = await api('/municipalities');
  document.getElementById('municipalities-list').innerHTML = municipalities.map((m) => `<li><strong>${m.name}</strong> · ${m.manager} · ${m.phone} · ${m.crisis_mode ? 'CRISE' : 'veille'} </li>`).join('') || '<li>Aucune commune</li>';
}

async function loadLogs() {
  const dashboard = await api('/dashboard');
  document.getElementById('logs-list').innerHTML = (dashboard.latest_logs || []).map((l) => `<li>${new Date(l.created_at).toLocaleString()} · <strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun log</li>';
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const users = await api('/auth/users');
  document.getElementById('users-table').innerHTML = users.map((u) => `<tr><td>${u.username}</td><td>${roleLabel(u.role)}</td><td>${u.municipality_name || '-'}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td></tr>`).join('') || '<tr><td colspan="5">Aucun utilisateur</td></tr>';
}

async function refreshAll() {
  try {
    await Promise.all([loadDashboard(), loadExternalRisks(), loadMunicipalities(), loadLogs(), loadUsers()]);
    document.getElementById('dashboard-error').textContent = '';
  } catch (error) {
    document.getElementById('dashboard-error').textContent = error.message;
  }
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem(STORAGE_KEYS.token);
  showHome();
}

function bindHomeInteractions() {
  const menuToggle = document.getElementById('mobile-menu-btn');
  const homeNav = document.getElementById('home-nav');
  menuToggle?.addEventListener('click', () => {
    const isOpen = homeNav.classList.toggle('open');
    menuToggle.setAttribute('aria-expanded', String(isOpen));
  });

  const openLogin = () => {
    showLogin();
    homeNav?.classList.remove('open');
    menuToggle?.setAttribute('aria-expanded', 'false');
  };

  document.getElementById('open-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('hero-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('back-home-btn')?.addEventListener('click', showHome);
  document.getElementById('scroll-actions-btn')?.addEventListener('click', () => document.getElementById('home-actions')?.scrollIntoView({ behavior: 'smooth' }));

  const levels = {
    vert: { meteo: 'Vert', river: 'Vert', cell: 'Veille' },
    jaune: { meteo: 'Jaune', river: 'Surveillance', cell: 'Pré-alerte' },
    orange: { meteo: 'Orange', river: 'Fortes tensions', cell: 'Activation partielle' },
    rouge: { meteo: 'Rouge', river: 'Critique', cell: 'Cellule de crise active' },
  };

  document.querySelectorAll('.alert-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.alert-btn').forEach((b) => b.classList.toggle('active', b === button));
      const state = levels[button.dataset.level] || levels.vert;
      document.getElementById('home-meteo-state').textContent = state.meteo;
      document.getElementById('home-river-state').textContent = state.river;
      document.getElementById('home-cell-state').textContent = state.cell;
    });
  });

  document.querySelectorAll('.quick-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('quick-result').textContent = button.dataset.message;
    });
  });
}

document.querySelectorAll('.menu-btn').forEach((button) => button.addEventListener('click', () => setActivePanel(button.dataset.target)));
document.getElementById('logout-btn').addEventListener('click', logout);

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const form = new FormData(loginForm);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

  try {
    const payload = new URLSearchParams({ username, password });
    const result = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload });
    token = result.access_token;
    localStorage.setItem(STORAGE_KEYS.token, token);
    pendingCurrentPassword = password;

    if (result.must_change_password) {
      setVisibility(loginForm, false);
      setVisibility(passwordForm, true);
      return;
    }

    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    document.querySelectorAll('[data-requires-edit]').forEach((n) => setVisibility(n, canEdit()));
    setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await refreshAll();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordError.textContent = '';
  const form = new FormData(passwordForm);
  try {
    await api('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: pendingCurrentPassword, new_password: String(form.get('new_password')) }),
    });
    setVisibility(passwordForm, false);
    setVisibility(loginForm, true);
    loginError.textContent = 'Mot de passe modifié. Reconnectez-vous.';
  } catch (error) {
    passwordError.textContent = error.message;
  }
});

document.getElementById('municipality-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  await api('/municipalities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: form.get('name'), manager: form.get('manager'), phone: form.get('phone'), email: form.get('email') }),
  });
  event.target.reset();
  await loadMunicipalities();
});

document.getElementById('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  await api('/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: form.get('event_type'), description: form.get('description') }),
  });
  event.target.reset();
  await refreshAll();
});

(async function bootstrap() {
  bindHomeInteractions();

  if (!token) {
    showHome();
    return;
  }
  try {
    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    document.querySelectorAll('[data-requires-edit]').forEach((n) => setVisibility(n, canEdit()));
    setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await refreshAll();
  } catch {
    logout();
  }
})();
