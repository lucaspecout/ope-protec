const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel' };
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'supervision-panel': 'Supervision crise',
  'municipalities-panel': 'Communes partenaires',
  'logs-panel': 'Main courante opérationnelle',
  'map-panel': 'Carte stratégique Isère',
  'users-panel': 'Gestion des utilisateurs',
};

let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
let pendingCurrentPassword = '';
let refreshTimer = null;
let homeLiveTimer = null;

let leafletMap = null;
let boundaryLayer = null;
let hydroLayer = null;
let pcsLayer = null;

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');

const normalizeLevel = (level) => ({ verte: 'vert', green: 'vert', yellow: 'jaune', red: 'rouge' }[(level || '').toLowerCase()] || (level || 'vert').toLowerCase());
const levelColor = (level) => ({ vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' }[normalizeLevel(level)] || '#2f9e44');

function setVisibility(node, visible) {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.hidden = !visible;
}

function canEdit() { return ['admin', 'ope'].includes(currentUser?.role); }
function canManageUsers() { return ['admin', 'ope'].includes(currentUser?.role); }
function roleLabel(role) { return { admin: 'Admin', ope: 'Opérateur', securite: 'Sécurité', visiteur: 'Visiteur', mairie: 'Mairie' }[role] || role; }

function showHome() { setVisibility(homeView, true); setVisibility(loginView, false); setVisibility(appView, false); }
function showLogin() { setVisibility(homeView, false); setVisibility(loginView, true); setVisibility(appView, false); setVisibility(passwordForm, false); setVisibility(loginForm, true); }
function showApp() { setVisibility(homeView, false); setVisibility(loginView, false); setVisibility(appView, true); }

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = 'Erreur API';
    try { const payload = await response.json(); message = payload.detail || payload.message || message; } catch {}
    if (response.status === 401) logout();
    throw new Error(message);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function setActivePanel(panelId) {
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.target === panelId));
  document.querySelectorAll('.view').forEach((panel) => setVisibility(panel, panel.id === panelId));
  document.getElementById('panel-title').textContent = PANEL_TITLES[panelId] || 'Centre opérationnel';
  if (panelId === 'map-panel' && leafletMap) setTimeout(() => leafletMap.invalidateSize(), 100);
}

function initMap() {
  if (leafletMap || typeof window.L === 'undefined') return;
  leafletMap = window.L.map('isere-map-leaflet', { zoomControl: true }).setView([45.2, 5.72], 9);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(leafletMap);
  hydroLayer = window.L.layerGroup().addTo(leafletMap);
  pcsLayer = window.L.layerGroup().addTo(leafletMap);
}

async function loadIsereBoundary() {
  initMap();
  const data = await fetch('/public/isere-map').then((r) => r.json());
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 } }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
}

function renderStations(stations = []) {
  document.getElementById('hydro-stations-list').innerHTML = stations.slice(0, 12).map((s) => `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(s.level)}">${normalizeLevel(s.level)}</span> · ${s.height_m} m</li>`).join('') || '<li>Aucune station.</li>';
  if (!hydroLayer) return;
  hydroLayer.clearLayers();
  stations.forEach((s) => {
    if (s.lat == null || s.lon == null) return;
    window.L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: levelColor(s.level), fillOpacity: 0.95 })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Niveau: ${normalizeLevel(s.level)}<br>Hauteur: ${s.height_m} m`)
      .addTo(hydroLayer);
  });
}

function renderMunicipalitiesOnMap(municipalities = []) {
  const pcs = municipalities.filter((m) => m.pcs_active);
  document.getElementById('pcs-list').innerHTML = pcs.slice(0, 15).map((m) => `<li><strong>${m.name}</strong> · ${m.manager} · ${m.crisis_mode ? 'CRISE' : 'veille'}</li>`).join('') || '<li>Aucune commune PCS.</li>';
  if (!pcsLayer) return;
  pcsLayer.clearLayers();
}

function renderItinisereEvents(events = [], targetId = 'itinerary-list') {
  document.getElementById(targetId).innerHTML = events.slice(0, 8).map((e) => `<li><strong>${e.title}</strong><br>${e.description || ''}<br><a href="${e.link}" target="_blank" rel="noreferrer">Détail</a></li>`).join('') || '<li>Aucune perturbation publiée.</li>';
}

async function loadDashboard() {
  const dashboard = await api('/dashboard');
  document.getElementById('vigilance').textContent = normalizeLevel(dashboard.vigilance);
  document.getElementById('crues').textContent = normalizeLevel(dashboard.crues);
  document.getElementById('risk').textContent = normalizeLevel(dashboard.global_risk);
  document.getElementById('crisis').textContent = String(dashboard.communes_crise || 0);
  document.getElementById('latest-logs').innerHTML = (dashboard.latest_logs || []).map((l) => `<li><strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun événement récent.</li>';
}

