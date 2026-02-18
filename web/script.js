const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel', mapPointsCache: 'mapPointsCache', municipalitiesCache: 'municipalitiesCache', dashboardSnapshot: 'dashboardSnapshot', externalRisksSnapshot: 'externalRisksSnapshot', apiInterconnectionsSnapshot: 'apiInterconnectionsSnapshot' };
const AUTO_REFRESH_MS = 10000;
const HOME_LIVE_REFRESH_MS = 30000;
const API_CACHE_TTL_MS = 30000;
const API_PANEL_REFRESH_MS = 10000;
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'georisques-panel': 'Page Géorisques',
  'api-panel': 'Interconnexions API',
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
let apiPanelTimer = null;
const apiGetCache = new Map();
const apiInFlight = new Map();

let leafletMap = null;
let boundaryLayer = null;
let hydroLayer = null;
let hydroLineLayer = null;
let pcsBoundaryLayer = null;
let pcsLayer = null;
let resourceLayer = null;
let searchLayer = null;
let customPointsLayer = null;
let mapPointsLayer = null;
let itinisereLayer = null;
let bisonLayer = null;
let mapTileLayer = null;
let mapAddPointMode = false;
let mapPoints = [];
let pendingMapPointCoords = null;
let mapIconTouched = false;
let cachedStations = [];
let cachedMunicipalities = [];
let cachedMunicipalityRecords = [];
let cachedItinisereEvents = [];
let cachedBisonFute = {};
let geocodeCache = new Map();
let municipalityContourCache = new Map();
const municipalityDocumentsUiState = new Map();
let trafficGeocodeCache = new Map();
let mapStats = { stations: 0, pcs: 0, resources: 0, custom: 0, traffic: 0 };
let mapControlsCollapsed = false;
let cachedCrisisPoints = [];
let cachedLogs = [];

const ISERE_BOUNDARY_STYLE = { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 };
const TRAFFIC_COMMUNES = ['Grenoble', 'Voiron', 'Vienne', 'Bourgoin-Jallieu', 'Pont-de-Claix', 'Meylan', 'Échirolles', 'L\'Isle-d\'Abeau', 'Saint-Martin-d\'Hères', 'La Tour-du-Pin', 'Rives', 'Sassenage', 'Crolles', 'Tullins'];
const ITINISERE_ROAD_CORRIDORS = {
  A41: [[45.1885, 5.7245], [45.3656, 5.9494]],
  A48: [[45.1885, 5.7245], [45.3667, 5.5906]],
  A49: [[45.0541, 5.0536], [45.1885, 5.7245]],
  A43: [[45.5866, 5.2732], [45.529, 5.96]],
  A7: [[45.5265, 4.8746], [45.3647, 4.7896]],
  N85: [[45.1885, 5.7245], [44.9134, 5.7861]],
  N87: [[45.1487, 5.7169], [45.1885, 5.7245]],
  D1075: [[45.1885, 5.7245], [44.9134, 5.7861]],
  D1090: [[45.1885, 5.7245], [45.3608, 5.9234]],
};
const BISON_CORRIDORS = [
  { name: 'A43 · Axe Lyon ⇄ Chambéry', points: [[45.5866, 5.2732], [45.7257, 5.9191]] },
  { name: 'A48 · Axe Grenoble ⇄ Lyon', points: [[45.1885, 5.7245], [45.5866, 5.2732]] },
  { name: 'A41 · Axe Grenoble ⇄ Savoie', points: [[45.1885, 5.7245], [45.3656, 5.9494]] },
  { name: 'A49 · Axe Grenoble ⇄ Valence', points: [[45.1885, 5.7245], [45.0541, 5.0536]] },
  { name: 'N85 · Route Napoléon', points: [[45.1885, 5.7245], [44.9134, 5.7861]] },
];

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');

const normalizeLevel = (level) => ({ verte: 'vert', green: 'vert', yellow: 'jaune', red: 'rouge' }[(level || '').toLowerCase()] || (level || 'vert').toLowerCase());
const levelColor = (level) => ({ vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' }[normalizeLevel(level)] || '#2f9e44');
const LOG_LEVEL_EMOJI = { vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴' };
const LOG_STATUS_LABEL = { nouveau: 'Nouveau', en_cours: 'En cours', suivi: 'Suivi', clos: 'Clos' };

function formatLogLine(log = {}) {
  const statusKey = String(log.status || 'nouveau');
  const status = LOG_STATUS_LABEL[statusKey] || 'Nouveau';
  const municipality = log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : '';
  const place = log.location ? ` · 📍 ${escapeHtml(log.location)}` : '';
  const source = log.source ? ` · Source: ${escapeHtml(log.source)}` : '';
  const owner = log.assigned_to ? ` · 👤 ${escapeHtml(log.assigned_to)}` : '';
  const next = log.next_update_due ? ` · ⏱️ MAJ ${new Date(log.next_update_due).toLocaleString()}` : '';
  const actions = log.actions_taken ? `<div class="muted">Actions: ${escapeHtml(log.actions_taken)}</div>` : '';
  const statusActions = canEdit() ? `<div class="map-inline-actions"><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="en_cours">En cours</button><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="suivi">Suivi</button><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="clos">Clôturer</button><button type="button" class="ghost inline-action danger" data-log-delete="${log.id}">Supprimer</button></div>` : '';
  return `<li><strong>${new Date(log.event_time || log.created_at).toLocaleString()}</strong> · <span class="badge neutral">${formatLogScope(log)}${municipality}</span> ${log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢'} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="badge neutral">${status}</span>${place}${owner}${source}${next}<div>${escapeHtml(log.description || '')}</div>${actions}${statusActions}</li>`;
}

function formatLogScope(log = {}) {
  const scope = String(log.target_scope || 'departemental').toLowerCase();
  if (scope === 'pcs') return 'PCS';
  if (scope === 'commune') return `Commune${log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : ''}`;
  return 'Départemental';
}

function getMunicipalityName(municipalityId) {
  const id = String(municipalityId || '');
  if (!id) return 'Commune inconnue';
  const fromCache = cachedMunicipalityRecords.find((municipality) => String(municipality.id) === id)
    || cachedMunicipalities.find((municipality) => String(municipality.id) === id);
  if (fromCache?.name) return fromCache.name;
  try {
    const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
    const fromLocal = Array.isArray(local) ? local.find((municipality) => String(municipality.id) === id) : null;
    if (fromLocal?.name) return fromLocal.name;
  } catch (_) {
    // ignore cache parsing issues
  }
  return `#${id}`;
}

function populateLogMunicipalityOptions(municipalities = []) {
  let source = Array.isArray(municipalities) ? municipalities : [];
  if (!source.length && Array.isArray(cachedMunicipalityRecords) && cachedMunicipalityRecords.length) source = cachedMunicipalityRecords;
  if (!source.length && Array.isArray(cachedMunicipalities) && cachedMunicipalities.length) source = cachedMunicipalities;
  if (!source.length) {
    try {
      const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
      if (Array.isArray(local)) source = local;
    } catch (_) {
      source = [];
    }
  }

  const createOptions = (includeEmpty = true, allLabel = 'Toutes les communes') => {
    const base = includeEmpty ? `<option value="">Sélectionnez une commune</option>` : `<option value="all">${allLabel}</option>`;
    return base + source
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}${m.pcs_active ? ' · PCS actif' : ''}</option>`)
      .join('');
  };

  const formSelect = document.getElementById('log-municipality-id');
  if (formSelect) {
    const current = formSelect.value;
    formSelect.innerHTML = createOptions(true);
    if (current) formSelect.value = current;
  }

  const filterSelect = document.getElementById('logs-municipality-filter');
  if (filterSelect) {
    const currentFilter = filterSelect.value;
    filterSelect.innerHTML = createOptions(false, 'Toutes les communes');
    if (currentFilter) filterSelect.value = currentFilter;
  }
}

function syncLogScopeFields() {
  const scopeSelect = document.getElementById('log-target-scope');
  const municipalitySelect = document.getElementById('log-municipality-id');
  if (!scopeSelect || !municipalitySelect) return;
  const scope = String(scopeSelect.value || 'departemental');
  const requiresMunicipality = scope === 'commune' || scope === 'pcs';
  municipalitySelect.disabled = !requiresMunicipality;
  municipalitySelect.required = requiresMunicipality;
  if (!requiresMunicipality) municipalitySelect.value = '';
}

function syncLogOtherFields() {
  const categorySelect = document.getElementById('log-event-type');
  const categoryOther = document.getElementById('log-event-type-other');
  const sourceSelect = document.getElementById('log-source-select');
  const sourceOther = document.getElementById('log-source-other');

  if (categorySelect && categoryOther) {
    const isOther = String(categorySelect.value || '').toLowerCase() === 'autre';
    categoryOther.required = isOther;
    setVisibility(categoryOther, isOther);
    if (!isOther) categoryOther.value = '';
  }

  if (sourceSelect && sourceOther) {
    const isOther = String(sourceSelect.value || '').toLowerCase() === 'autre';
    sourceOther.required = isOther;
    setVisibility(sourceOther, isOther);
    if (!isOther) sourceOther.value = '';
  }
}

async function ensureLogMunicipalitiesLoaded() {
  const municipalitySelect = document.getElementById('log-municipality-id');
  if (!municipalitySelect) return;
  const loadedOptions = Array.from(municipalitySelect.options || []).filter((option) => option.value).length;
  if (loadedOptions > 0) return;
  try {
    await loadMunicipalities();
  } catch (_) {
    populateLogMunicipalityOptions();
  }
}

function setVisibility(node, visible) {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.hidden = !visible;
}

function canEdit() { return ['admin', 'ope'].includes(currentUser?.role); }
function canMunicipalityFiles() { return ['admin', 'ope', 'mairie'].includes(currentUser?.role); }
function canManageUsers() { return ['admin', 'ope'].includes(currentUser?.role); }
function roleLabel(role) { return { admin: 'Admin', ope: 'Opérateur', securite: 'Sécurité', visiteur: 'Visiteur', mairie: 'Mairie' }[role] || role; }
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showHome() { setVisibility(homeView, true); setVisibility(loginView, false); setVisibility(appView, false); }
function showLogin() { setVisibility(homeView, false); setVisibility(loginView, true); setVisibility(appView, false); setVisibility(passwordForm, false); setVisibility(loginForm, true); }
function showApp() { setVisibility(homeView, false); setVisibility(loginView, false); setVisibility(appView, true); }

function apiOrigins() {
  return Array.from(new Set([
    window.location.origin,
    'http://localhost:1182',
    'http://127.0.0.1:1182',
  ]));
}

function buildApiUrl(path, origin) {
  if (origin === window.location.origin) return path;
  return `${origin}${path}`;
}

function sanitizeErrorMessage(message) {
  const normalized = typeof message === 'string' ? message : String(message || '');
  if (!normalized) return 'Erreur inconnue';
  if (normalized.includes('Failed to fetch') || normalized.includes('NetworkError')) {
    return "Connexion API indisponible (Failed to fetch). Vérifiez le backend, le port 1182 et le proxy web.";
  }
  if (normalized.includes('<!doctype') || normalized.includes('<html')) {
    return "L'API renvoie une page HTML au lieu d'un JSON. Vérifiez que le backend tourne bien sur le même hôte (docker compose up -d).";
  }
  return normalized;
}

function normalizeApiErrorMessage(payload, status) {
  if (!payload) return `Erreur API (${status})`;
  const detail = payload.detail ?? payload.message;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const lines = detail.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const msg = String(item.msg || item.message || '').trim();
        const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
        if (msg && loc) return `${loc}: ${msg}`;
        if (msg) return msg;
      }
      return String(item || '').trim();
    }).filter(Boolean);
    if (lines.length) return lines.join(' · ');
  }
  if (detail && typeof detail === 'object') {
    const msg = String(detail.msg || detail.message || '').trim();
    if (msg) return msg;
    return JSON.stringify(detail);
  }
  return `Erreur API (${status})`;
}


function saveSnapshot(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch (_) {
    // ignore localStorage saturation
  }
}

function readSnapshot(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return raw.payload;
  } catch (_) {
    return null;
  }
}

function clonePayload(payload) {
  if (payload == null) return payload;
  return JSON.parse(JSON.stringify(payload));
}

function isCacheableRequest(path, fetchOptions = {}) {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  return !path.includes('/auth/login');
}

function clearApiCache() {
  apiGetCache.clear();
  apiInFlight.clear();
}

function getRequestCacheKey(path, fetchOptions = {}) {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  return `${method} ${path}`;
}

async function api(path, options = {}) {
  const { logoutOn401 = true, omitAuth = false, ...fetchOptions } = options;
  const cacheable = isCacheableRequest(path, fetchOptions);
  const cacheKey = getRequestCacheKey(path, fetchOptions);

  if (cacheable) {
    const cached = apiGetCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < API_CACHE_TTL_MS) {
      return clonePayload(cached.payload);
    }
    if (apiInFlight.has(cacheKey)) {
      return clonePayload(await apiInFlight.get(cacheKey));
    }
  }

  const headers = { ...(fetchOptions.headers || {}) };
  if (token && !omitAuth) headers.Authorization = `Bearer ${token}`;

  const requestPromise = (async () => {
    let lastError = null;
    for (const origin of apiOrigins()) {
      const url = buildApiUrl(path, origin);
      try {
        const response = await fetch(url, { ...fetchOptions, headers });
        const payload = await parseJsonResponse(response, path);
        if (!response.ok) {
          const message = normalizeApiErrorMessage(payload, response.status);
          if (response.status === 401 && logoutOn401) logout();
          throw new Error(message);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (!String(error.message || '').includes('Réponse non-JSON')) break;
      }
    }

    throw new Error(sanitizeErrorMessage(lastError?.message || 'API indisponible'));
  })();

  if (!cacheable) {
    const responsePayload = await requestPromise;
    clearApiCache();
    return responsePayload;
  }

  apiInFlight.set(cacheKey, requestPromise);
  try {
    const payload = await requestPromise;
    apiGetCache.set(cacheKey, { timestamp: Date.now(), payload: clonePayload(payload) });
    return clonePayload(payload);
  } finally {
    apiInFlight.delete(cacheKey);
  }
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

async function apiFile(path) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError = null;
  for (const origin of apiOrigins()) {
    const url = buildApiUrl(path, origin);
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        if (response.status === 401) logout();
        const detailText = await response.text();
        let detail = detailText;
        try {
          const payload = detailText ? JSON.parse(detailText) : null;
          detail = normalizeApiErrorMessage(payload, response.status);
        } catch (_) {
          detail = detailText || `Erreur API (${response.status})`;
        }
        throw new Error(detail);
      }
      return { blob: await response.blob(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(sanitizeErrorMessage(lastError?.message || 'API indisponible'));
}

function setActivePanel(panelId) {
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.target === panelId));
  document.querySelectorAll('.view').forEach((panel) => setVisibility(panel, panel.id === panelId));
  document.getElementById('panel-title').textContent = PANEL_TITLES[panelId] || 'Centre opérationnel';
  if (panelId === 'map-panel' && leafletMap) setTimeout(() => leafletMap.invalidateSize(), 100);
  if (panelId === 'logs-panel') ensureLogMunicipalitiesLoaded();
  if (panelId === 'api-panel' && token) {
    loadApiInterconnections(false).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }
}


function updateMapSummary() {
  setText('map-summary-stations', String(mapStats.stations));
  setText('map-summary-pcs', String(mapStats.pcs));
  setText('map-summary-resources', String(mapStats.resources));
  setText('map-summary-custom', String(mapStats.custom));
  setText('map-summary-traffic', String(mapStats.traffic));
}

function applyBasemap(style = 'osm') {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (mapTileLayer) leafletMap.removeLayer(mapTileLayer);
  const layers = {
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' },
    },
    topo: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 17, attribution: '&copy; OpenTopoMap contributors' },
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' },
    },
  };
  const selected = layers[style] || layers.osm;
  mapTileLayer = window.L.tileLayer(selected.url, selected.options).addTo(leafletMap);
}

function initMap() {
  if (leafletMap || typeof window.L === 'undefined') return;
  leafletMap = window.L.map('isere-map-leaflet', { zoomControl: true }).setView([45.2, 5.72], 9);
  applyBasemap(document.getElementById('map-basemap-select')?.value || 'osm');
  hydroLayer = window.L.layerGroup().addTo(leafletMap);
  hydroLineLayer = window.L.layerGroup().addTo(leafletMap);
  pcsBoundaryLayer = window.L.layerGroup().addTo(leafletMap);
  pcsLayer = window.L.layerGroup().addTo(leafletMap);
  resourceLayer = window.L.layerGroup().addTo(leafletMap);
  searchLayer = window.L.layerGroup().addTo(leafletMap);
  customPointsLayer = window.L.layerGroup().addTo(leafletMap);
  mapPointsLayer = window.L.layerGroup().addTo(leafletMap);
  itinisereLayer = window.L.layerGroup().addTo(leafletMap);
  bisonLayer = window.L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', onMapClickAddPoint);
}

function setMapFeedback(message = '', isError = false) {
  const target = document.getElementById('map-feedback');
  if (!target) return;
  target.textContent = message;
  target.className = isError ? 'error' : 'muted';
}


async function resetMapFilters() {
  const defaults = {
    'map-search': '',
    'map-point-category-filter': 'all',
    'resource-type-filter': 'all',
    'map-basemap-select': 'osm',
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.value = value;
  });
  const hydro = document.getElementById('filter-hydro');
  const pcs = document.getElementById('filter-pcs');
  const activeOnly = document.getElementById('filter-resources-active');
  const itinisere = document.getElementById('filter-itinisere');
  const bison = document.getElementById('filter-bison');
  if (hydro) hydro.checked = true;
  if (pcs) pcs.checked = true;
  if (activeOnly) activeOnly.checked = false;
  if (itinisere) itinisere.checked = true;
  if (bison) bison.checked = true;
  if (searchLayer) searchLayer.clearLayers();
  applyBasemap('osm');
  renderStations(cachedStations);
  renderCustomPoints();
  renderResources();
  await renderMunicipalitiesOnMap(cachedMunicipalities);
  await renderTrafficOnMap();
  renderMapChecks([]);
  setMapFeedback('Filtres carte réinitialisés.');
}

function focusOnCrisisAreas() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (!cachedCrisisPoints.length) {
    setMapFeedback('Aucune commune en crise actuellement, vue globale conservée.');
    fitMapToData();
    return;
  }
  const bounds = window.L.latLngBounds(cachedCrisisPoints.map((point) => [point.lat, point.lon]));
  if (bounds.isValid()) {
    leafletMap.fitBounds(bounds, { padding: [34, 34], maxZoom: 11 });
    setMapFeedback(`Focus crise: ${cachedCrisisPoints.length} commune(s) en mode crise.`);
    return;
  }
  setMapFeedback('Impossible de centrer la carte sur les communes en crise.', true);
}

function toggleMapContrast() {
  const panel = document.getElementById('map-panel');
  const button = document.getElementById('map-toggle-contrast');
  if (!panel || !button) return;
  const active = panel.classList.toggle('map-panel--high-contrast');
  button.textContent = `Contraste renforcé: ${active ? 'on' : 'off'}`;
  button.setAttribute('aria-pressed', String(active));
}

function fitMapToData(showFeedback = false) {
  if (!leafletMap) return;
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsBoundaryLayer, pcsLayer, resourceLayer, searchLayer, customPointsLayer, mapPointsLayer, itinisereLayer, bisonLayer].filter(Boolean);
  const bounds = window.L.latLngBounds([]);
  layers.forEach((layer) => {
    if (layer?.getBounds) {
      const layerBounds = layer.getBounds();
      if (layerBounds?.isValid && layerBounds.isValid()) bounds.extend(layerBounds);
    }
  });
  if (bounds.isValid()) {
    leafletMap.fitBounds(bounds, { padding: [24, 24] });
    if (showFeedback) setMapFeedback('Carte recentrée sur les données visibles.');
    return;
  }
  if (showFeedback) setMapFeedback('Aucune donnée cartographique à afficher.', true);
}

async function loadIsereBoundary() {
  initMap();
  const data = await api('/public/isere-map');
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: ISERE_BOUNDARY_STYLE }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
  setMapFeedback('Fond de carte et contour Isère chargés.');
}


function renderStations(stations = []) {
  cachedStations = stations;
  const visible = document.getElementById('filter-hydro')?.checked ?? true;
  setHtml('hydro-stations-list', stations.slice(0, 40).map((s) => `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(s.level)}">${normalizeLevel(s.level)}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`).join('') || '<li>Aucune station.</li>');
  if (!hydroLayer || !hydroLineLayer) return;
  hydroLayer.clearLayers();
  hydroLineLayer.clearLayers();
  if (!visible) {
    mapStats.stations = 0;
    updateMapSummary();
    return;
  }

  const stationsWithPoints = stations.filter((s) => s.lat != null && s.lon != null);
  mapStats.stations = stationsWithPoints.length;
  stationsWithPoints.forEach((s) => {
    window.L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: levelColor(s.level), fillOpacity: 0.95 })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Département: Isère (38)<br>Niveau: ${normalizeLevel(s.level)}<br>Contrôle station: ${escapeHtml(s.control_status || 'inconnu')}<br>Hauteur: ${s.height_m} m`)
      .addTo(hydroLayer);
  });

  const byRiver = new Map();
  stationsWithPoints.forEach((s) => {
    const key = s.river || s.station || 'Isère';
    if (!byRiver.has(key)) byRiver.set(key, []);
    byRiver.get(key).push(s);
  });
  byRiver.forEach((group) => {
    if (group.length < 2) return;
    const sorted = group.slice().sort((a, b) => String(a.station || '').localeCompare(String(b.station || '')));
    const maxLevel = sorted.some((s) => normalizeLevel(s.level) === 'rouge') ? 'rouge'
      : sorted.some((s) => normalizeLevel(s.level) === 'orange') ? 'orange'
      : sorted.some((s) => normalizeLevel(s.level) === 'jaune') ? 'jaune' : 'vert';
    window.L.polyline(sorted.map((s) => [s.lat, s.lon]), { color: levelColor(maxLevel), weight: 4, opacity: 0.75 })
      .bindPopup(`Cours d'eau: ${escapeHtml(sorted[0].river || sorted[0].station || 'Isère')} · Niveau max: ${maxLevel}`)
      .addTo(hydroLineLayer);
  });

  updateMapSummary();
  setMapFeedback(`${stations.length} station(s) Vigicrues Isère chargée(s).`);
}

