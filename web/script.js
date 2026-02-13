const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel' };
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'municipalities-panel': 'Communes et fiches pratiques',
  'logs-panel': 'Main courante opérationnelle',
  'map-panel': 'Carte stratégique Isère',
  'users-panel': 'Gestion des utilisateurs',
};

let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
let pendingCurrentPassword = '';
let refreshTimer = null;
let homeLiveTimer = null;

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');

function setVisibility(node, visible) {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.hidden = !visible;
}

function canEdit() {
  return ['admin', 'ope'].includes(currentUser?.role);
}

function canManageUsers() {
  return ['admin', 'ope'].includes(currentUser?.role);
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
    try {
      const raw = await response.text();
      if (raw) {
        const payload = JSON.parse(raw);
        message = payload.detail || payload.message || message;
      }
    } catch {
      // ignore
    }
    if (response.status === 401) logout();
    throw new Error(message);
  }

  if (response.status === 204) return null;
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Réponse invalide reçue depuis ${path}`);
  }
}

function setActivePanel(panelId) {
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.target === panelId);
  });
  document.querySelectorAll('.view').forEach((panel) => {
    setVisibility(panel, panel.id === panelId);
  });
  document.getElementById('panel-title').textContent = PANEL_TITLES[panelId] || 'Centre opérationnel';
  document.getElementById('app-sidebar')?.classList.remove('open');
  const menuButton = document.getElementById('app-menu-btn');
  menuButton?.setAttribute('aria-expanded', 'false');
}


function geometryToPath(geometry, width = 420, height = 520) {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((poly) => poly[0]);
  const points = rings.flat();
  const xs = points.map((pt) => pt[0]);
  const ys = points.map((pt) => pt[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 20;
  const scaleX = (width - 2 * pad) / (maxX - minX || 1);
  const scaleY = (height - 2 * pad) / (maxY - minY || 1);

  return rings.map((ring) => ring.map((pt, index) => {
    const x = pad + (pt[0] - minX) * scaleX;
    const y = height - pad - (pt[1] - minY) * scaleY;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ') + ' Z').join(' ');
}

async function loadIsereMap() {
  try {
    const response = await fetch('/public/isere-map');
    if (!response.ok) throw new Error('Carte Isère indisponible');
    const data = await response.json();
    const geometry = data.geometry;
    if (!geometry || !geometry.coordinates) throw new Error('Géométrie invalide');
    const path = geometryToPath(geometry);
    document.getElementById('isere-shape').setAttribute('d', path);
    document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
  } catch (error) {
    document.getElementById('map-source').textContent = `Source carte: fallback local (${error.message})`;
  }
}

function paintMap(meteo, river) {
  const normalized = {
    green: 'vert',
    yellow: 'jaune',
    orange: 'orange',
    red: 'rouge',
    vert: 'vert',
    jaune: 'jaune',
    rouge: 'rouge',
  };

  const meteoLevel = normalized[(meteo || '').toLowerCase()] || 'vert';
  const riverLevel = normalized[(river || '').toLowerCase()] || 'vert';

  const meteoColors = { vert: '#2eb85c', jaune: '#ffd43b', orange: '#ff922b', rouge: '#fa5252' };
  const riverColors = { vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' };

  document.getElementById('isere-shape').style.fill = meteoColors[meteoLevel];
  document.querySelectorAll('.river').forEach((riverPath) => {
    riverPath.style.stroke = riverColors[riverLevel];
  });

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

  document.getElementById('crisis').textContent = String(dashboard.communes_crise || 0);
  document.getElementById('latest-logs').innerHTML = (dashboard.latest_logs || []).map(
    (log) => `<li><strong>${log.event_type}</strong> · ${log.description}</li>`,
  ).join('') || '<li>Aucun événement récent.</li>';

  paintMap(dashboard.vigilance, dashboard.crues);
}

async function loadExternalRisks() {
  const data = await api('/external/isere/risks');

  document.getElementById('meteo-status').textContent = `${data.meteo_france.status} · ${data.meteo_france.department} · niveau ${data.meteo_france.level || 'inconnu'}`;
  document.getElementById('meteo-info').textContent = data.meteo_france.info_state || data.meteo_france.bulletin_title || 'Pas de détail';

  document.getElementById('vigicrues-status').textContent = `${data.vigicrues.status} · niveau ${data.vigicrues.water_alert_level}`;
  document.getElementById('vigicrues-info').textContent = `Mise à jour: ${new Date(data.updated_at).toLocaleString()}`;

  const stations = (data.vigicrues.stations || []).slice(0, 10);
  document.getElementById('stations-list').innerHTML = stations.map(
    (station) => `<li>${station.station || station.code} · ${station.river || 'Cours d\'eau'} · ${station.level} · ${station.height_m} m</li>`,
  ).join('') || '<li>Aucune station disponible.</li>';
}

async function loadMunicipalities() {
  const municipalities = await api('/municipalities');
  document.getElementById('municipalities-list').innerHTML = municipalities.map(
    (municipality) => `<li><strong>${municipality.name}</strong> · ${municipality.manager} · ${municipality.phone} · ${municipality.crisis_mode ? 'CRISE' : 'veille'}</li>`,
  ).join('') || '<li>Aucune commune.</li>';
}

async function loadLogs() {
  const dashboard = await api('/dashboard');
  document.getElementById('logs-list').innerHTML = (dashboard.latest_logs || []).map(
    (log) => `<li>${new Date(log.created_at).toLocaleString()} · <strong>${log.event_type}</strong> · ${log.description}</li>`,
  ).join('') || '<li>Aucun log.</li>';
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const users = await api('/auth/users');
  document.getElementById('users-table').innerHTML = users.map(
    (user) => `<tr><td>${user.username}</td><td>${roleLabel(user.role)}</td><td>${user.municipality_name || '-'}</td><td>${new Date(user.created_at).toLocaleDateString()}</td><td>${user.must_change_password ? 'Changement requis' : 'Actif'}</td></tr>`,
  ).join('') || '<tr><td colspan="5">Aucun utilisateur</td></tr>';
}

async function refreshAll() {
  try {
    await Promise.all([loadDashboard(), loadExternalRisks(), loadMunicipalities(), loadLogs(), loadUsers()]);
    document.getElementById('dashboard-error').textContent = '';
  } catch (error) {
    document.getElementById('dashboard-error').textContent = error.message;
  }
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (token) refreshAll();
  }, 120000);
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem(STORAGE_KEYS.token);
  if (refreshTimer) clearInterval(refreshTimer);
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
  document.getElementById('scroll-actions-btn')?.addEventListener('click', () => {
    document.getElementById('home-actions')?.scrollIntoView({ behavior: 'smooth' });
  });

}

async function loadHomeLiveStatus() {
  try {
    const response = await fetch('/public/live');
    if (!response.ok) throw new Error('Flux temps réel indisponible');

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('Flux temps réel invalide (JSON attendu)');
    }

    document.getElementById('home-meteo-state').textContent = data.dashboard.vigilance || '-';
    document.getElementById('home-river-state').textContent = data.dashboard.crues || '-';
    document.getElementById('home-global-risk').textContent = data.dashboard.global_risk || '-';
    document.getElementById('home-crisis-count').textContent = String(data.dashboard.communes_crise ?? 0);
    document.getElementById('home-live-updated').textContent = `Dernière mise à jour: ${new Date(data.updated_at).toLocaleString()}`;
    document.getElementById('home-live-error').textContent = '';
  } catch (error) {
    document.getElementById('home-live-error').textContent = error.message;
  }
}

function startHomeLiveRefresh() {
  if (homeLiveTimer) clearInterval(homeLiveTimer);
  loadHomeLiveStatus();
  homeLiveTimer = setInterval(loadHomeLiveStatus, 60000);
}

function bindAppInteractions() {
  document.querySelectorAll('.menu-btn').forEach((button) => {
    button.addEventListener('click', () => setActivePanel(button.dataset.target));
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('refresh-btn')?.addEventListener('click', refreshAll);

  const appMenuBtn = document.getElementById('app-menu-btn');
  const sidebar = document.getElementById('app-sidebar');
  appMenuBtn?.addEventListener('click', () => {
    const opened = sidebar.classList.toggle('open');
    appMenuBtn.setAttribute('aria-expanded', String(opened));
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';

  const form = new FormData(loginForm);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

  try {
    const payload = new URLSearchParams({ username, password });
    const result = await api('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
    });

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
    applyRoleVisibility();

    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await refreshAll();
    startAutoRefresh();
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
      body: JSON.stringify({
        current_password: pendingCurrentPassword,
        new_password: String(form.get('new_password')),
      }),
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
    body: JSON.stringify({
      name: form.get('name'),
      manager: form.get('manager'),
      phone: form.get('phone'),
      email: form.get('email'),
    }),
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
    body: JSON.stringify({
      event_type: form.get('event_type'),
      description: form.get('description'),
    }),
  });

  event.target.reset();
  await refreshAll();
});

(async function bootstrap() {
  bindHomeInteractions();
  bindAppInteractions();
  startHomeLiveRefresh();
  loadIsereMap();

  if (!token) {
    showHome();
    return;
  }

  try {
    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    applyRoleVisibility();

    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await refreshAll();
    startAutoRefresh();
  } catch {
    logout();
  }
})();