async function loadExternalRisks() {
  const data = await api('/external/isere/risks');
  document.getElementById('meteo-status').textContent = `${data.meteo_france.status} · niveau ${normalizeLevel(data.meteo_france.level)}`;
  document.getElementById('meteo-info').textContent = data.meteo_france.info_state || data.meteo_france.bulletin_title || '';
  document.getElementById('vigicrues-status').textContent = `${data.vigicrues.status} · niveau ${normalizeLevel(data.vigicrues.water_alert_level)}`;
  document.getElementById('vigicrues-info').textContent = `Stations surveillées: ${(data.vigicrues.stations || []).length}`;
  document.getElementById('stations-list').innerHTML = (data.vigicrues.stations || []).slice(0, 10).map((s) => `<li>${s.station || s.code} · ${s.river || ''} · ${normalizeLevel(s.level)} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible.</li>';

  renderStations(data.vigicrues.stations || []);
  renderItinisereEvents(data.itinisere?.events || []);
  document.getElementById('meteo-level').textContent = normalizeLevel(data.meteo_france.level || 'vert');
  document.getElementById('river-level').textContent = normalizeLevel(data.vigicrues.water_alert_level || 'vert');
}

async function loadSupervision() {
  const data = await api('/supervision/overview');
  document.getElementById('supervision-meteo').textContent = `${data.alerts.meteo.status} · ${normalizeLevel(data.alerts.meteo.level || 'inconnu')}`;
  document.getElementById('supervision-vigicrues').textContent = `${data.alerts.vigicrues.status} · ${normalizeLevel(data.alerts.vigicrues.water_alert_level || 'inconnu')}`;
  document.getElementById('supervision-itinisere').textContent = `${data.alerts.itinisere.status} · ${data.alerts.itinisere.events.length} alertes`;
  document.getElementById('supervision-crisis-count').textContent = String(data.crisis_municipalities.length || 0);
  document.getElementById('supervision-timeline').innerHTML = (data.timeline || []).map((l) => `<li>${new Date(l.created_at).toLocaleString()} · <strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun historique.</li>';
  renderItinisereEvents(data.alerts.itinisere.events || [], 'supervision-itinisere-events');
}

async function loadMunicipalities() {
  const municipalities = await api('/municipalities');
  document.getElementById('municipalities-list').innerHTML = municipalities.map((m) => `<li><strong>${m.name}</strong> · ${m.manager} · ${m.phone} · ${m.crisis_mode ? 'CRISE' : 'veille'} </li>`).join('') || '<li>Aucune commune.</li>';
  renderMunicipalitiesOnMap(municipalities);
}

async function loadLogs() {
  const dashboard = await api('/dashboard');
  document.getElementById('logs-list').innerHTML = (dashboard.latest_logs || []).map((l) => `<li>${new Date(l.created_at).toLocaleString()} · <strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun log.</li>';
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const users = await api('/auth/users');
  document.getElementById('users-table').innerHTML = users.map((u) => `<tr><td>${u.username}</td><td>${roleLabel(u.role)}</td><td>${u.municipality_name || '-'}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td></tr>`).join('');
}

async function refreshAll() {
  try {
    await Promise.all([loadDashboard(), loadExternalRisks(), loadMunicipalities(), loadLogs(), loadUsers(), loadSupervision()]);
    document.getElementById('dashboard-error').textContent = '';
  } catch (error) {
    document.getElementById('dashboard-error').textContent = error.message;
  }
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
}

function bindHomeInteractions() {
  const openLogin = () => showLogin();
  document.getElementById('open-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('hero-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('back-home-btn')?.addEventListener('click', showHome);
  document.getElementById('scroll-actions-btn')?.addEventListener('click', () => document.getElementById('home-actions')?.scrollIntoView({ behavior: 'smooth' }));
}

function bindAppInteractions() {
  document.querySelectorAll('.menu-btn').forEach((button) => button.addEventListener('click', () => setActivePanel(button.dataset.target)));
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('refresh-btn').addEventListener('click', refreshAll);
}

function logout() {
  token = null;
  currentUser = null;
  localStorage.removeItem(STORAGE_KEYS.token);
  if (refreshTimer) clearInterval(refreshTimer);
  showHome();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => token && refreshAll(), 120000);
}

async function loadHomeLiveStatus() {
  try {
    const data = await fetch('/public/live').then((r) => r.json());
    document.getElementById('home-meteo-state').textContent = normalizeLevel(data.dashboard.vigilance || '-');
    document.getElementById('home-river-state').textContent = normalizeLevel(data.dashboard.crues || '-');
    document.getElementById('home-global-risk').textContent = normalizeLevel(data.dashboard.global_risk || '-');
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

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('login-error').textContent = '';
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
    applyRoleVisibility();
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await loadIsereBoundary();
    await refreshAll();
    startAutoRefresh();
  } catch (error) {
    document.getElementById('login-error').textContent = error.message;
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('password-error').textContent = '';
  const form = new FormData(passwordForm);
  try {
    await api('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: pendingCurrentPassword, new_password: String(form.get('new_password')) }),
    });
    setVisibility(passwordForm, false);
    setVisibility(loginForm, true);
    document.getElementById('login-error').textContent = 'Mot de passe modifié. Reconnectez-vous.';
  } catch (error) {
    document.getElementById('password-error').textContent = error.message;
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
  bindAppInteractions();
  startHomeLiveRefresh();

  if (!token) return showHome();
  try {
    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    applyRoleVisibility();
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await loadIsereBoundary();
    await refreshAll();
    startAutoRefresh();
  } catch {
    logout();
  }
})();