async function geocodeMunicipality(municipality) {
  const key = `${municipality.name}|${municipality.postal_code || ''}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const queries = municipality.postal_code
      ? [
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=centre&limit=1`,
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=centre&limit=1`,
        ]
      : [`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=centre&limit=1`];

    for (const url of queries) {
      const response = await fetch(url);
      const payload = await parseJsonResponse(response, url);
      const center = payload?.[0]?.centre?.coordinates;
      if (!Array.isArray(center) || center.length !== 2) continue;
      const point = { lat: center[1], lon: center[0] };
      geocodeCache.set(key, point);
      return point;
    }

    geocodeCache.set(key, null);
    return null;
  } catch {
    return null;
  }
}

async function fetchMunicipalityContour(municipality) {
  const key = `${municipality.name}|${municipality.postal_code || ''}`;
  if (municipalityContourCache.has(key)) return municipalityContourCache.get(key);
  try {
    const queries = municipality.postal_code
      ? [
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=contour&format=geojson&geometry=contour&limit=1`,
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=contour&format=geojson&geometry=contour&limit=1`,
        ]
      : [`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=contour&format=geojson&geometry=contour&limit=1`];

    for (const url of queries) {
      const response = await fetch(url);
      const payload = await parseJsonResponse(response, url);
      const geometry = payload?.features?.[0]?.geometry;
      if (!geometry) continue;
      municipalityContourCache.set(key, geometry);
      return geometry;
    }
  } catch {
    // Ne bloque pas l'affichage des points PCS si le contour est indisponible.
  }

  municipalityContourCache.set(key, null);
  return null;
}

async function renderMunicipalitiesOnMap(municipalities = []) {
  cachedMunicipalities = municipalities;
  const pcs = municipalities.filter((m) => m.pcs_active);
  setHtml('pcs-list', pcs.slice(0, 15).map((m) => `<li><strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.crisis_mode ? '🔴 CRISE' : 'veille'}</li>`).join('') || '<li>Aucune commune PCS.</li>');
  if (!pcsLayer) return;
  pcsLayer.clearLayers();
  if (pcsBoundaryLayer) pcsBoundaryLayer.clearLayers();
  if (!(document.getElementById('filter-pcs')?.checked ?? true)) {
    mapStats.pcs = 0;
    updateMapSummary();
    return;
  }
  const points = await Promise.all(
    pcs.map(async (m) => ({
      municipality: m,
      point: await geocodeMunicipality(m),
      contour: await fetchMunicipalityContour(m),
    })),
  );
  let renderedCount = 0;
  cachedCrisisPoints = [];
  points.forEach(({ municipality, point, contour }) => {
    if (contour && pcsBoundaryLayer) {
      window.L.geoJSON({ type: 'Feature', geometry: contour }, {
        style: ISERE_BOUNDARY_STYLE,
      })
        .bindPopup(`<strong>${municipality.name}</strong><br>Contour communal PCS`)
        .addTo(pcsBoundaryLayer);
    }
    if (!point) return;
    const isInCrisis = Boolean(municipality.crisis_mode);
    window.L.circleMarker([point.lat, point.lon], {
      radius: isInCrisis ? 11 : 8,
      color: isInCrisis ? '#a51111' : '#fff',
      weight: isInCrisis ? 2.4 : 1.5,
      fillColor: isInCrisis ? '#e03131' : '#17335f',
      fillOpacity: 0.95,
    })
      .bindPopup(`<strong>${municipality.name}</strong><br>Code postal: ${municipality.postal_code || '-'}<br>Responsable: ${municipality.manager}<br>PCS: actif<br>Statut: ${isInCrisis ? 'CRISE' : 'veille'}`)
      .addTo(pcsLayer);

    if (isInCrisis) {
      cachedCrisisPoints.push({ lat: point.lat, lon: point.lon, name: municipality.name });
      window.L.circle([point.lat, point.lon], {
        radius: 1000,
        color: '#e03131',
        weight: 1.5,
        fillColor: '#e03131',
        fillOpacity: 0.08,
      }).addTo(pcsLayer);
    }
    renderedCount += 1;
  });
  mapStats.pcs = renderedCount;
  updateMapSummary();
  setMapFeedback(`${renderedCount}/${pcs.length} commune(s) PCS géolocalisée(s).`);
}

function renderResources() {
  const onlyActive = document.getElementById('filter-resources-active')?.checked ?? false;
  const type = document.getElementById('resource-type-filter')?.value || 'all';
  const query = (document.getElementById('map-search')?.value || '').trim().toLowerCase();
  const resources = RESOURCE_POINTS.filter((r) => (!onlyActive || r.active) && (type === 'all' || r.type === type) && (!query || `${r.name} ${r.address}`.toLowerCase().includes(query)));
  setHtml('resources-list', resources.map((r) => `<li><strong>${r.name}</strong> · ${r.address} · ${r.active ? 'activée' : 'en attente'}</li>`).join('') || '<li>Aucune ressource avec ces filtres.</li>');
  mapStats.resources = resources.length;
  updateMapSummary();
  if (!resourceLayer) return;
  resourceLayer.clearLayers();
  resources.forEach((r) => {
    window.L.circleMarker([r.lat, r.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: r.active ? '#2f9e44' : '#f59f00', fillOpacity: 0.95 })
      .bindPopup(`<strong>${r.name}</strong><br>Type: ${r.type.replace('_', ' ')}<br>Adresse: ${r.address}<br>Activation: ${r.active ? 'oui' : 'non'}`)
      .addTo(resourceLayer);
  });
  setMapFeedback(`${resources.length} ressource(s) affichée(s).`);
}

function tryLocalMapSearch(query = '') {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const municipality = cachedMunicipalities.find((item) => String(item.name || '').toLowerCase().includes(needle));
  if (municipality) {
    const cacheKey = `${municipality.name}|${municipality.postal_code || ''}`;
    const point = geocodeCache.get(cacheKey);
    if (point) return { ...point, label: `${municipality.name} (commune)` };
  }
  const resource = RESOURCE_POINTS.find((item) => `${item.name} ${item.address}`.toLowerCase().includes(needle));
  if (resource) return { lat: resource.lat, lon: resource.lon, label: `${resource.name} (${resource.address})` };
  const point = mapPoints.find((item) => String(item.name || '').toLowerCase().includes(needle));
  if (point) return { lat: point.lat, lon: point.lon, label: `${point.icon || '📍'} ${point.name} (point opérationnel)` };
  return null;
}

function placeSearchResult(lat, lon, label) {
  if (!leafletMap || !searchLayer) return;
  searchLayer.clearLayers();
  window.L.marker([lat, lon]).bindPopup(`Résultat: ${escapeHtml(label)}`).addTo(searchLayer).openPopup();
  leafletMap.setView([lat, lon], 12);
}

async function handleMapSearch() {
  const query = (document.getElementById('map-search')?.value || '').trim();
  renderResources();
  if (!query || !leafletMap) {
    setMapFeedback('Saisissez un lieu ou une commune pour lancer la recherche.');
    return;
  }
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Isère, France')}`);
    const payload = await parseJsonResponse(response, 'nominatim');
    if (!payload?.length) {
      const localResult = tryLocalMapSearch(query);
      if (!localResult) {
        setMapFeedback('Aucun résultat de recherche trouvé.');
        return;
      }
      placeSearchResult(localResult.lat, localResult.lon, localResult.label);
      setMapFeedback(`Résultat local: ${localResult.label}`);
      return;
    }
    const lat = Number(payload[0].lat);
    const lon = Number(payload[0].lon);
    placeSearchResult(lat, lon, payload[0].display_name);
    setMapFeedback(`Recherche OK: ${payload[0].display_name}`);
  } catch {
    const localResult = tryLocalMapSearch(query);
    if (!localResult) {
      setMapFeedback('Service de recherche temporairement indisponible.', true);
      return;
    }
    placeSearchResult(localResult.lat, localResult.lon, localResult.label);
    setMapFeedback(`Service externe indisponible, résultat local: ${localResult.label}`);
  }
}




