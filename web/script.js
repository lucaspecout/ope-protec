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

const RESOURCE_POINTS = [
  { name: 'PC Départemental Grenoble', type: 'poste_commandement', active: true, lat: 45.1885, lon: 5.7245, address: 'Grenoble' },
  { name: 'Centre hébergement Voiron', type: 'centre_hebergement', active: false, lat: 45.3667, lon: 5.5906, address: 'Voiron' },
  { name: 'CHU Grenoble Alpes', type: 'hopital', active: true, lat: 45.1899, lon: 5.7428, address: 'La Tronche' },
  { name: 'Caserne Bourgoin-Jallieu', type: 'caserne', active: true, lat: 45.5866, lon: 5.2732, address: 'Bourgoin-Jallieu' },
];

let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
let pendingCurrentPassword = '';
let refreshTimer = null;
let homeLiveTimer = null;

let leafletMap = null;
let boundaryLayer = null;
let hydroLayer = null;
let pcsLayer = null;
let resourceLayer = null;
let searchLayer = null;
let cachedStations = [];
let cachedMunicipalities = [];
let geocodeCache = new Map();

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
  const payload = await parseJsonResponse(response, path);
  if (!response.ok) {
    const message = payload?.detail || payload?.message || `Erreur API (${response.status})`;
    if (response.status === 401) logout();
    throw new Error(message);
  }
  return payload;
}

async function parseJsonResponse(response, path = '') {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`Réponse non-JSON pour ${path || response.url} (${response.status}): ${snippet}`);
  }
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
  resourceLayer = window.L.layerGroup().addTo(leafletMap);
  searchLayer = window.L.layerGroup().addTo(leafletMap);
}

async function loadIsereBoundary() {
  initMap();
  const response = await fetch('/public/isere-map');
  const data = await parseJsonResponse(response, '/public/isere-map');
  if (!response.ok) throw new Error(data?.detail || data?.message || `Erreur API (${response.status})`);
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 } }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
}

function renderStations(stations = []) {
  cachedStations = stations;
  const visible = document.getElementById('filter-hydro')?.checked ?? true;
  document.getElementById('hydro-stations-list').innerHTML = stations.slice(0, 12).map((s) => `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(s.level)}">${normalizeLevel(s.level)}</span> · ${s.height_m} m</li>`).join('') || '<li>Aucune station.</li>';
  if (!hydroLayer) return;
  hydroLayer.clearLayers();
  if (!visible) return;
  stations.forEach((s) => {
    if (s.lat == null || s.lon == null) return;
    window.L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: levelColor(s.level), fillOpacity: 0.95 })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Niveau: ${normalizeLevel(s.level)}<br>Hauteur: ${s.height_m} m`)
      .addTo(hydroLayer);
  });
}

async function geocodeMunicipality(municipality) {
  const key = `${municipality.name}|${municipality.postal_code || ''}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  if (!municipality.postal_code) return null;
  try {
    const url = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=centre&limit=1`;
    const response = await fetch(url);
    const payload = await response.json();
    const center = payload?.[0]?.centre?.coordinates;
    if (!Array.isArray(center) || center.length !== 2) return null;
    const point = { lat: center[1], lon: center[0] };
    geocodeCache.set(key, point);
    return point;
  } catch {
    return null;
  }
}

async function renderMunicipalitiesOnMap(municipalities = []) {
  cachedMunicipalities = municipalities;
  const pcs = municipalities.filter((m) => m.pcs_active);
  document.getElementById('pcs-list').innerHTML = pcs.slice(0, 15).map((m) => `<li><strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.crisis_mode ? 'CRISE' : 'veille'}</li>`).join('') || '<li>Aucune commune PCS.</li>';
  if (!pcsLayer) return;
  pcsLayer.clearLayers();
  if (!(document.getElementById('filter-pcs')?.checked ?? true)) return;
  const points = await Promise.all(pcs.map(async (m) => ({ municipality: m, point: await geocodeMunicipality(m) })));
  points.forEach(({ municipality, point }) => {
    if (!point) return;
    window.L.circleMarker([point.lat, point.lon], { radius: 8, color: '#fff', weight: 1.5, fillColor: '#17335f', fillOpacity: 0.9 })
      .bindPopup(`<strong>${municipality.name}</strong><br>Code postal: ${municipality.postal_code || '-'}<br>Responsable: ${municipality.manager}<br>PCS: actif`)
      .addTo(pcsLayer);
  });
}

function renderResources() {
  const onlyActive = document.getElementById('filter-resources-active')?.checked ?? false;
  const type = document.getElementById('resource-type-filter')?.value || 'all';
  const query = (document.getElementById('map-search')?.value || '').trim().toLowerCase();
  const resources = RESOURCE_POINTS.filter((r) => (!onlyActive || r.active) && (type === 'all' || r.type === type) && (!query || `${r.name} ${r.address}`.toLowerCase().includes(query)));
  document.getElementById('resources-list').innerHTML = resources.map((r) => `<li><strong>${r.name}</strong> · ${r.address} · ${r.active ? 'activée' : 'en attente'}</li>`).join('') || '<li>Aucune ressource avec ces filtres.</li>';
  if (!resourceLayer) return;
  resourceLayer.clearLayers();
  resources.forEach((r) => {
    window.L.circleMarker([r.lat, r.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: r.active ? '#2f9e44' : '#f59f00', fillOpacity: 0.95 })
      .bindPopup(`<strong>${r.name}</strong><br>Type: ${r.type.replace('_', ' ')}<br>Adresse: ${r.address}<br>Activation: ${r.active ? 'oui' : 'non'}`)
      .addTo(resourceLayer);
  });
}

async function handleMapSearch() {
  const query = (document.getElementById('map-search')?.value || '').trim();
  renderResources();
  if (!query || !leafletMap) return;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Isère, France')}`);
    const payload = await response.json();
    if (!payload?.length) return;
    const lat = Number(payload[0].lat);
    const lon = Number(payload[0].lon);
    searchLayer.clearLayers();
    window.L.marker([lat, lon]).bindPopup(`Résultat: ${payload[0].display_name}`).addTo(searchLayer).openPopup();
    leafletMap.setView([lat, lon], 12);
  } catch {
    // ignore erreur de recherche externe
  }
}