function setRiskText(id, value, level = null) {
  const node = document.getElementById(id);
  if (!node) return;
  const normalized = normalizeLevel(level || value);
  node.textContent = value;
  node.style.color = levelColor(normalized);
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setHtml(id, value) {
  const node = document.getElementById(id);
  if (node) node.innerHTML = value;
}

function formatApiJson(payload) {
  return escapeHtml(JSON.stringify(payload, null, 2));
}

function serviceErrorLabel(service) {
  return service?.error || (service?.status && service.status !== 'online' ? 'Service indisponible ou dégradé.' : 'Aucune erreur détectée.');
}

const MAP_POINT_ICONS = {
  incident: '🚨',
  evacuation: '🏃',
  water: '💧',
  roadblock: '🚧',
  medical: '🏥',
  logistics: '📦',
  command: '🛰️',
  autre: '📍',
};

const MAP_ICON_SUGGESTIONS = {
  incident: ['🚨', '🔥', '⚠️'],
  evacuation: ['🏃', '🏘️', '🚌'],
  water: ['💧', '🌊', '🛶'],
  roadblock: ['🚧', '⛔', '🚦'],
  medical: ['🏥', '🚑', '🩺'],
  logistics: ['📦', '🚛', '🛠️'],
  command: ['🛰️', '📡', '🧭'],
  autre: ['📍', '📌', '⭐'],
};

function iconForCategory(category) {
  return MAP_POINT_ICONS[category] || '📍';
}

function emojiDivIcon(emoji) {
  return window.L.divIcon({ className: 'map-emoji-icon', html: `<span>${escapeHtml(emoji)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15] });
}

function trafficLevelColor(level) {
  const normalized = normalizeLevel(level);
  if (normalized === 'noir') return '#121212';
  return levelColor(level);
}

function trafficLevelEmoji(level) {
  return ({ vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴', noir: '⚫' })[normalizeLevel(level)] || '⚪';
}

function detectItinisereIcon(text = '') {
  const lowered = text.toLowerCase();
  if (/accident|collision|carambolage/.test(lowered)) return '💥';
  if (/fermet|coup|interdit|barr/.test(lowered)) return '⛔';
  if (/travaux|chantier/.test(lowered)) return '🚧';
  if (/bouchon|ralenti|embouteillage/.test(lowered)) return '🐢';
  if (/manifestation|cortège|événement/.test(lowered)) return '🚶';
  if (/transport|bus|tram/.test(lowered)) return '🚌';
  return '⚠️';
}

function detectRoadCodes(text = '') {
  const roads = new Set();
  const matches = String(text).toUpperCase().match(/\b(?:A|N|D)\s?\d{1,4}\b/g) || [];
  matches.forEach((road) => roads.add(road.replace(/\s+/g, '')));
  return Array.from(roads);
}

async function geocodeTrafficLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(label)}&fields=centre&limit=1`;
    const communeResponse = await fetch(communeUrl);
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const center = communePayload?.[0]?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = { lat: Number(center[1]), lon: Number(center[0]) };
      trafficGeocodeCache.set(key, point);
      return point;
    }
  } catch {
    // fallback nominatim
  }

  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(`${label}, Isère, France`)}`;
    const response = await fetch(nominatimUrl, { headers: { Accept: 'application/json' } });
    const payload = await parseJsonResponse(response, nominatimUrl);
    const first = payload?.[0];
    const point = first ? { lat: Number(first.lat), lon: Number(first.lon) } : null;
    trafficGeocodeCache.set(key, point);
    return point;
  } catch {
    trafficGeocodeCache.set(key, null);
    return null;
  }
}

async function buildItinisereMapPoints(events = []) {
  const points = [];
  for (const event of events.slice(0, 20)) {
    const fullText = `${event.title || ''} ${event.description || ''}`;
    const roads = detectRoadCodes(fullText);
    let position = null;
    let anchor = '';

    for (const road of roads) {
      const corridor = ITINISERE_ROAD_CORRIDORS[road];
      if (!corridor) continue;
      position = { lat: corridor[0][0], lon: corridor[0][1] };
      anchor = `Axe ${road}`;
      break;
    }

    if (!position) {
      for (const commune of TRAFFIC_COMMUNES) {
        const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`, 'i').test(fullText)) continue;
        position = await geocodeTrafficLabel(commune);
        anchor = commune;
        if (position) break;
      }
    }

    if (!position) {
      position = await geocodeTrafficLabel((event.title || '').slice(0, 70));
      anchor = 'Localisation estimée';
    }
    if (!position) continue;

    points.push({
      ...event,
      lat: position.lat,
      lon: position.lon,
      icon: detectItinisereIcon(fullText),
      roads,
      anchor,
    });
  }
  return points;
}

async function renderTrafficOnMap() {
  if (!itinisereLayer || !bisonLayer || typeof window.L === 'undefined') return;
  itinisereLayer.clearLayers();
  bisonLayer.clearLayers();
  mapStats.traffic = 0;

  const showItinisere = document.getElementById('filter-itinisere')?.checked ?? true;
  const showBison = document.getElementById('filter-bison')?.checked ?? true;

  if (showItinisere) {
    const points = await buildItinisereMapPoints(cachedItinisereEvents || []);
    mapStats.traffic += points.length;
    points.forEach((point) => {
      const roadsText = point.roads?.length ? `Axes détectés: ${point.roads.join(', ')}<br/>` : '';
      window.L.marker([point.lat, point.lon], { icon: emojiDivIcon(point.icon || '⚠️') })
        .bindPopup(`<strong>${escapeHtml(point.icon || '⚠️')} ${escapeHtml(point.title || 'Perturbation Itinisère')}</strong><br/>${escapeHtml(point.description || '')}<br/>Repère: ${escapeHtml(point.anchor || 'Isère')}<br/>${roadsText}<a href="${escapeHtml(point.link || '#')}" target="_blank" rel="noreferrer">Détail Itinisère</a>`)
        .addTo(itinisereLayer);
    });
  }

  if (showBison) {
    const departureLevel = cachedBisonFute?.today?.isere?.departure || 'vert';
    const returnLevel = cachedBisonFute?.today?.isere?.return || 'vert';
    BISON_CORRIDORS.forEach((corridor) => {
      window.L.polyline(corridor.points, { color: trafficLevelColor(departureLevel), weight: 6, opacity: 0.6 })
        .bindPopup(`<strong>${escapeHtml(corridor.name)}</strong><br/>Départs: ${trafficLevelEmoji(departureLevel)} ${escapeHtml(departureLevel)}<br/>Retours: ${trafficLevelEmoji(returnLevel)} ${escapeHtml(returnLevel)}<br/><a href="https://www.bison-fute.gouv.fr" target="_blank" rel="noreferrer">Carte Bison Futé</a>`)
        .addTo(bisonLayer);
      const mid = corridor.points[Math.floor(corridor.points.length / 2)];
      window.L.marker(mid, { icon: emojiDivIcon(trafficLevelEmoji(departureLevel)) })
        .bindPopup(`<strong>${escapeHtml(corridor.name)}</strong><br/>Tendance Isère (départs): ${escapeHtml(departureLevel)}`)
        .addTo(bisonLayer);
    });
    mapStats.traffic += BISON_CORRIDORS.length;
  }

  updateMapSummary();
}

function renderMapIconSuggestions(category = 'autre') {
  const container = document.getElementById('map-icon-suggestions');
  if (!container) return;
  const icons = MAP_ICON_SUGGESTIONS[category] || MAP_ICON_SUGGESTIONS.autre;
  container.innerHTML = `${icons
    .map((icon) => `<button type="button" class="ghost inline-action map-icon-chip" data-map-icon="${escapeHtml(icon)}">${escapeHtml(icon)}</button>`)
    .join('')}<span class="muted">ou saisissez votre emoji.</span>`;
}

async function loadMapPoints() {
  let loadedPoints = [];
  let usedCacheFallback = false;

  try {
    const response = await api('/map/points');
    loadedPoints = Array.isArray(response) ? response : [];
    localStorage.setItem(STORAGE_KEYS.mapPointsCache, JSON.stringify(loadedPoints));
  } catch (error) {
    usedCacheFallback = true;
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.mapPointsCache) || '[]');
      loadedPoints = Array.isArray(cached) ? cached : [];
    } catch (_) {
      loadedPoints = [];
    }
    setMapFeedback(`Points personnalisés indisponibles (API): ${sanitizeErrorMessage(error.message)}. Affichage du cache local (${loadedPoints.length}).`, true);
  }

  mapPoints = loadedPoints;
  renderCustomPoints(!usedCacheFallback);
  return { usedCacheFallback, count: loadedPoints.length };
}


async function saveMapPoint(payload) {
  await api('/map/points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadMapPoints();
}

async function deleteMapPoint(pointId) {
  await api(`/map/points/${pointId}`, { method: 'DELETE' });
  await loadMapPoints();
}

function renderCustomPoints(showFeedback = true) {
  if (customPointsLayer) customPointsLayer.clearLayers();
  if (mapPointsLayer) mapPointsLayer.clearLayers();

  const selectedCategory = document.getElementById('map-point-category-filter')?.value || 'all';
  const filteredPoints = mapPoints.filter((point) => selectedCategory === 'all' || point.category === selectedCategory);
  const listMarkup = filteredPoints
    .map((point) => `<li><strong>${escapeHtml(point.icon || iconForCategory(point.category))} ${escapeHtml(point.name)}</strong> · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} <button type="button" data-remove-point="${point.id}">Supprimer</button></li>`)
    .join('') || '<li>Aucun point personnalisé.</li>';
  setHtml('custom-points-list', listMarkup);

  mapStats.custom = filteredPoints.length;
  updateMapSummary();
  if (!mapPointsLayer) return;
  filteredPoints.forEach((point) => {
    const marker = window.L.marker([point.lat, point.lon], { icon: emojiDivIcon(point.icon || iconForCategory(point.category)) });
    marker.bindPopup(`<strong>${escapeHtml(point.icon || iconForCategory(point.category))} ${escapeHtml(point.name)}</strong><br/>Catégorie: ${escapeHtml(point.category)}<br/>${escapeHtml(point.notes || 'Sans note')}`);
    marker.addTo(mapPointsLayer);
  });
  if (showFeedback) setMapFeedback(`${filteredPoints.length} point(s) opérationnel(s) affiché(s).`);
}

function onMapClickAddPoint(event) {
  if (!mapAddPointMode) return;
  pendingMapPointCoords = event.latlng;
  const modal = document.getElementById('map-point-modal');
  if (!modal) return;
  const form = document.getElementById('map-point-form');
  if (form) {
    form.reset();
    form.elements.namedItem('name').value = `Point ${new Date().toLocaleTimeString()}`;
    form.elements.namedItem('icon').value = iconForCategory('autre');
    mapIconTouched = false;
    renderMapIconSuggestions('autre');
  }
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', 'open');
}
function renderMeteoAlerts(meteo = {}) {
  const current = meteo.current_alerts || [];
  const tomorrow = meteo.tomorrow_alerts || [];
  const section = (title, alerts) => `<li><strong>${title}</strong><ul>${alerts.map((alert) => `<li><strong>${alert.phenomenon}</strong> · <span style="color:${levelColor(alert.level)}">${normalizeLevel(alert.level)}</span>${(alert.details || []).length ? `<br>${alert.details[0]}` : ''}</li>`).join('') || '<li>Aucune alerte significative.</li>'}</ul></li>`;
  setHtml('meteo-alerts-list', `${section('En cours (J0)', current)}${section('Demain (J1)', tomorrow)}`);
}

function renderItinisereEvents(events = [], targetId = 'itinerary-list') {
  cachedItinisereEvents = Array.isArray(events) ? events : [];
  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = events.slice(0, 8).map((e) => {
    const title = escapeHtml(e.title || 'Évènement');
    const description = escapeHtml(e.description || '');
    const safeLink = String(e.link || '').startsWith('http') ? e.link : '#';
    const mapQuery = escapeHtml(e.title || '').replace(/"/g, '&quot;');
    const category = escapeHtml(e.category || 'trafic');
    const roads = Array.isArray(e.roads) && e.roads.length ? ` · Axes: ${escapeHtml(e.roads.join(', '))}` : '';
    return `<li><strong>${title}</strong> <span class="badge neutral">${category}</span>${roads}<br>${description}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Détail</a><br><button type="button" class="ghost inline-action" data-map-query="${mapQuery}">Voir sur la carte</button></li>`;
  }).join('') || '<li>Aucune perturbation publiée.</li>';
}

function renderBisonFuteSummary(bison = {}) {
  cachedBisonFute = bison || {};
  const today = bison.today || {};
  const tomorrow = bison.tomorrow || {};
  const isereToday = today.isere || {};
  const isereTomorrow = tomorrow.isere || {};
  const nationalToday = today.national || {};
  const nationalTomorrow = tomorrow.national || {};

  setText('bison-status', `${bison.status || 'inconnu'} · Isère départ ${isereToday.departure || 'inconnu'} / retour ${isereToday.return || 'inconnu'}`);
  setText('bison-info', `National J0: ${nationalToday.departure || 'inconnu'} / ${nationalToday.return || 'inconnu'} · J1: ${nationalTomorrow.departure || 'inconnu'} / ${nationalTomorrow.return || 'inconnu'}`);
  setText('map-bison-isere', `${isereToday.departure || 'inconnu'} (retour ${isereToday.return || 'inconnu'})`);
  setText('home-feature-bison-isere', `${isereToday.departure || 'inconnu'} / ${isereToday.return || 'inconnu'}`);

  const bisonMarkup = [
    `<li><strong>Aujourd'hui (${today.date || '-'})</strong><br>Isère départ: ${isereToday.departure || 'inconnu'} · Isère retour: ${isereToday.return || 'inconnu'}<br>National départ: ${nationalToday.departure || 'inconnu'} · National retour: ${nationalToday.return || 'inconnu'}<br><a href="https://www.bison-fute.gouv.fr" target="_blank" rel="noreferrer">Voir la carte Bison Futé</a></li>`,
    `<li><strong>Demain (${tomorrow.date || '-'})</strong><br>Isère départ: ${isereTomorrow.departure || 'inconnu'} · Isère retour: ${isereTomorrow.return || 'inconnu'}<br>National départ: ${nationalTomorrow.departure || 'inconnu'} · National retour: ${nationalTomorrow.return || 'inconnu'}</li>`,
  ].join('');
  setHtml('bison-list', bisonMarkup);
}

function renderHomeMeteoSituation(situations = []) {
  const markup = situations.map((item) => `<li>${item.label}: <strong>${normalizeLevel(item.level)}</strong></li>`).join('') || '<li>Aucune vigilance significative en cours.</li>';
  setHtml('home-meteo-situation', markup);
}

function renderGeorisquesDetails(georisques = {}) {
  const monitored = georisques.monitored_communes || georisques.monitored_municipalities || georisques.communes || [];
  const errorDetails = Array.isArray(georisques.errors) ? georisques.errors.filter(Boolean) : [];
  const movementTypes = georisques.movement_types && typeof georisques.movement_types === 'object' ? georisques.movement_types : {};
  const recentMovements = Array.isArray(georisques.recent_ground_movements) ? georisques.recent_ground_movements : [];

  setText('georisques-page-status', georisques.status || 'inconnu');
  setText('georisques-page-seismic', georisques.highest_seismic_zone_label || 'inconnue');
  setText('georisques-page-flood-docs', String(georisques.flood_documents_total ?? 0));
  setText('georisques-page-ppr-total', String(georisques.ppr_total ?? 0));
  setText('georisques-page-ground-movements', String(georisques.ground_movements_total ?? 0));
  setText('georisques-page-radon-alert', String(georisques.communes_with_radon_moderate_or_high ?? 0));

  const sourceText = `Source: ${georisques.source || 'inconnue'} · Dernière mise à jour: ${georisques.updated_at ? new Date(georisques.updated_at).toLocaleString() : 'inconnue'}`;
  const errorsText = errorDetails.length ? ` · Anomalies: ${errorDetails.join(' | ')}` : '';
  setText('georisques-page-source', `${sourceText}${errorsText}`);
  setText('georisques-page-debug', monitored.length ? '' : `Aucune commune détaillée reçue (clés: ${Object.keys(georisques || {}).join(', ') || 'aucune'}).`);

  const movementTypesMarkup = Object.entries(movementTypes)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([type, count]) => `<li><strong>${escapeHtml(type)}</strong> · ${Number(count || 0)} signalement(s)</li>`)
    .join('') || '<li>Aucune répartition disponible.</li>';
  setHtml('georisques-movement-types-list', movementTypesMarkup);

  const recentMovementsMarkup = recentMovements.map((event) => {
    const dateText = event.date ? new Date(event.date).toLocaleDateString() : 'Date inconnue';
    const reliability = event.reliability ? ` · Fiabilité: ${escapeHtml(String(event.reliability))}` : '';
    const identifier = event.identifier ? ` · ID: ${escapeHtml(String(event.identifier))}` : '';
    const location = event.location ? `<br>Lieu: ${escapeHtml(String(event.location))}` : '';
    return `<li><strong>${escapeHtml(event.commune || 'Commune inconnue')}</strong> · ${escapeHtml(event.type || 'Mouvement de terrain')} · ${dateText}${reliability}${identifier}${location}</li>`;
  }).join('') || '<li>Aucun mouvement de terrain récent exploitable.</li>';
  setHtml('georisques-recent-movements-list', recentMovementsMarkup);

  const markup = monitored.map((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const pprByRisk = commune.ppr_by_risk && typeof commune.ppr_by_risk === 'object' ? commune.ppr_by_risk : {};
    const pprText = Object.entries(pprByRisk).map(([risk, count]) => `${escapeHtml(risk)} (${Number(count || 0)})`).join(', ') || 'Aucun PPR détaillé';
    const communeErrors = Array.isArray(commune.errors) ? commune.errors.filter(Boolean) : [];

    const docsMarkup = docs.length
      ? `<ul class="list compact">${docs.slice(0, 6).map((doc) => `<li><strong>${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}</strong>${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}</li>`).join('')}</ul>`
      : '<span class="muted">Aucun détail de document remonté.</span>';

    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> (${escapeHtml(commune.code_insee || commune.insee || '-')})<br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Radon: <strong>${escapeHtml(commune.radon_label || 'inconnu')}</strong><br>Inondation (AZI): <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · PPR: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong> · Cavités: <strong>${Number(commune.cavities_total || 0)}</strong><br>PPR par risque: ${pprText}${communeErrors.length ? `<br><span class="muted">Anomalies commune: ${escapeHtml(communeErrors.join(' | '))}</span>` : ''}<br>${docsMarkup}</li>`;
  }).join('') || '<li>Aucune commune remontée par Géorisques.</li>';
  setHtml('georisques-communes-list', markup);

  const allDocs = monitored.flatMap((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const communeName = commune.name || commune.commune || 'Commune inconnue';
    return docs.map((doc) => ({ communeName, doc }));
  });

  const docsListMarkup = allDocs.map(({ communeName, doc }) => (`
    <li><strong>${escapeHtml(communeName)}</strong> · ${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}</li>
  `)).join('') || '<li>Aucun document Géorisques associé affichable.</li>';
  setHtml('georisques-documents-list', docsListMarkup);
}


function openMunicipalityEditor(municipality) {
  const panel = document.getElementById('municipality-editor');
  const form = document.getElementById('municipality-edit-form');
  if (!panel || !form || !municipality) return;
  form.elements.id.value = municipality.id;
  form.elements.manager.value = municipality.manager || '';
  form.elements.phone.value = municipality.phone || '';
  form.elements.email.value = municipality.email || '';
  form.elements.postal_code.value = municipality.postal_code || '';
  form.elements.contacts.value = municipality.contacts || '';
  form.elements.additional_info.value = municipality.additional_info || '';
  form.elements.population.value = municipality.population ?? '';
  form.elements.shelter_capacity.value = municipality.shelter_capacity ?? '';
  form.elements.radio_channel.value = municipality.radio_channel || '';
  form.elements.vigilance_color.value = normalizeLevel(municipality.vigilance_color || 'vert');
  form.elements.pcs_active.checked = Boolean(municipality.pcs_active);
  setText('municipality-editor-title', `Éditer ${municipality.name}`);
  setVisibility(panel, true);
}

function closeMunicipalityEditor() {
  const panel = document.getElementById('municipality-editor');
  if (!panel) return;
  setVisibility(panel, false);
}

async function loadMunicipalityFiles(municipalityId) {
  const files = await api(`/municipalities/${municipalityId}/files`);
  return Array.isArray(files) ? files : [];
}

function municipalityFilesMarkup(files = [], municipalityId) {
  const canManage = canMunicipalityFiles();
  const list = files.map((file) => `<li><strong>${escapeHtml(file.title)}</strong> · <span class="badge neutral">${escapeHtml(file.doc_type)}</span> · ${new Date(file.created_at).toLocaleDateString()} · par ${escapeHtml(file.uploaded_by)} <button type="button" class="ghost inline-action" data-muni-file-open="${file.id}" data-muni-id="${municipalityId}">Consulter</button> ${canManage ? `<button type="button" class="ghost inline-action danger" data-muni-file-delete="${file.id}" data-muni-id="${municipalityId}">Supprimer</button>` : ''}</li>`).join('');
  return list || '<li>Aucun fichier opérationnel.</li>';
}

function municipalityDocumentFiltersMarkup(state, municipalityId) {
  return `<div class="municipality-doc-toolbar">
    <input type="search" placeholder="Rechercher un document" value="${escapeHtml(state.search || '')}" data-muni-doc-search="${municipalityId}" />
    <select data-muni-doc-type-filter="${municipalityId}">
      <option value="all">Tous les types</option>
      <option value="pcs" ${state.type === 'pcs' ? 'selected' : ''}>PCS</option>
      <option value="orsec" ${state.type === 'orsec' ? 'selected' : ''}>ORSEC</option>
      <option value="convention" ${state.type === 'convention' ? 'selected' : ''}>Convention</option>
      <option value="cartographie" ${state.type === 'cartographie' ? 'selected' : ''}>Cartographie</option>
      <option value="annexe" ${state.type === 'annexe' ? 'selected' : ''}>Annexe</option>
      <option value="document" ${state.type === 'document' ? 'selected' : ''}>Document</option>
    </select>
    <select data-muni-doc-sort="${municipalityId}">
      <option value="date_desc" ${state.sort === 'date_desc' ? 'selected' : ''}>Plus récent</option>
      <option value="date_asc" ${state.sort === 'date_asc' ? 'selected' : ''}>Plus ancien</option>
      <option value="title" ${state.sort === 'title' ? 'selected' : ''}>Titre A → Z</option>
    </select>
  </div>`;
}

function uploadMunicipalityDocument(origin, municipalityId, formData, onProgress) {
  const url = buildApiUrl(`/municipalities/${municipalityId}/files`, origin);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Failed to fetch'));
    xhr.onload = () => {
      if (xhr.status === 401) {
        logout();
        reject(new Error('Session expirée'));
        return;
      }
      let payload = null;
      if (xhr.responseText) {
        try { payload = JSON.parse(xhr.responseText); } catch { payload = null; }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload?.detail || payload?.message || `Erreur API (${xhr.status})`));
    };
    xhr.send(formData);
  });
}

async function uploadMunicipalityDocumentWithFallback(municipalityId, formData, onProgress) {
  let lastError = null;
  for (const origin of apiOrigins()) {
    try {
      return await uploadMunicipalityDocument(origin, municipalityId, formData, onProgress);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(sanitizeErrorMessage(lastError?.message || 'Téléversement impossible'));
}

async function openMunicipalityFile(municipalityId, fileId) {
  const { blob, contentType } = await apiFile(`/municipalities/${municipalityId}/files/${fileId}`);
  const objectUrl = URL.createObjectURL(blob);
  const previewHost = document.getElementById('municipality-document-preview');

  if (currentMunicipalityPreviewUrl) {
    URL.revokeObjectURL(currentMunicipalityPreviewUrl);
    currentMunicipalityPreviewUrl = null;
  }

  if (previewHost) {
    currentMunicipalityPreviewUrl = objectUrl;
    previewHost.innerHTML = municipalityPreviewMarkup(contentType || '', objectUrl);
    previewHost.classList.remove('hidden');
    previewHost.hidden = false;
    previewHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  currentMunicipalityPreviewUrl = objectUrl;
}

function closeMunicipalityDetailsModal() {
  const modal = document.getElementById('municipality-details-modal');
  if (currentMunicipalityPreviewUrl) {
    URL.revokeObjectURL(currentMunicipalityPreviewUrl);
    currentMunicipalityPreviewUrl = null;
  }
  if (!modal) return;
  try {
    if (typeof modal.close === 'function' && modal.open) modal.close();
  } catch (_) {
    // ignore close errors and fallback to attribute cleanup
  }

  modal.open = false;
  modal.removeAttribute('open');
}

function openMunicipalityDetailsInlineFallback(municipality) {
  return openMunicipalityDetailsModal(municipality);
}

if (typeof window !== 'undefined') {
  window.openMunicipalityDetailsInlineFallback = openMunicipalityDetailsInlineFallback;
  window.closeMunicipalityDetailsModal = closeMunicipalityDetailsModal;
}

async function openMunicipalityDetailsModal(municipality) {
  const modal = document.getElementById('municipality-details-modal');
  const content = document.getElementById('municipality-details-content');
  if (!modal || !content || !municipality) return;

  const [files, logs] = await Promise.all([
    loadMunicipalityFiles(municipality.id).catch(() => []),
    api('/logs').catch(() => []),
  ]);
  const municipalityLogs = (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log.municipality_id || '') === String(municipality.id))
    .slice(0, 8);
  const previousState = municipalityDocumentsUiState.get(String(municipality.id)) || { search: '', type: 'all', sort: 'date_desc', uploading: false, progress: 0 };
  const state = { ...previousState, uploading: false, progress: 0 };
  municipalityDocumentsUiState.set(String(municipality.id), state);
  const filteredFiles = files
    .filter((file) => {
      const search = (state.search || '').trim().toLowerCase();
      if (state.type !== 'all' && file.doc_type !== state.type) return false;
      if (!search) return true;
      return [file.title, file.doc_type, file.uploaded_by].some((value) => String(value || '').toLowerCase().includes(search));
    })
    .sort((left, right) => {
      if (state.sort === 'title') return String(left.title || '').localeCompare(String(right.title || ''), 'fr');
      const leftDate = new Date(left.created_at).getTime();
      const rightDate = new Date(right.created_at).getTime();
      if (state.sort === 'date_asc') return leftDate - rightDate;
      return rightDate - leftDate;
    });
  const byType = files.reduce((acc, file) => {
    const key = file.doc_type || 'document';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const quickActions = canMunicipalityFiles()
    ? `<div class="municipality-actions municipality-actions--modal">
         ${canEdit() ? `<button type="button" class="ghost inline-action" data-muni-detail-crisis="${municipality.id}">${municipality.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
         ` : ''}
         <form class="municipality-upload-form" data-muni-upload-form="${municipality.id}">
           <input name="title" placeholder="Titre du document" required />
           <select name="doc_type">
             <option value="pcs">PCS</option>
             <option value="orsec">ORSEC</option>
             <option value="convention">Convention</option>
             <option value="cartographie">Cartographie</option>
             <option value="annexe">Annexe</option>
             <option value="document" selected>Document</option>
           </select>
           <input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" required />
           <button type="submit" class="ghost inline-action">Ajouter</button>
         </form>
         <div class="municipality-upload-progress hidden" data-muni-upload-progress="${municipality.id}" hidden>
           <div class="municipality-upload-progress__bar" style="width:${state.progress}%"></div>
           <span data-muni-upload-progress-label="${municipality.id}">${state.progress}%</span>
         </div>
       </div>`
    : '';

  content.innerHTML = `
    <h4>${escapeHtml(municipality.name)}</h4>
    <p><strong>Responsable:</strong> ${escapeHtml(municipality.manager || '-')}</p>
    <p><strong>Téléphone:</strong> ${escapeHtml(municipality.phone || '-')} · <strong>Email:</strong> ${escapeHtml(municipality.email || '-')}</p>
    <p><strong>Code postal:</strong> ${escapeHtml(municipality.postal_code || '-')} · <strong>PCS:</strong> ${municipality.pcs_active ? 'actif' : 'inactif'}</p>
    <p><strong>Statut:</strong> ${municipality.crisis_mode ? 'CRISE' : 'veille'} · <strong>Vigilance:</strong> ${escapeHtml(normalizeLevel(municipality.vigilance_color || 'vert'))}</p>
    <p><strong>Population:</strong> ${municipality.population ?? '-'} · <strong>Capacité d'accueil:</strong> ${municipality.shelter_capacity ?? '-'}</p>
    <p><strong>Canal radio:</strong> ${escapeHtml(municipality.radio_channel || '-')}</p>
    <p><strong>Contacts d'astreinte:</strong><br>${escapeHtml(municipality.contacts || 'Aucun')}</p>
    <p><strong>Informations complémentaires:</strong><br>${escapeHtml(municipality.additional_info || 'Aucune')}</p>
    <h5>Documents partagés</h5>
    <p class="muted">Total: <strong>${files.length}</strong>${Object.entries(byType).map(([type, count]) => ` · ${escapeHtml(type)}: ${count}`).join('')}</p>
    ${municipalityDocumentFiltersMarkup(state, municipality.id)}
    <ul class="list compact">${municipalityFilesMarkup(filteredFiles, municipality.id)}</ul>
    <h5>Main courante liée à la commune</h5>
    <ul class="list compact">${municipalityLogs.map((log) => {
      const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
      return `<li><strong>${new Date(log.created_at).toLocaleString()}</strong> · ${log.danger_emoji || '🟢'} <strong>${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="badge neutral">${status}</span><br>${escapeHtml(log.description || '')}</li>`;
    }).join('') || '<li>Aucune entrée main courante associée.</li>'}</ul>
    ${quickActions}
  `;

  content.querySelectorAll('button').forEach((button) => {
    if ((button.textContent || '').trim().toLowerCase() === 'éditer la fiche') button.remove();
  });

  if (typeof modal.showModal === 'function') {
    if (modal.open) return;
    modal.showModal();
    return;
  }
  modal.setAttribute('open', 'open');
}

async function pickMunicipalityFile(municipalityId) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.pdf,.png,.jpg,.jpeg';
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    const titlePrompt = window.prompt('Nom du document', file.name);
    if (titlePrompt === null) return;
    const title = titlePrompt.trim() || file.name;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('doc_type', 'document');
    await api(`/municipalities/${municipalityId}/files`, { method: 'POST', body: formData });
    await loadMunicipalities();
    const refreshed = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
    if (refreshed) await openMunicipalityDetailsModal(refreshed);
  };
  picker.click();
}

async function submitMunicipalityUploadForm(form, municipalityId) {
  const file = form.elements.file.files?.[0];
  if (!file) return;
  const title = form.elements.title.value.trim() || file.name;
  const docType = form.elements.doc_type.value || 'document';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', title);
  formData.append('doc_type', docType);

  const progressWrap = document.querySelector(`[data-muni-upload-progress="${municipalityId}"]`);
  const progressLabel = document.querySelector(`[data-muni-upload-progress-label="${municipalityId}"]`);
  if (progressWrap) {
    progressWrap.hidden = false;
    progressWrap.classList.remove('hidden');
  }

  await uploadMunicipalityDocumentWithFallback(municipalityId, formData, (progress) => {
    const bar = progressWrap?.querySelector('.municipality-upload-progress__bar');
    if (bar) bar.style.width = `${progress}%`;
    if (progressLabel) progressLabel.textContent = `${progress}%`;
  });

  await loadMunicipalities();
  const refreshed = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
  if (refreshed) await openMunicipalityDetailsModal(refreshed);
}

function renderCriticalRisks(meteo = {}, externalRisks = {}) {
  const criticalLevels = new Set(['orange', 'rouge']);
  const currentAlerts = (meteo.current_alerts || []).filter((alert) => criticalLevels.has(normalizeLevel(alert.level)));
  const meteoMarkup = currentAlerts.map((alert) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).slice(0, 1).join(' ');
    return `<li><strong>${escapeHtml(alert.phenomenon || 'Phénomène')}</strong> · <span class="risk-${level}">${level}</span>${details ? `<br>${escapeHtml(details)}` : ''}</li>`;
  });

  const itinisereEvents = externalRisks?.itinisere?.events || [];
  const bisonIsere = externalRisks?.bison_fute?.today?.isere || {};
  const georisques = externalRisks?.georisques?.data && typeof externalRisks.georisques.data === 'object'
    ? { ...externalRisks.georisques.data, ...externalRisks.georisques }
    : (externalRisks?.georisques || {});

  const externalMarkup = [
    `<li><strong>Itinisère</strong> · ${escapeHtml(externalRisks?.itinisere?.status || 'inconnu')}<br>${itinisereEvents.length} activité(s) routière(s) en cours.</li>`,
    `<li><strong>Bison Futé</strong> · Départs ${escapeHtml(bisonIsere.departure || 'inconnu')} / Retours ${escapeHtml(bisonIsere.return || 'inconnu')}<br>Tendance trafic Isère du jour.</li>`,
    `<li><strong>Géorisques</strong> · ${escapeHtml(georisques.status || 'inconnu')}<br>Sismicité ${escapeHtml(georisques.highest_seismic_zone_label || 'inconnue')} · ${Number(georisques.flood_documents_total ?? 0)} document(s) inondation.</li>`,
  ];

  const markup = [...meteoMarkup, ...externalMarkup].join('') || '<li>Aucun risque orange ou rouge en cours.</li>';
  setHtml('critical-risks-list', markup);
}

function renderDashboard(dashboard = {}) {
  setRiskText('vigilance', normalizeLevel(dashboard.vigilance), dashboard.vigilance);
  setRiskText('crues', normalizeLevel(dashboard.crues), dashboard.crues);
  setRiskText('risk', normalizeLevel(dashboard.global_risk), dashboard.global_risk);
  const riskNode = document.getElementById('risk');
  if (riskNode) riskNode.className = normalizeLevel(dashboard.global_risk);
  setText('crisis', String(dashboard.communes_crise || 0));

  const logs = Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs : [];
  const formatSituationLog = (log) => {
    const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
    const at = new Date(log.event_time || log.created_at || Date.now()).toLocaleString();
    const scope = formatLogScope(log);
    const icon = log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢';
    return `<li><strong>${at}</strong> · <span class="badge neutral">${status}</span> · <span class="badge neutral">${scope}</span><br>${icon} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'Évènement')}</strong> · ${escapeHtml(log.description || '')}</li>`;
  };

  const openLogs = logs.filter((log) => String(log.status || '').toLowerCase() !== 'clos');
  const closedLogs = logs.filter((log) => String(log.status || '').toLowerCase() === 'clos');
  const criticalLogs = logs.filter((log) => {
    const level = normalizeLevel(log.danger_level || 'vert');
    return level === 'orange' || level === 'rouge';
  });

  const latestTimestamp = logs
    .map((log) => new Date(log.event_time || log.created_at || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a)[0];

  setText('situation-open-count', String(openLogs.length));
  setText('situation-closed-count', String(closedLogs.length));
  setText('situation-critical-count', String(criticalLogs.length));
  setText('situation-last-update', latestTimestamp ? new Date(latestTimestamp).toLocaleTimeString() : '-');

  setHtml('latest-logs-open', openLogs.map(formatSituationLog).join('') || '<li>Aucune crise en cours.</li>');
  setHtml('latest-logs-closed', closedLogs.map(formatSituationLog).join('') || '<li>Aucune crise clôturée récente.</li>');
}

async function loadDashboard() {
  const cached = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (cached) renderDashboard(cached);
  const dashboard = await api('/dashboard');
  renderDashboard(dashboard);
  saveSnapshot(STORAGE_KEYS.dashboardSnapshot, dashboard);
}

function renderExternalRisks(data = {}) {
  const meteo = data?.meteo_france || {};
  const vigicrues = data?.vigicrues || {};
  const itinisere = data?.itinisere || {};
  const bisonFute = data?.bison_fute || {};
  const georisquesPayload = data?.georisques || {};
  const georisques = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
    ? { ...georisquesPayload.data, ...georisquesPayload }
    : georisquesPayload;

  setRiskText('meteo-status', `${meteo.status || 'inconnu'} · niveau ${normalizeLevel(meteo.level || 'inconnu')}`, meteo.level || 'vert');
  setText('meteo-info', meteo.info_state || meteo.bulletin_title || '');
  setRiskText('vigicrues-status', `${vigicrues.status || 'inconnu'} · niveau ${normalizeLevel(vigicrues.water_alert_level || 'inconnu')}`, vigicrues.water_alert_level || 'vert');
  setText('vigicrues-info', `${(vigicrues.stations || []).length} station(s) suivie(s)`);
  setHtml('stations-list', (vigicrues.stations || []).slice(0, 10).map((s) => `<li>${s.station || s.code} · ${s.river || ''} · ${normalizeLevel(s.level)} · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible.</li>');
  setText('itinisere-status', `${itinisere.status || 'inconnu'} · ${(itinisere.events || []).length} événements`);
  renderBisonFuteSummary(bisonFute);
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} AZI · ${georisques.ppr_total ?? 0} PPR · ${georisques.ground_movements_total ?? 0} mouvements`);
  renderGeorisquesDetails(georisques);
  renderCriticalRisks(meteo, data);
  renderMeteoAlerts(meteo);
  renderItinisereEvents(itinisere.events || []);
  setText('meteo-level', normalizeLevel(meteo.level || 'vert'));
  setText('meteo-hazards', (meteo.hazards || []).join(', ') || 'non précisé');
  setText('river-level', normalizeLevel(vigicrues.water_alert_level || 'vert'));
  const itinisereInsights = itinisere.insights || {};
  const topRoads = (itinisereInsights.top_roads || []).map((item) => `${item.road} (${item.count})`).join(', ');
  setText('map-itinisere-category', itinisereInsights.dominant_category || 'inconnue');
  setText('map-itinisere-roads', topRoads || 'non renseigné');
  setText('map-seismic-level', georisques.highest_seismic_zone_label || 'inconnue');
  setText('map-flood-docs', String(georisques.flood_documents_total ?? 0));
  renderStations(vigicrues.stations || []);
}

async function loadExternalRisks() {
  const cached = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (cached) {
    renderExternalRisks(cached);
    renderTrafficOnMap().catch(() => {});
  }

  const data = await api('/external/isere/risks');
  renderExternalRisks(data);
  saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, data);
  await renderTrafficOnMap();
}

function renderApiInterconnections(data = {}) {
  const services = [
    { key: 'meteo_france', label: 'Météo-France', level: normalizeLevel(data.meteo_france?.level || 'inconnu'), details: data.meteo_france?.info_state || data.meteo_france?.bulletin_title || '-' },
    { key: 'vigicrues', label: 'Vigicrues', level: normalizeLevel(data.vigicrues?.water_alert_level || 'inconnu'), details: `${(data.vigicrues?.stations || []).length} station(s)` },
    { key: 'itinisere', label: 'Itinisère', level: `${(data.itinisere?.events || []).length} événement(s)`, details: data.itinisere?.source || '-' },
    { key: 'bison_fute', label: 'Bison Futé', level: data.bison_fute?.today?.isere?.departure || 'inconnu', details: data.bison_fute?.source || '-' },
    { key: 'georisques', label: 'Géorisques', level: data.georisques?.highest_seismic_zone_label || 'inconnue', details: `${data.georisques?.flood_documents_total ?? 0} document(s) inondation` },
  ];

  const cards = services.map((service) => {
    const payload = data[service.key] || {};
    const status = String(payload.status || 'inconnu');
    const degraded = status !== 'online' || Boolean(payload.error);
    const errorLabel = serviceErrorLabel(payload);
    return `<article class="api-card"><h4>${service.label}</h4><p>Statut: <span class="${degraded ? 'ko' : 'ok'}">${status}</span></p><p>Indicateur: <strong>${escapeHtml(service.level)}</strong></p><p class="muted">${escapeHtml(service.details)}</p><p class="${degraded ? 'ko' : 'muted'}">Erreur actuelle: ${escapeHtml(errorLabel)}</p></article>`;
  }).join('');

  const rawBlocks = services.map((service) => {
    const payload = data[service.key] || {};
    return `<details class="api-raw-item"><summary>${service.label}</summary><pre>${formatApiJson(payload)}</pre></details>`;
  }).join('');

  const activeErrors = services
    .map((service) => ({ label: service.label, payload: data[service.key] || {} }))
    .filter(({ payload }) => payload.status !== 'online' || payload.error)
    .map(({ label, payload }) => `${label}: ${serviceErrorLabel(payload)}`);

  setText('api-updated-at', data.updated_at ? new Date(data.updated_at).toLocaleString() : 'inconnue');
  setText('api-error-banner', activeErrors.join(' · ') || 'Aucune erreur active sur les interconnexions.');
  setHtml('api-service-grid', cards || '<p>Aucun service disponible.</p>');
  setHtml('api-raw-list', rawBlocks || '<p>Aucun retour JSON disponible.</p>');
}

async function loadApiInterconnections(forceRefresh = false) {
  const suffix = forceRefresh ? '?refresh=true' : '';
  if (!forceRefresh) {
    const cached = readSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot);
    if (cached) renderApiInterconnections(cached);
  }
  const data = await api(`/external/isere/risks${suffix}`);
  renderApiInterconnections(data);
  saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, data);
}

async function loadMunicipalities() {
  let municipalities = [];
  try {
    const payload = await api('/municipalities');
    municipalities = Array.isArray(payload) ? payload : [];
    localStorage.setItem(STORAGE_KEYS.municipalitiesCache, JSON.stringify(municipalities));
  } catch (error) {
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
      municipalities = Array.isArray(cached) ? cached : [];
    } catch (_) {
      municipalities = [];
    }
    setMapFeedback(`Liste des communes indisponible via API, affichage du cache local (${municipalities.length}).`, true);
  }

  cachedMunicipalityRecords = municipalities;
  cachedMunicipalities = municipalities;
  document.getElementById('municipalities-list').innerHTML = municipalities.map((m) => {
    const dangerColor = levelColor(m.vigilance_color || 'vert');
    const actions = canEdit()
      ? `<div class="municipality-actions">
           <button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button>
           <button type="button" class="ghost inline-action" data-muni-edit="${m.id}">Éditer</button>
           <button type="button" class="ghost inline-action" data-muni-crisis="${m.id}">${m.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
           <button type="button" class="ghost inline-action" data-muni-files="${m.id}">Documents</button>
           <button type="button" class="ghost inline-action danger" data-muni-delete="${m.id}">Supprimer</button>
         </div>`
      : canMunicipalityFiles()
        ? `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button><button type="button" class="ghost inline-action" data-muni-files="${m.id}">Documents</button></div>`
        : `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button></div>`;
    return `<article class="municipality-card" data-muni-id="${m.id}">
      <header>
        <h4>${escapeHtml(m.name)}</h4>
        <span class="badge ${normalizeLevel(m.vigilance_color || 'vert') === 'rouge' ? 'red' : normalizeLevel(m.vigilance_color || 'vert') === 'orange' ? 'orange' : normalizeLevel(m.vigilance_color || 'vert') === 'jaune' ? 'yellow' : 'green'}">${normalizeLevel(m.vigilance_color || 'vert')}</span>
      </header>
      <p><strong>${escapeHtml(m.manager)}</strong> · ${escapeHtml(m.phone)} · ${escapeHtml(m.email)}</p>
      <p style="color:${dangerColor}">Statut: ${m.crisis_mode ? 'CRISE' : 'veille'} · PCS ${m.pcs_active ? 'actif' : 'inactif'} · ${m.postal_code || 'CP ?'}</p>
      <div class="municipality-stats">
        <p>Population<br><strong>${m.population ?? '-'}</strong></p>
        <p>Accueil<br><strong>${m.shelter_capacity ?? '-'}</strong></p>
        <p>Radio<br><strong>${escapeHtml(m.radio_channel || '-')}</strong></p>
        <p>Contacts<br><strong>${escapeHtml(m.contacts || '-')}</strong></p>
      </div>
      <p class="municipality-docs">Documents: personnalisés</p>
      <p class="muted">${escapeHtml(m.additional_info || 'Aucune information complémentaire')}</p>
      ${actions}
    </article>`;
  }).join('') || '<p class="muted">Aucune commune.</p>';
  populateLogMunicipalityOptions(municipalities);
  syncLogScopeFields();
  syncLogOtherFields();
  await renderMunicipalitiesOnMap(municipalities);
}


function computeLogCriticality(level) {
  return ({ rouge: 4, orange: 3, jaune: 2, vert: 1 }[normalizeLevel(level)] || 0);
}

function renderLogsList() {
  const search = String(document.getElementById('logs-search')?.value || '').trim().toLowerCase();
  const municipalityFilter = String(document.getElementById('logs-municipality-filter')?.value || 'all');
  const scopeFilter = String(document.getElementById('logs-scope-filter')?.value || 'all');
  const sort = String(document.getElementById('logs-sort')?.value || 'date_desc');

  let filtered = [...cachedLogs];
  if (scopeFilter !== 'all') filtered = filtered.filter((log) => String(log.target_scope || 'departemental') === scopeFilter);
  if (municipalityFilter !== 'all') filtered = filtered.filter((log) => String(log.municipality_id || '') === municipalityFilter);
  if (search) {
    filtered = filtered.filter((log) => {
      const haystack = [
        log.event_type,
        log.description,
        log.target_scope,
        log.status,
        log.location,
        log.source,
        log.tags,
        getMunicipalityName(log.municipality_id),
      ].map((value) => String(value || '').toLowerCase()).join(' ');
      return haystack.includes(search);
    });
  }

  filtered.sort((a, b) => {
    if (sort === 'date_asc') return new Date(a.event_time || a.created_at).getTime() - new Date(b.event_time || b.created_at).getTime();
    if (sort === 'danger_desc') return computeLogCriticality(b.danger_level) - computeLogCriticality(a.danger_level);
    if (sort === 'type_asc') return String(a.event_type || '').localeCompare(String(b.event_type || ''), 'fr');
    return new Date(b.event_time || b.created_at).getTime() - new Date(a.event_time || a.created_at).getTime();
  });

  setText('logs-count', String(filtered.length));
  setHtml('logs-list', filtered.map((l) => formatLogLine(l)).join('') || '<li>Aucun log.</li>');
}

async function loadLogs() {
  const logs = await api('/logs');
  cachedLogs = Array.isArray(logs) ? logs : [];
  renderLogsList();
}

async function exportLogsCsv() {
  const response = await fetch('/logs/export/csv', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Export impossible (${response.status})`);
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `main-courante-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  link.click();
  window.URL.revokeObjectURL(url);
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const users = await api('/auth/users');
  const isAdmin = currentUser?.role === 'admin';
  setHtml('users-table', users.map((u) => {
    const actionButtons = isAdmin
      ? `<div class="users-actions"><button type="button" data-user-edit="${u.id}">Modifier</button><button type="button" data-user-reset="${u.id}">Réinitialiser mot de passe</button><button type="button" class="ghost" data-user-delete="${u.id}">Supprimer</button></div>`
      : '-';
    return `<tr><td>${escapeHtml(u.username)}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.municipality_name || '-')}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td><td>${actionButtons}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Aucun utilisateur.</td></tr>');
}