function renderItinisereEvents(events = [], targetId = 'itinerary-list') {
  document.getElementById(targetId).innerHTML = events.slice(0, 8).map((e) => `<li><strong>${e.title}</strong><br>${e.description || ''}<br><a href="${e.link}" target="_blank" rel="noreferrer">Détail</a></li>`).join('') || '<li>Aucune perturbation publiée.</li>';
}

async function loadDashboard() {
  const dashboard = await api('/dashboard');
  document.getElementById('vigilance').textContent = normalizeLevel(dashboard.vigilance);
  document.getElementById('crues').textContent = normalizeLevel(dashboard.crues);
  document.getElementById('risk').textContent = normalizeLevel(dashboard.global_risk);
  document.getElementById('risk').className = normalizeLevel(dashboard.global_risk);
  document.getElementById('crisis').textContent = String(dashboard.communes_crise || 0);
  document.getElementById('latest-logs').innerHTML = (dashboard.latest_logs || []).map((l) => `<li><strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun événement récent.</li>';
}

async function loadExternalRisks() {
  const data = await api('/external/isere/risks');
  document.getElementById('meteo-status').textContent = `${data.meteo_france.status} · niveau ${normalizeLevel(data.meteo_france.level)}`;
  document.getElementById('meteo-info').textContent = data.meteo_france.info_state || data.meteo_france.bulletin_title || '';
  document.getElementById('river-status').textContent = `${data.vigicrues.status} · niveau ${normalizeLevel(data.vigicrues.water_alert_level)}`;
  document.getElementById('stations-list').innerHTML = (data.vigicrues.stations || []).slice(0, 10).map((s) => `<li>${s.station || s.code} · ${s.river || ''} · ${normalizeLevel(s.level)} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible.</li>';
  document.getElementById('itinisere-status').textContent = `${data.itinisere.status} · ${data.itinisere.events.length} événements`;
  renderItinisereEvents(data.itinisere?.events || []);
  document.getElementById('meteo-level').textContent = normalizeLevel(data.meteo_france.level || 'vert');
  document.getElementById('meteo-hazards').textContent = (data.meteo_france.hazards || []).join(', ') || 'non précisé';
  document.getElementById('river-level').textContent = normalizeLevel(data.vigicrues.water_alert_level || 'vert');
  renderStations(data.vigicrues.stations || []);
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
  document.getElementById('municipalities-list').innerHTML = municipalities.map((m) => `<li><strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.phone} · ${m.crisis_mode ? 'CRISE' : 'veille'} </li>`).join('') || '<li>Aucune commune.</li>';
  await renderMunicipalitiesOnMap(municipalities);
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
    renderResources();
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
  document.getElementById('map-search-btn')?.addEventListener('click', handleMapSearch);
  document.getElementById('map-search')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); handleMapSearch(); } });
  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'resource-type-filter'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      renderStations(cachedStations);
      await renderMunicipalitiesOnMap(cachedMunicipalities);
      renderResources();
    });
  });
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
    const response = await fetch('/public/live');
    const data = await parseJsonResponse(response, '/public/live');
    if (!response.ok) throw new Error(data?.detail || data?.message || `Erreur API (${response.status})`);
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
    body: JSON.stringify({
      name: form.get('name'),
      manager: form.get('manager'),
      phone: form.get('phone'),
      email: form.get('email'),
      postal_code: form.get('postal_code'),
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