async function refreshAll(forceRefresh = false) {
  const loaders = [
    { label: 'tableau de bord', loader: loadDashboard, optional: false },
    { label: 'risques externes', loader: loadExternalRisks, optional: false },
    { label: 'communes', loader: loadMunicipalities, optional: false },
    { label: 'main courante', loader: loadLogs, optional: false },
    { label: 'utilisateurs', loader: loadUsers, optional: true },
    { label: 'interconnexions API', loader: loadApiInterconnections, optional: true },
    { label: 'points cartographiques', loader: loadMapPoints, optional: true },
  ];

  const results = await Promise.allSettled(loaders.map(({ loader }) => loader()));
  const failures = results
    .map((result, index) => ({ result, config: loaders[index] }))
    .filter(({ result }) => result.status === 'rejected');

  const blockingFailures = failures.filter(({ config }) => !config.optional);
  const optionalFailures = failures.filter(({ config }) => config.optional);

  renderResources();
  fitMapToData();

  if (!blockingFailures.length) {
    document.getElementById('dashboard-error').textContent = optionalFailures.length
      ? `Modules secondaires indisponibles: ${optionalFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ')}`
      : '';
    return;
  }

  const message = blockingFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ');
  document.getElementById('dashboard-error').textContent = message;
  setMapFeedback(message, true);
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  document.querySelectorAll('[data-admin-only]').forEach((node) => setVisibility(node, currentUser?.role === 'admin'));
  setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
}


function syncUserCreateMunicipalityVisibility() {
  const role = document.getElementById('user-create-role')?.value;
  setVisibility(document.getElementById('user-create-municipality-wrap'), role === 'mairie');
}

async function handleUsersTableAction(event) {
  const editButton = event.target.closest('[data-user-edit]');
  const resetButton = event.target.closest('[data-user-reset]');
  const deleteButton = event.target.closest('[data-user-delete]');
  if (!editButton && !resetButton && !deleteButton) return;

  document.getElementById('users-error').textContent = '';
  document.getElementById('users-success').textContent = '';

  try {
    if (editButton) {
      const userId = editButton.getAttribute('data-user-edit');
      const role = window.prompt('Nouveau rôle (admin, ope, securite, visiteur, mairie)');
      if (!role) return;
      const municipalityName = role === 'mairie' ? window.prompt('Nom de la commune associée') : null;
      await api(`/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role.trim().toLowerCase(), municipality_name: municipalityName || null }),
      });
      document.getElementById('users-success').textContent = 'Utilisateur mis à jour.';
    }

    if (resetButton) {
      const userId = resetButton.getAttribute('data-user-reset');
      const customPassword = window.prompt('Nouveau mot de passe temporaire (laisser vide pour générer automatiquement)', '');
      const payload = customPassword ? { new_password: customPassword } : {};
      const result = await api(`/auth/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('users-success').textContent = `Mot de passe temporaire pour ${result.username}: ${result.temporary_password}`;
    }

    if (deleteButton) {
      const userId = deleteButton.getAttribute('data-user-delete');
      if (!window.confirm('Confirmer la suppression de cet utilisateur ?')) return;
      await api(`/auth/users/${userId}`, { method: 'DELETE' });
      document.getElementById('users-success').textContent = 'Utilisateur supprimé.';
    }

    await loadUsers();
  } catch (error) {
    document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
  }
}


function renderMapChecks(checks = []) {
  const target = document.getElementById('map-checks-list');
  if (!target) return;
  if (!checks.length) {
    target.innerHTML = '<li>Aucun diagnostic exécuté.</li>';
    return;
  }
  target.innerHTML = checks.map((check) => `<li><span class="${check.ok ? 'ok' : 'ko'}">${check.ok ? 'OK' : 'KO'}</span> · ${escapeHtml(check.label)}${check.detail ? ` — ${escapeHtml(check.detail)}` : ''}</li>`).join('');
}

async function runMapChecks() {
  const checks = [];
  checks.push({ ok: typeof window.L !== 'undefined', label: 'Leaflet chargé', detail: typeof window.L !== 'undefined' ? 'bibliothèque disponible' : 'script Leaflet absent' });
  checks.push({ ok: Boolean(leafletMap), label: 'Instance carte initialisée', detail: leafletMap ? 'instance active' : 'carte non initialisée' });
  checks.push({ ok: Boolean(boundaryLayer), label: 'Contour Isère', detail: boundaryLayer ? 'contour affiché' : 'contour non chargé' });
  checks.push({ ok: cachedStations.length > 0, label: 'Stations Vigicrues', detail: `${cachedStations.length} station(s) en mémoire` });
  checks.push({ ok: cachedMunicipalities.length > 0, label: 'Communes disponibles', detail: `${cachedMunicipalities.length} commune(s) en mémoire` });
  checks.push({ ok: mapPoints.length >= 0, label: 'Points opérationnels', detail: `${mapPoints.length} point(s)` });
  const online = await Promise.allSettled([
    api('/public/isere-map', { logoutOn401: false }),
    api('/external/isere/risks', { logoutOn401: false }),
  ]);
  checks.push({ ok: online[0].status === 'fulfilled', label: 'API contour Isère', detail: online[0].status === 'fulfilled' ? 'accessible' : sanitizeErrorMessage(online[0].reason?.message) });
  checks.push({ ok: online[1].status === 'fulfilled', label: 'API risques consolidés', detail: online[1].status === 'fulfilled' ? 'accessible' : sanitizeErrorMessage(online[1].reason?.message) });

  renderMapChecks(checks);
  const failures = checks.filter((item) => !item.ok).length;
  if (!failures) {
    setMapFeedback('Diagnostic carte terminé: tout est opérationnel ✅');
    return;
  }
  setMapFeedback(`Diagnostic carte: ${failures} point(s) à corriger.`, true);
}

function setMapControlsCollapsed(collapsed) {
  mapControlsCollapsed = Boolean(collapsed);
  const workspace = document.querySelector('#map-panel .map-workspace');
  const controls = document.getElementById('map-controls-panel');
  const toggle = document.getElementById('map-controls-toggle');
  if (!workspace || !controls || !toggle) return;
  workspace.classList.toggle('map-workspace--collapsed', mapControlsCollapsed);
  controls.setAttribute('aria-hidden', String(mapControlsCollapsed));
  toggle.setAttribute('aria-expanded', String(!mapControlsCollapsed));
  toggle.textContent = mapControlsCollapsed ? '🧰' : '📌';
  const toggleLabel = mapControlsCollapsed ? 'Afficher les options de la carte' : 'Ranger les options de la carte';
  toggle.title = toggleLabel;
  toggle.setAttribute('aria-label', toggleLabel);
  if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 160);
}

function bindHomeInteractions() {
  const openLogin = () => showLogin();
  const mobileMenuButton = document.getElementById('mobile-menu-btn');
  const homeNav = document.getElementById('home-nav');

  document.getElementById('open-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('hero-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('back-home-btn')?.addEventListener('click', showHome);
  document.getElementById('scroll-actions-btn')?.addEventListener('click', () => document.getElementById('home-features')?.scrollIntoView({ behavior: 'smooth' }));

  mobileMenuButton?.addEventListener('click', () => {
    const isOpen = homeNav?.classList.toggle('open');
    mobileMenuButton.setAttribute('aria-expanded', String(Boolean(isOpen)));
  });

  homeNav?.querySelectorAll('a, button').forEach((node) => node.addEventListener('click', () => {
    homeNav.classList.remove('open');
    mobileMenuButton?.setAttribute('aria-expanded', 'false');
  }));
}

function bindAppInteractions() {
  const appMenuButton = document.getElementById('app-menu-btn');
  const appSidebar = document.getElementById('app-sidebar');

  document.querySelectorAll('.menu-btn').forEach((button) => button.addEventListener('click', () => {
    setActivePanel(button.dataset.target);
    appSidebar?.classList.remove('open');
    appMenuButton?.setAttribute('aria-expanded', 'false');
  }));
  appMenuButton?.addEventListener('click', () => {
    const isOpen = appSidebar?.classList.toggle('open');
    appMenuButton.setAttribute('aria-expanded', String(Boolean(isOpen)));
  });
  document.getElementById('logout-btn').addEventListener('click', logout);
  setMapControlsCollapsed(false);
  document.getElementById('map-search-btn')?.addEventListener('click', handleMapSearch);
  document.getElementById('map-controls-toggle')?.addEventListener('click', () => {
    setMapControlsCollapsed(!mapControlsCollapsed);
  });
  document.getElementById('map-fit-btn')?.addEventListener('click', () => fitMapToData(true));
  document.getElementById('map-focus-crisis')?.addEventListener('click', focusOnCrisisAreas);
  document.getElementById('map-run-checks')?.addEventListener('click', runMapChecks);
  document.getElementById('map-toggle-contrast')?.addEventListener('click', toggleMapContrast);
  document.getElementById('map-reset-filters')?.addEventListener('click', async () => {
    try {
      await resetMapFilters();
    } catch (error) {
      setMapFeedback(sanitizeErrorMessage(error.message), true);
    }
  });
  document.getElementById('map-basemap-select')?.addEventListener('change', (event) => applyBasemap(event.target.value));
  document.getElementById('api-refresh-btn')?.addEventListener('click', async () => {
    try {
      await loadApiInterconnections(true);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('map-search')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); handleMapSearch(); } });
  document.getElementById('map-search-clear')?.addEventListener('click', () => {
    const input = document.getElementById('map-search');
    if (input) input.value = '';
    if (searchLayer) searchLayer.clearLayers();
    renderResources();
    setMapFeedback('Recherche effacée, ressources remises à jour.');
  });
  document.getElementById('map-add-point-toggle')?.addEventListener('click', () => {
    mapAddPointMode = !mapAddPointMode;
    setText('map-add-point-toggle', `Ajout: ${mapAddPointMode ? 'on' : 'off'}`);
    document.getElementById('map-add-point-toggle')?.setAttribute('aria-pressed', String(mapAddPointMode));
    const mapCanvas = document.getElementById('isere-map-leaflet');
    if (mapCanvas) mapCanvas.style.cursor = mapAddPointMode ? 'crosshair' : '';
    setMapFeedback(mapAddPointMode ? 'Cliquez sur la carte pour ajouter un point opérationnel avec icône.' : 'Mode ajout désactivé.');
  });
  document.getElementById('map-point-category-filter')?.addEventListener('change', renderCustomPoints);
  document.getElementById('map-point-form-cancel')?.addEventListener('click', () => {
    const modal = document.getElementById('map-point-modal');
    if (typeof modal?.close === 'function') modal.close();
    else modal?.removeAttribute('open');
  });
  document.getElementById('map-point-category')?.addEventListener('change', (event) => {
    const category = event.target.value;
    const iconInput = document.getElementById('map-point-icon');
    renderMapIconSuggestions(category);
    if (iconInput && !mapIconTouched) iconInput.value = iconForCategory(category);
  });
  document.getElementById('map-point-icon')?.addEventListener('input', () => {
    mapIconTouched = true;
  });
  document.getElementById('map-icon-suggestions')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-map-icon]');
    if (!button) return;
    const iconInput = document.getElementById('map-point-icon');
    if (!iconInput) return;
    iconInput.value = button.getAttribute('data-map-icon') || '📍';
    mapIconTouched = true;
  });
  document.getElementById('map-point-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingMapPointCoords && leafletMap) {
      pendingMapPointCoords = leafletMap.getCenter();
      setMapFeedback('Point non sélectionné: utilisation du centre de carte.');
    }
    if (!pendingMapPointCoords) {
      setMapFeedback('Cliquez d\'abord sur la carte pour positionner le point.', true);
      return;
    }
    const form = event.target;
    const category = form.elements.category.value || 'autre';
    const icon = form.elements.icon.value.trim() || iconForCategory(category);
    try {
      await saveMapPoint({
        name: form.elements.name.value.trim(),
        category,
        icon,
        notes: form.elements.notes.value.trim() || null,
        lat: pendingMapPointCoords.lat,
        lon: pendingMapPointCoords.lng,
      });
      pendingMapPointCoords = null;
      const modal = document.getElementById('map-point-modal');
      if (typeof modal?.close === 'function') modal.close();
      else modal?.removeAttribute('open');
      setMapFeedback('Point opérationnel enregistré.');
    } catch (error) {
      setMapFeedback(`Enregistrement impossible: ${sanitizeErrorMessage(error.message)}`, true);
    }
  });
  document.getElementById('itinerary-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-map-query]');
    if (!button) return;
    document.getElementById('map-search').value = button.getAttribute('data-map-query') || '';
    await handleMapSearch();
  });
  document.getElementById('custom-points-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-point]');
    if (!button) return;
    const targetId = button.getAttribute('data-remove-point');
    try {
      await deleteMapPoint(targetId);
      setMapFeedback('Point opérationnel supprimé.');
    } catch (error) {
      setMapFeedback(sanitizeErrorMessage(error.message), true);
    }
  });
  document.getElementById('municipalities-list')?.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-muni-view], [data-muni-detail]');
    const editButton = event.target.closest('[data-muni-edit]');
    const crisisButton = event.target.closest('[data-muni-crisis]');
    const filesButton = event.target.closest('[data-muni-files]');
    const deleteButton = event.target.closest('[data-muni-delete]');
    const card = event.target.closest('.municipality-card');
    const fallbackId = card?.getAttribute('data-muni-id');
    if (!viewButton && !editButton && !crisisButton && !filesButton && !deleteButton && !fallbackId) return;
    try {
      const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

      if (viewButton) {
        const municipality = getMunicipality(viewButton.getAttribute('data-muni-view') || viewButton.getAttribute('data-muni-detail'));
        if (!municipality) return;
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality.name}: ${municipality.crisis_mode ? 'en crise' : 'en veille'} · vigilance ${normalizeLevel(municipality.vigilance_color)}.`;
        openMunicipalityDetailsModal(municipality);
        return;
      }

      if (!editButton && !crisisButton && !filesButton && !deleteButton && fallbackId) {
        const municipality = getMunicipality(fallbackId);
        if (!municipality) return;
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality.name}: ${municipality.crisis_mode ? 'en crise' : 'en veille'} · vigilance ${normalizeLevel(municipality.vigilance_color)}.`;
        openMunicipalityDetailsModal(municipality);
        return;
      }

      if (editButton) {
        const municipalityId = editButton.getAttribute('data-muni-edit');
        const municipality = getMunicipality(municipalityId);
        if (!municipality) return;
        openMunicipalityEditor(municipality);
        return;
      }

      if (crisisButton) {
        const municipalityId = crisisButton.getAttribute('data-muni-crisis');
        const result = await api(`/municipalities/${municipalityId}/crisis`, { method: 'POST' });
        const municipality = getMunicipality(municipalityId);
        document.getElementById('municipality-feedback').textContent = `${municipality?.name || 'Commune'}: ${result.crisis_mode ? 'mode crise activé' : 'retour en veille'}.`;
      }

      if (filesButton) {
        const municipalityId = filesButton.getAttribute('data-muni-files');
        const municipality = getMunicipality(municipalityId);
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

      if (deleteButton) {
        const municipalityId = deleteButton.getAttribute('data-muni-delete');
        const municipality = getMunicipality(municipalityId);
        const confirmed = window.confirm(`Supprimer définitivement la commune ${municipality?.name || municipalityId} ?`);
        if (!confirmed) return;
        await api(`/municipalities/${municipalityId}`, { method: 'DELETE' });
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality?.name || municipalityId} supprimée.`;
      }

      await loadMunicipalities();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('user-create-role')?.addEventListener('change', syncUserCreateMunicipalityVisibility);
  document.getElementById('municipality-editor-close')?.addEventListener('click', () => {
    closeMunicipalityEditor();
  });
  document.getElementById('municipality-details-close')?.addEventListener('click', () => {
    closeMunicipalityDetailsModal();
  });
  document.getElementById('municipality-details-modal')?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMunicipalityDetailsModal();
  });
  document.getElementById('municipality-details-modal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'municipality-details-modal') closeMunicipalityDetailsModal();
  });
  document.getElementById('municipality-details-content')?.addEventListener('click', async (event) => {
    const crisisButton = event.target.closest('[data-muni-detail-crisis]');
    const openFileButton = event.target.closest('[data-muni-file-open]');
    const uploadFileButton = event.target.closest('[data-muni-file-upload]');
    const deleteFileButton = event.target.closest('[data-muni-file-delete]');
    if (!crisisButton && !openFileButton && !uploadFileButton && !deleteFileButton) return;

    const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

    try {
      if (crisisButton) {
        if (!canEdit()) return;
        const municipalityId = crisisButton.getAttribute('data-muni-detail-crisis');
        const result = await api(`/municipalities/${municipalityId}/crisis`, { method: 'POST' });
        await loadMunicipalities();
        const municipality = getMunicipality(municipalityId);
        document.getElementById('municipality-feedback').textContent = `${municipality?.name || 'Commune'}: ${result.crisis_mode ? 'mode crise activé' : 'retour en veille'}.`;
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

      if (openFileButton) {
        if (!canMunicipalityFiles()) return;
        const municipalityId = openFileButton.getAttribute('data-muni-id');
        const fileId = openFileButton.getAttribute('data-muni-file-open');
        await openMunicipalityFile(municipalityId, fileId);
        return;
      }

      if (uploadFileButton) {
        if (!canMunicipalityFiles()) return;
        await pickMunicipalityFile(uploadFileButton.getAttribute('data-muni-file-upload'));
        return;
      }

      if (deleteFileButton) {
        if (!canMunicipalityFiles()) return;
        const municipalityId = deleteFileButton.getAttribute('data-muni-id');
        const fileId = deleteFileButton.getAttribute('data-muni-file-delete');
        await api(`/municipalities/${municipalityId}/files/${fileId}`, { method: 'DELETE' });
        const municipality = getMunicipality(municipalityId);
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('municipality-details-content')?.addEventListener('change', async (event) => {
    const search = event.target.closest('[data-muni-doc-search]');
    const typeFilter = event.target.closest('[data-muni-doc-type-filter]');
    const sortFilter = event.target.closest('[data-muni-doc-sort]');
    if (!search && !typeFilter && !sortFilter) return;
    const municipalityId = search?.getAttribute('data-muni-doc-search') || typeFilter?.getAttribute('data-muni-doc-type-filter') || sortFilter?.getAttribute('data-muni-doc-sort');
    const municipality = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
    if (!municipality) return;
    const state = municipalityDocumentsUiState.get(String(municipalityId)) || { search: '', type: 'all', sort: 'date_desc' };
    municipalityDocumentsUiState.set(String(municipalityId), {
      ...state,
      search: search ? search.value || '' : state.search,
      type: typeFilter ? typeFilter.value : state.type,
      sort: sortFilter ? sortFilter.value : state.sort,
    });
    await openMunicipalityDetailsModal(municipality);
  });
  document.getElementById('municipality-details-content')?.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-muni-upload-form]');
    if (!form) return;
    event.preventDefault();
    try {
      await submitMunicipalityUploadForm(form, form.getAttribute('data-muni-upload-form'));
      document.getElementById('municipality-feedback').textContent = 'Document chargé avec succès.';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  document.getElementById('log-target-scope')?.addEventListener('change', () => {
    syncLogScopeFields();
  });
  document.getElementById('log-event-type')?.addEventListener('change', syncLogOtherFields);
  document.getElementById('log-source-select')?.addEventListener('change', syncLogOtherFields);
  document.getElementById('log-municipality-id')?.addEventListener('focus', () => {
    ensureLogMunicipalitiesLoaded();
  });
  ['logs-search', 'logs-municipality-filter', 'logs-scope-filter', 'logs-sort'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', renderLogsList);
    document.getElementById(id)?.addEventListener('change', renderLogsList);
  });
  document.getElementById('logs-export')?.addEventListener('click', async () => {
    try {
      await exportLogsCsv();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('logs-list')?.addEventListener('click', async (event) => {
    const statusButton = event.target.closest('[data-log-status]');
    const deleteButton = event.target.closest('[data-log-delete]');
    if (!statusButton && !deleteButton) return;
    if (!canEdit()) return;

    try {
      if (statusButton) {
        const logId = statusButton.getAttribute('data-log-status');
        const status = statusButton.getAttribute('data-log-next');
        await api(`/logs/${logId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      }

      if (deleteButton) {
        const logId = deleteButton.getAttribute('data-log-delete');
        const confirmed = window.confirm('Supprimer cette entrée de main courante ?');
        if (!confirmed) return;
        await api(`/logs/${logId}`, { method: 'DELETE' });
      }

      await loadLogs();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  syncLogScopeFields();

  document.getElementById('municipality-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit()) return;
    const form = event.target;
    const municipalityId = form.elements.id.value;
    const payload = {
      manager: form.elements.manager.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      postal_code: form.elements.postal_code.value.trim() || null,
      contacts: form.elements.contacts.value.trim() || null,
      additional_info: form.elements.additional_info.value.trim() || null,
      population: Number(form.elements.population.value || 0) || null,
      shelter_capacity: Number(form.elements.shelter_capacity.value || 0) || null,
      radio_channel: form.elements.radio_channel.value.trim() || null,
      vigilance_color: normalizeLevel(form.elements.vigilance_color.value || 'vert'),
      pcs_active: Boolean(form.elements.pcs_active.checked),
    };
    try {
      await api(`/municipalities/${municipalityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('municipality-feedback').textContent = 'Fiche commune enregistrée.';
      closeMunicipalityEditor();
      await loadMunicipalities();
    } catch (error) {
      document.getElementById('municipality-feedback').textContent = sanitizeErrorMessage(error.message);
    }
  });
  syncUserCreateMunicipalityVisibility();
  document.getElementById('users-table')?.addEventListener('click', handleUsersTableAction);
  document.getElementById('user-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-success').textContent = '';
    const form = new FormData(event.target);
    const role = String(form.get('role') || '').trim();
    const municipalityName = role === 'mairie' ? String(form.get('municipality_name') || '').trim() : null;

    try {
      await api('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: String(form.get('username') || '').trim(),
          password: String(form.get('password') || ''),
          role,
          municipality_name: municipalityName || null,
        }),
      });
      event.target.reset();
      syncUserCreateMunicipalityVisibility();
      document.getElementById('users-success').textContent = 'Utilisateur créé avec succès.';
      await loadUsers();
    } catch (error) {
      document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'resource-type-filter', 'filter-itinisere', 'filter-bison'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      renderStations(cachedStations);
      await renderMunicipalitiesOnMap(cachedMunicipalities);
      renderResources();
      await renderTrafficOnMap();
      fitMapToData();
    });
  });
}


function logout() {
  token = null;
  currentUser = null;
  clearApiCache();
  localStorage.removeItem(STORAGE_KEYS.token);
  if (refreshTimer) clearInterval(refreshTimer);
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  showHome();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => token && refreshAll(false), AUTO_REFRESH_MS);
}

function startApiPanelAutoRefresh() {
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  apiPanelTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (!token || activePanel !== 'api-panel' || document.hidden) return;
    loadApiInterconnections(false).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }, API_PANEL_REFRESH_MS);
}

async function loadHomeLiveStatus() {
  try {
    const data = await api('/public/live', { logoutOn401: false, omitAuth: true });
    const dashboard = data?.dashboard || {};
    setRiskText('home-meteo-state', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
    setRiskText('home-river-state', normalizeLevel(dashboard.crues || '-'), dashboard.crues || 'vert');
    setRiskText('home-global-risk', normalizeLevel(dashboard.global_risk || '-'), dashboard.global_risk || 'vert');
    document.getElementById('home-crisis-count').textContent = String(dashboard.communes_crise ?? 0);
    document.getElementById('home-seismic-state').textContent = data.georisques?.highest_seismic_zone_label || 'inconnue';
    document.getElementById('home-flood-docs').textContent = String(data.georisques?.flood_documents_total ?? 0);

    document.getElementById('home-feature-global-risk').textContent = normalizeLevel(dashboard.global_risk || '-');
    document.getElementById('home-feature-river-risk').textContent = normalizeLevel(dashboard.crues || '-');
    document.getElementById('home-feature-seismic-risk').textContent = data.georisques?.highest_seismic_zone_label || 'inconnue';

    setRiskText('home-feature-meteo', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
    setRiskText('home-feature-vigicrues', normalizeLevel(data.vigicrues?.water_alert_level || '-'), data.vigicrues?.water_alert_level || 'vert');
    document.getElementById('home-feature-crisis-count').textContent = String(dashboard.communes_crise ?? 0);

    document.getElementById('home-feature-itinisere-status').textContent = data.itinisere?.status || 'inconnu';
    document.getElementById('home-feature-itinisere-events').textContent = String(data.itinisere?.events_count ?? 0);
    document.getElementById('home-feature-bison-isere').textContent = `${data.bison_fute?.today?.isere?.departure || 'inconnu'} / ${data.bison_fute?.today?.isere?.return || 'inconnu'}`;
    renderHomeMeteoSituation(data.meteo_france?.current_situation || []);
    const updatedLabel = data?.updated_at ? new Date(data.updated_at).toLocaleString() : 'inconnue';
    document.getElementById('home-live-updated').textContent = `Dernière mise à jour: ${updatedLabel}`;
    document.getElementById('home-live-error').textContent = '';
  } catch (error) {
    document.getElementById('home-live-error').textContent = error.message;
  }
}

function startHomeLiveRefresh() {
  if (homeLiveTimer) clearInterval(homeLiveTimer);
  loadHomeLiveStatus();
  homeLiveTimer = setInterval(loadHomeLiveStatus, HOME_LIVE_REFRESH_MS);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('login-error').textContent = '';
  const form = new FormData(loginForm);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

  try {
    const payload = new URLSearchParams({ username, password });
    const result = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload, logoutOn401: false, omitAuth: true });
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
    syncLogScopeFields();
    syncLogOtherFields();
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
  const errorTarget = document.getElementById('dashboard-error');
  try {
    await api('/municipalities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.get('name'),
        manager: form.get('manager'),
        phone: form.get('phone'),
        email: form.get('email'),
        postal_code: form.get('postal_code'),
        contacts: form.get('contacts'),
        additional_info: form.get('additional_info'),
        population: Number(form.get('population') || 0) || null,
        shelter_capacity: Number(form.get('shelter_capacity') || 0) || null,
        radio_channel: form.get('radio_channel'),
      }),
    });
    event.target.reset();
    if (errorTarget) errorTarget.textContent = '';
    document.getElementById('municipality-feedback').textContent = 'Commune créée avec succès. Vous pouvez maintenant lancer des actions depuis la fiche.';
    await loadMunicipalities();
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

document.getElementById('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  const errorTarget = document.getElementById('dashboard-error');
  await ensureLogMunicipalitiesLoaded();
  try {
    await api('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: form.get('event_type'),
        description: form.get('description'),
        danger_level: form.get('danger_level') || 'vert',
        danger_emoji: LOG_LEVEL_EMOJI[form.get('danger_level') || 'vert'] || '🟢',
        status: form.get('status') || 'nouveau',
        target_scope: form.get('target_scope'),
        municipality_id: form.get('municipality_id') ? Number(form.get('municipality_id')) : null,
        location: form.get('location') || null,
        source: form.get('source') || null,
        assigned_to: form.get('assigned_to') || null,
        tags: form.get('tags') || null,
        next_update_due: form.get('next_update_due') || null,
        actions_taken: form.get('actions_taken') || null,
      }),
    });
    event.target.reset();
    if (errorTarget) errorTarget.textContent = '';
    syncLogScopeFields();
    await refreshAll();
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

(async function bootstrap() {
  bindHomeInteractions();
  bindAppInteractions();
  startHomeLiveRefresh();
  startApiPanelAutoRefresh();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadHomeLiveStatus();
    if (token) refreshAll(true);
  });
  window.addEventListener('focus', () => {
    loadHomeLiveStatus();
    if (token) refreshAll(true);
  });

  try {
    const cachedMunicipalities = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
    if (Array.isArray(cachedMunicipalities)) {
      populateLogMunicipalityOptions(cachedMunicipalities);
      syncLogScopeFields();
    }
  } catch (_) {
    // ignore cache parsing issues
  }

  if (!token) return showHome();
  try {
    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    applyRoleVisibility();
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await loadIsereBoundary();
    syncLogScopeFields();
    await refreshAll();
    startAutoRefresh();
  } catch {
    logout();
  }
})();
