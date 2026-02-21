const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel', mapPointsCache: 'mapPointsCache', municipalitiesCache: 'municipalitiesCache', dashboardSnapshot: 'dashboardSnapshot', externalRisksSnapshot: 'externalRisksSnapshot', apiInterconnectionsSnapshot: 'apiInterconnectionsSnapshot' };
const AUTO_REFRESH_MS = 300000;
const EVENTS_LIVE_REFRESH_MS = 300000;
const HOME_LIVE_REFRESH_MS = 300000;
const API_CACHE_TTL_MS = 300000;
const API_PANEL_REFRESH_MS = 300000;
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
let liveEventsTimer = null;
let homeLiveTimer = null;
let apiPanelTimer = null;
let apiResyncTimer = null;
let photoCameraRefreshTimer = null;
let lastApiResyncAt = null;
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
let bisonCameraLayer = null;
let photoCameraLayer = null;
let realtimeTrafficLayer = null;
let mapTileLayer = null;
let googleTrafficFlowLayer = null;
let mapAddPointMode = false;
let mapPoints = [];
let pendingMapPointCoords = null;
let mapIconTouched = false;
let cachedStations = [];
let cachedMunicipalities = [];
let cachedMunicipalityRecords = [];
let cachedItinisereEvents = [];
let cachedBisonFute = {};
let cachedRealtimeTraffic = {};
let geocodeCache = new Map();
let municipalityContourCache = new Map();
const municipalityDocumentsUiState = new Map();
let trafficGeocodeCache = new Map();
let mapStats = { stations: 0, pcs: 0, resources: 0, custom: 0, traffic: 0 };
let mapControlsCollapsed = false;
let cachedCrisisPoints = [];
let cachedLogs = [];
let cachedDashboardSnapshot = {};
let cachedExternalRisksSnapshot = {};
let isereBoundaryGeometry = null;
let trafficRenderSequence = 0;

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
const BISON_FUTE_CAMERAS = [
  { name: 'Meylan N87 PR10+590', road: 'N87', lat: 45.201217282265034, lon: 5.7812657653824875, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_27.mp4' },
  { name: 'Eybens N87 PR4+200', road: 'N87', lat: 45.15652758486637, lon: 5.7475476745737355, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_31.mp4' },
  { name: 'A480 Grenoble vers Grenoble Sud', road: 'A480', lat: 45.15873823197743, lon: 5.7005336069172925, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area09.mp4' },
  { name: 'A480/RN481 direction Ouest/Sud', road: 'A480 / RN481', lat: 45.21650958839951, lon: 5.6784500109717335, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area10.mp4' },
  { name: 'A48 aire de l’Île rose', road: 'A48', lat: 45.272598746702336, lon: 5.625897585313137, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area08.mp4' },
  { name: 'Bifurcation A43/A48 près de Bourgoin vers Chambéry', road: 'A43 / A48', lat: 45.56699881012449, lon: 5.344117226835471, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area06.mp4' },
  { name: 'A48 Châbons voie Sud', road: 'A48', lat: 45.44780572102549, lon: 5.399438919782866, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area11.mp4' },
];
const ITINISERE_PHOTO_CAMERAS = [
  {
    name: 'La Diat',
    road: 'D520B',
    lat: 45.33981893625896,
    lon: 5.807674386173609,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D520BLaDiat',
  },
  {
    name: 'Les Fontaines',
    road: 'D525',
    lat: 45.35574122911768,
    lon: 5.992340889751027,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D525LesFontaines',
  },
  {
    name: 'Fond de France',
    road: 'D525A',
    lat: 45.28221936272868,
    lon: 6.074009634997554,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D525AFonddeFrance',
  },
  {
    name: 'Rochetaillée',
    road: 'D1091 / D526',
    lat: 45.1144099370023,
    lon: 6.005238134016191,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D1091D526Rochetaillee',
  },
  {
    name: 'Seiglières',
    road: 'D111',
    lat: 45.15474818390343,
    lon: 5.869930116196619,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D111Seiglieres',
  },
  {
    name: 'Clavaux Grenoble',
    road: 'D1091',
    lat: 45.07592699481376,
    lon: 5.883116163700038,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D1091ClavauxGrenoble',
  },
];

function cameraPopupMarkup(camera = {}) {
  const name = escapeHtml(camera.name || 'Caméra routière');
  const road = escapeHtml(camera.road || 'Réseau principal');
  const manager = escapeHtml(camera.manager || 'Bison Futé');
  const sourceUrl = escapeHtml(camera.streamUrl || 'https://www.bison-fute.gouv.fr');
  const mediaType = camera.mediaType === 'image' ? 'image' : 'video';
  const mediaMarkup = mediaType === 'image'
    ? `<img src="${sourceUrl}" alt="Flux image caméra ${name}" loading="lazy" referrerpolicy="no-referrer" />`
    : `<video muted autoplay loop playsinline preload="metadata" aria-label="Flux caméra ${name}">
          <source src="${sourceUrl}" type="video/mp4" />
        </video>`;
  return `
    <article class="camera-popup">
      <strong>🎥 ${name}</strong><br/>
      <span class="badge neutral">${road} · ${manager}</span>
      <a class="camera-popup__media" href="${sourceUrl}" target="_blank" rel="noreferrer" title="Ouvrir le flux caméra dans un nouvel onglet">
        ${mediaMarkup}
      </a>
      <a href="${sourceUrl}" target="_blank" rel="noreferrer">Voir le flux caméra</a>
    </article>
  `;
}

function photoCameraPopupMarkup(camera = {}) {
  return cameraPopupMarkup({
    manager: 'Photo route',
    mediaType: 'image',
    ...camera,
  });
}

function refreshPhotoCameraImages(event) {
  const popupElement = event?.popup?.getElement?.();
  if (!popupElement) return;
  popupElement.querySelectorAll('img').forEach((image) => {
    const originalUrl = image.getAttribute('data-original-src') || image.getAttribute('src');
    if (!originalUrl) return;
    if (!image.getAttribute('data-original-src')) image.setAttribute('data-original-src', originalUrl);
    const separator = originalUrl.includes('?') ? '&' : '?';
    image.setAttribute('src', `${originalUrl}${separator}t=${Date.now()}`);
  });
}

function startPhotoCameraAutoRefresh() {
  if (photoCameraRefreshTimer) clearInterval(photoCameraRefreshTimer);
  photoCameraRefreshTimer = setInterval(() => {
    if (document.hidden || !leafletMap) return;
    leafletMap.eachLayer((layer) => {
      if (!(layer instanceof window.L.Marker)) return;
      const popup = layer.getPopup?.();
      if (!popup?.isOpen?.()) return;
      refreshPhotoCameraImages({ popup });
    });
  }, 30000);
}

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');

const normalizeLevel = (level) => ({ verte: 'vert', green: 'vert', yellow: 'jaune', red: 'rouge' }[(level || '').toLowerCase()] || (level || 'vert').toLowerCase());
const levelColor = (level) => ({ vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' }[normalizeLevel(level)] || '#2f9e44');
const LOG_LEVEL_EMOJI = { vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴' };
const LOG_STATUS_LABEL = { nouveau: 'Nouveau', en_cours: 'En cours', suivi: 'Suivi', clos: 'Clos' };

function debounce(fn, wait = 200) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

function riskRank(level) {
  return ({ rouge: 4, orange: 3, jaune: 2, vert: 1 }[normalizeLevel(level)] || 0);
}

function stationStatusLevel(station = {}) {
  const status = normalizeLevel(station.control_status || station.status || '');
  if (['vert', 'jaune', 'orange', 'rouge'].includes(status)) return status;
  return normalizeLevel(station.level || 'vert');
}

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
    setHtml('log-municipality-id', createOptions(true));
    if (current) formSelect.value = current;
  }

  const filterSelect = document.getElementById('logs-municipality-filter');
  if (filterSelect) {
    const currentFilter = filterSelect.value;
    setHtml('logs-municipality-filter', createOptions(false, 'Toutes les communes'));
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
function canCreateMapPoints() { return ['admin', 'ope', 'mairie'].includes(currentUser?.role); }
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


function formatElapsedSince(timestamp) {
  if (!timestamp) return 'inconnue';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'inconnue';
  const elapsed = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (elapsed < 60) return `il y a ${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `il y a ${hours}h${remainingMinutes ? ` ${remainingMinutes}min` : ''}`;
}

function renderApiResyncClock() {
  setText('api-resync-ago', formatElapsedSince(lastApiResyncAt));
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


function createApiError(message, status = null) {
  const error = new Error(message);
  if (status !== null && status !== undefined) error.status = Number(status);
  return error;
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
  const {
    logoutOn401 = true,
    omitAuth = false,
    cacheTtlMs = API_CACHE_TTL_MS,
    bypassCache = false,
    ...fetchOptions
  } = options;
  const cacheable = !bypassCache && isCacheableRequest(path, fetchOptions);
  const cacheKey = getRequestCacheKey(path, fetchOptions);

  if (cacheable) {
    const cached = apiGetCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
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
          throw createApiError(message, response.status);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (!String(error.message || '').includes('Réponse non-JSON')) break;
      }
    }

    throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status);
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
        throw createApiError(detail, response.status);
      }
      return { blob: await response.blob(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
    } catch (error) {
      lastError = error;
    }
  }
  throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status);
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

function withPreservedScroll(runUpdate) {
  const SCROLL_RESTORE_TOLERANCE_PX = 4;
  const pageScroll = window.scrollY || document.documentElement.scrollTop || 0;
  const activePanelId = localStorage.getItem(STORAGE_KEYS.activePanel);
  const activePanel = activePanelId ? document.getElementById(activePanelId) : null;
  const panelScroll = activePanel ? activePanel.scrollTop : 0;
  const panelScrollLeft = activePanel ? activePanel.scrollLeft : 0;

  return Promise.resolve()
    .then(runUpdate)
    .finally(() => {
      if (activePanel && activePanel.id === (localStorage.getItem(STORAGE_KEYS.activePanel) || '')) {
        const panelStillAtInitialPosition = Math.abs(activePanel.scrollTop - panelScroll) <= SCROLL_RESTORE_TOLERANCE_PX
          && Math.abs(activePanel.scrollLeft - panelScrollLeft) <= SCROLL_RESTORE_TOLERANCE_PX;
        if (panelStillAtInitialPosition) {
          activePanel.scrollTop = panelScroll;
          activePanel.scrollLeft = panelScrollLeft;
        }
      }
      const latestPageScroll = window.scrollY || document.documentElement.scrollTop || 0;
      const pageStillAtInitialPosition = Math.abs(latestPageScroll - pageScroll) <= SCROLL_RESTORE_TOLERANCE_PX;
      if (pageStillAtInitialPosition) {
        window.scrollTo({ top: pageScroll, left: 0, behavior: 'auto' });
      }
    });
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
  applyGoogleTrafficFlowOverlay();
}

function applyGoogleTrafficFlowOverlay() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const enabled = document.getElementById('filter-google-traffic-flow')?.checked ?? false;
  if (!enabled) {
    if (googleTrafficFlowLayer) {
      leafletMap.removeLayer(googleTrafficFlowLayer);
      googleTrafficFlowLayer = null;
    }
    return;
  }

  if (!googleTrafficFlowLayer) {
    googleTrafficFlowLayer = window.L.tileLayer('https://mt1.google.com/vt?lyrs=h,traffic&x={x}&y={y}&z={z}', {
      maxZoom: 20,
      opacity: 0.85,
      attribution: 'Flux trafic (lignes colorées) style Google Maps',
    });
  }

  if (!leafletMap.hasLayer(googleTrafficFlowLayer)) googleTrafficFlowLayer.addTo(leafletMap);
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
  bisonCameraLayer = window.L.layerGroup().addTo(leafletMap);
  photoCameraLayer = window.L.layerGroup().addTo(leafletMap);
  realtimeTrafficLayer = window.L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', onMapClickAddPoint);
  leafletMap.on('popupopen', refreshPhotoCameraImages);
  startPhotoCameraAutoRefresh();
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
  const bisonAccidents = document.getElementById('filter-bison-accidents');
  const bisonCameras = document.getElementById('filter-bison-cameras');
  const photoCameras = document.getElementById('filter-photo-cameras');
  const wazeClosedRoads = document.getElementById('filter-waze-closed-roads');
  const googleFlow = document.getElementById('filter-google-traffic-flow');
  if (hydro) hydro.checked = true;
  if (pcs) pcs.checked = true;
  if (activeOnly) activeOnly.checked = false;
  if (itinisere) itinisere.checked = true;
  if (bisonAccidents) bisonAccidents.checked = true;
  if (bisonCameras) bisonCameras.checked = true;
  if (photoCameras) photoCameras.checked = true;
  if (wazeClosedRoads) wazeClosedRoads.checked = true;
  if (googleFlow) googleFlow.checked = false;
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
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsBoundaryLayer, pcsLayer, resourceLayer, searchLayer, customPointsLayer, mapPointsLayer, itinisereLayer, bisonLayer, bisonCameraLayer, photoCameraLayer, realtimeTrafficLayer].filter(Boolean);
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
  isereBoundaryGeometry = data?.geometry || null;
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: ISERE_BOUNDARY_STYLE }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
  setMapFeedback('Fond de carte et contour Isère chargés.');
}

function isPointInRing(point, ring = []) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] || [];
    const [xj, yj] = ring[j] || [];
    const intersects = ((yi > point.lat) !== (yj > point.lat))
      && (point.lon < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInsideGeometry(point, geometry = null) {
  if (!point || !geometry) return false;
  const { type, coordinates } = geometry;
  if (!Array.isArray(coordinates)) return false;

  const isInsidePolygon = (polygon = []) => {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    const [outerRing, ...holes] = polygon;
    if (!isPointInRing(point, outerRing || [])) return false;
    return !holes.some((hole) => isPointInRing(point, hole || []));
  };

  if (type === 'Polygon') return isInsidePolygon(coordinates);
  if (type === 'MultiPolygon') return coordinates.some((polygon) => isInsidePolygon(polygon));
  return false;
}

function isIncidentInIsere(incident = {}) {
  if (!isereBoundaryGeometry) return true;
  const points = [];
  const incidentCoords = normalizeMapCoordinates(incident.lat, incident.lon);
  if (incidentCoords) points.push(incidentCoords);
  if (Array.isArray(incident.line)) {
    incident.line.forEach((linePoint) => {
      const normalized = normalizeMapCoordinates(linePoint?.lat, linePoint?.lon);
      if (normalized) points.push(normalized);
    });
  }
  if (!points.length) return false;
  return points.some((point) => isPointInsideGeometry(point, isereBoundaryGeometry));
}

function isAccidentIncident(incident = {}) {
  const fields = [incident.type, incident.subtype, incident.title, incident.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /accident|collision|carambolage|crash/.test(fields);
}

function renderStations(stations = []) {
  cachedStations = stations;
  const visible = document.getElementById('filter-hydro')?.checked ?? true;
  setHtml('hydro-stations-list', stations.slice(0, 40).map((s) => {
    const statusLevel = stationStatusLevel(s);
    return `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(statusLevel)}">${statusLevel}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`;
  }).join('') || '<li>Aucune station.</li>');
  if (!hydroLayer || !hydroLineLayer) return;
  hydroLayer.clearLayers();
  hydroLineLayer.clearLayers();
  if (!visible) {
    mapStats.stations = 0;
    updateMapSummary();
    return;
  }

  const stationsWithPoints = stations
    .map((s) => {
      const coords = normalizeMapCoordinates(s.lat, s.lon);
      return coords ? { ...s, ...coords } : null;
    })
    .filter(Boolean);
  mapStats.stations = stationsWithPoints.length;
  stationsWithPoints.forEach((s) => {
    const statusLevel = stationStatusLevel(s);
    const counter = ({ vert: 'V', jaune: 'J', orange: 'O', rouge: 'R' }[statusLevel] || 'V');
    window.L.marker([s.lat, s.lon], { icon: vigicruesStationIcon(statusLevel, counter) })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Département: Isère (38)<br>Statut: ${statusLevel}<br>Contrôle station: ${escapeHtml(s.control_status || 'inconnu')}<br>Hauteur: ${s.height_m} m`)
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
      const point = normalizeMapCoordinates(center[1], center[0]);
      if (!point) continue;
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
    const coords = normalizeMapCoordinates(r.lat, r.lon);
    if (!coords) return;
    window.L.circleMarker([coords.lat, coords.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: r.active ? '#2f9e44' : '#f59f00', fillOpacity: 0.95 })
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
  if (resource) {
    const coords = normalizeMapCoordinates(resource.lat, resource.lon);
    if (coords) return { ...coords, label: `${resource.name} (${resource.address})` };
  }
  const point = mapPoints.find((item) => String(item.name || '').toLowerCase().includes(needle));
  if (point) {
    const coords = normalizeMapCoordinates(point.lat, point.lon);
    if (coords) return { ...coords, label: `${point.icon || '📍'} ${point.name} (point opérationnel)` };
  }
  return null;
}

function placeSearchResult(lat, lon, label) {
  if (!leafletMap || !searchLayer) return;
  const coords = normalizeMapCoordinates(lat, lon);
  if (!coords) return;
  searchLayer.clearLayers();
  window.L.marker([coords.lat, coords.lon]).bindPopup(`Résultat: ${escapeHtml(label)}`).addTo(searchLayer).openPopup();
  leafletMap.setView([coords.lat, coords.lon], 12);
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
  try {
    const node = document.getElementById(id);
    if (!node) return false;
    node.innerHTML = value;
    return true;
  } catch (_) {
    return false;
  }
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
  poi: '📌',
  autre: '📍',
};

const MAP_ICON_SUGGESTIONS = {
  incident: ['🚨', '🔥', '⚠️', '💥', '🚓', '🚒', '🧯'],
  evacuation: ['🏃', '🏘️', '🚌', '🚶', '🏟️', '🏫', '🧒'],
  water: ['💧', '🌊', '🛶', '🌧️', '🏞️', '🚤', '🪵'],
  roadblock: ['⛔', '🚧', '🚦', '🛑', '🚫', '🚓', '⚠️'],
  medical: ['🏥', '🚑', '🩺', '💊', '🧑‍⚕️', '❤️', '🫁'],
  logistics: ['📦', '🚛', '🛠️', '⛽', '🔋', '🧰', '🏗️'],
  command: ['🛰️', '📡', '🧭', '🖥️', '📞', '📢', '🗺️'],
  poi: ['📌', '📍', '⭐', '🏢', '🏠', '🏫', '🏛️', '🏬', '🅿️'],
  autre: ['📍', '📌', '⭐', '🧩', '❗', '📎', '🔖'],
};

function iconForCategory(category) {
  return MAP_POINT_ICONS[category] || '📍';
}

function emojiDivIcon(emoji, options = {}) {
  const iconSize = Array.isArray(options.iconSize) ? options.iconSize : [30, 30];
  const iconAnchor = Array.isArray(options.iconAnchor) ? options.iconAnchor : [Math.round(iconSize[0] / 2), Math.round(iconSize[1] / 2)];
  const popupAnchor = Array.isArray(options.popupAnchor) ? options.popupAnchor : [0, -Math.round(iconSize[1] / 2)];
  const className = options.className ? `map-emoji-icon ${options.className}` : 'map-emoji-icon';
  return window.L.divIcon({ className, html: `<span>${escapeHtml(emoji)}</span>`, iconSize, iconAnchor, popupAnchor });
}

function vigicruesStationIcon(level = 'vert', counter = '1') {
  const normalizedLevel = normalizeLevel(level);
  return window.L.divIcon({
    className: 'vigicrues-station-icon-wrap',
    html: `<span class="vigicrues-station-icon">💧<span class="vigicrues-station-counter ${escapeHtml(normalizedLevel)}">${escapeHtml(counter)}</span></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 28],
    popupAnchor: [0, -24],
  });
}

function imageMarkerIcon(iconUrl) {
  return window.L.icon({
    iconUrl,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
    className: 'map-poi-icon',
  });
}

function markerIconForPoint(point = {}) {
  const iconUrl = String(point.icon_url || '').trim();
  if (/^https?:\/\//i.test(iconUrl)) return imageMarkerIcon(iconUrl);
  return emojiDivIcon(point.icon || iconForCategory(point.category));
}

function normalizeTrafficSeverity(level) {
  const raw = String(level || '').trim().toLowerCase();
  if (['rouge', 'orange', 'jaune', 'vert'].includes(raw)) return raw;
  return normalizeLevel(raw || 'vert');
}

function trafficLevelColor(level) {
  const normalized = normalizeTrafficSeverity(level);
  return ({ rouge: '#d9480f', orange: '#f08c00', jaune: '#f59f00', vert: '#2f9e44' }[normalized] || '#2f9e44');
}

function trafficLevelEmoji(level) {
  return ({ vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴' })[normalizeTrafficSeverity(level)] || '⚪';
}

function trafficMarkerIcon(kind = 'incident', category = '', text = '') {
  const lowered = `${category} ${text}`.toLowerCase();
  if (kind === 'waze-road-closed') return '⛔';
  if (/travaux|chantier|coup(é|e)|route coup/.test(lowered)) return '🚧';
  if (/ferm|barr|interdit/.test(lowered)) return '⛔';
  return detectItinisereIcon(text);
}

function itinisereRoadBadge(point = {}) {
  const road = Array.isArray(point.roads) && point.roads.length ? point.roads[0] : '';
  return String(road || '').toUpperCase().replace(/\s+/g, '');
}

function itinisereStyleType(point = {}) {
  const blob = `${point.category || ''} ${point.title || ''} ${point.description || ''}`.toLowerCase();
  if (/col\b/.test(blob)) return 'pass';
  if (/ferm|barr|interdit|coup/.test(blob)) return 'closure';
  if (/travaux|chantier/.test(blob)) return 'works';
  return 'warning';
}

function itinisereDivIcon(point = {}) {
  const styleType = itinisereStyleType(point);
  const roadBadge = itinisereRoadBadge(point);
  const road = roadBadge || '?';
  const warning = styleType === 'works' ? '🚧' : '⚠️';
  if (styleType === 'closure') {
    return window.L.divIcon({
      className: 'itinisere-icon-wrap',
      html: '<span class="itinisere-icon itinisere-icon--closure">ROUTE<br/>BARRÉE</span>',
      iconSize: [52, 30],
      iconAnchor: [26, 22],
      popupAnchor: [0, -18],
    });
  }

  if (styleType === 'pass') {
    return window.L.divIcon({
      className: 'itinisere-icon-wrap',
      html: `<span class="itinisere-icon itinisere-icon--pass">Col</span><span class="itinisere-pass-state">${escapeHtml(road)}</span>`,
      iconSize: [64, 32],
      iconAnchor: [32, 22],
      popupAnchor: [0, -19],
    });
  }

  return window.L.divIcon({
    className: 'itinisere-icon-wrap',
    html: `<span class="itinisere-icon itinisere-icon--warning">${warning}</span><span class="itinisere-road-dot">${escapeHtml(road)}</span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 30],
    popupAnchor: [0, -26],
  });
}

const ISERE_BOUNDS = {
  latMin: 44.6,
  latMax: 46.0,
  lonMin: 4.2,
  lonMax: 6.8,
};

function normalizeMapCoordinates(lat, lon) {
  let safeLat = Number(lat);
  let safeLon = Number(lon);
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLon)) return null;

  const inIsere = safeLat >= ISERE_BOUNDS.latMin && safeLat <= ISERE_BOUNDS.latMax
    && safeLon >= ISERE_BOUNDS.lonMin && safeLon <= ISERE_BOUNDS.lonMax;
  const inIsereIfSwapped = safeLon >= ISERE_BOUNDS.latMin && safeLon <= ISERE_BOUNDS.latMax
    && safeLat >= ISERE_BOUNDS.lonMin && safeLat <= ISERE_BOUNDS.lonMax;

  if (!inIsere && inIsereIfSwapped) [safeLat, safeLon] = [safeLon, safeLat];

  if (safeLat < -90 || safeLat > 90 || safeLon < -180 || safeLon > 180) return null;
  return {
    lat: Number(safeLat.toFixed(6)),
    lon: Number(safeLon.toFixed(6)),
  };
}

function isPointInIsere(point = {}) {
  const coords = normalizeMapCoordinates(point.lat, point.lon);
  if (!coords) return false;
  return coords.lat >= ISERE_BOUNDS.latMin && coords.lat <= ISERE_BOUNDS.latMax
    && coords.lon >= ISERE_BOUNDS.lonMin && coords.lon <= ISERE_BOUNDS.lonMax;
}

function detectItinisereIcon(text = '') {
  const lowered = text.toLowerCase();
  if (/accident|collision|carambolage/.test(lowered)) return '💥';
  if (/fermet|coup|interdit|barr/.test(lowered)) return '⛔';
  if (/travaux|chantier/.test(lowered)) return '🚧';
  if (/bouchon|ralenti|embouteillage/.test(lowered)) return '🐢';
  if (/manifestation|cortège|événement/.test(lowered)) return '🚶';
  return '⚠️';
}

function normalizeRoadCode(rawRoad = '') {
  const upper = String(rawRoad || '').toUpperCase().replace(/\s+/g, '');
  const compact = upper.replace(/^(?:RD|RN|CD)/, (prefix) => (prefix === 'RN' ? 'N' : 'D'));
  const match = compact.match(/^(A|N|D)(\d{1,4})$/);
  if (!match) return '';
  return `${match[1]}${match[2]}`;
}

function detectRoadCodes(text = '') {
  const roads = new Set();
  const matches = String(text).toUpperCase().match(/\b(?:A|N|D|RN|RD|CD)\s?\d{1,4}\b/g) || [];
  matches
    .map((road) => normalizeRoadCode(road))
    .filter(Boolean)
    .forEach((road) => roads.add(road));
  return Array.from(roads);
}

async function geocodeRoadWithContext(road = '', contextHints = []) {
  const normalizedRoad = normalizeRoadCode(road);
  if (!normalizedRoad) return null;
  for (const hint of contextHints) {
    const label = String(hint || '').trim();
    if (!label) continue;
    const point = await geocodeTrafficLabel(`${normalizedRoad} ${label}`);
    if (point) return { ...point, anchor: `${normalizedRoad} · ${label}` };
  }
  const fallback = await geocodeTrafficLabel(`${normalizedRoad} Isère`);
  if (fallback) return { ...fallback, anchor: `${normalizedRoad} · Isère` };
  return null;
}

async function geocodeTrafficLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(label)}&fields=centre,codeDepartement&codeDepartement=38&limit=1`;
    const communeResponse = await fetch(communeUrl);
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const center = communePayload?.[0]?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = { lat: Number(center[1]), lon: Number(center[0]), precision: 'commune' };
      if (isPointInIsere(point)) {
        trafficGeocodeCache.set(key, point);
        return point;
      }
    }
  } catch {
    // fallback nominatim
  }

  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(`${label}, Isère, France`)}`;
    const response = await fetch(nominatimUrl, { headers: { Accept: 'application/json' } });
    const payload = await parseJsonResponse(response, nominatimUrl);
    const first = payload?.[0];
    const point = first ? { lat: Number(first.lat), lon: Number(first.lon), precision: 'adresse' } : null;
    if (!isPointInIsere(point || {})) {
      trafficGeocodeCache.set(key, null);
      return null;
    }
    trafficGeocodeCache.set(key, point);
    return point;
  } catch {
    trafficGeocodeCache.set(key, null);
    return null;
  }
}


async function geocodeClosureCommune(label) {
  const key = `closure-commune:${String(label || '').trim().toLowerCase()}`;
  const normalizedLabel = String(label || '').replace(/^mairie\s+de\s+/i, '').replace(/^commune\s+(?:de\s+)?/i, '').trim();
  if (!normalizedLabel) return null;
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(normalizedLabel)}&fields=nom,centre,codeDepartement&codeDepartement=38&boost=population&limit=1`;
    const communeResponse = await fetch(communeUrl);
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const commune = Array.isArray(communePayload) ? communePayload[0] : null;
    const center = commune?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = {
        lat: Number(center[1]),
        lon: Number(center[0]),
        precision: 'mairie',
        communeName: commune.nom || normalizedLabel,
      };
      if (isPointInIsere(point)) {
        trafficGeocodeCache.set(key, point);
        return point;
      }
    }
  } catch {
    // ignore commune geocoding issues for closure placement
  }
  trafficGeocodeCache.set(key, null);
  return null;
}

function extractItinisereLocationHints(event = {}, fullText = '', roads = []) {
  const hints = [];
  const blockedHints = new Set([
    'coupure',
    'fermeture',
    'signaler',
    'détail',
    'detail',
    'itinisère',
    'itinisere',
    'infos route',
    'perturbation',
  ]);
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = label.toLowerCase();
    if (!label || blockedHints.has(normalized)) return;
    if (/^(lieux?|signaler|d[ée]tail)\s*:?$/i.test(label)) return;
    if (!label || hints.includes(label)) return;
    hints.push(label);
  };

  const extractScopedLocationLabels = (text) => {
    const labels = [];
    const blob = String(text || '');
    const scopedMatches = [...blob.matchAll(/\b(?:localisation|lieux?)\s*:\s*([^\n.;]+)/gi)];
    scopedMatches.forEach((match) => {
      const chunk = String(match?.[1] || '').replace(/\s+/g, ' ').trim();
      if (!chunk) return;
      chunk
        .split(/[,/]|\s+-\s+/)
        .map((part) => part.replace(/^\s*(?:adresse|commune)\s*[:\-]?\s*/i, '').trim())
        .filter(Boolean)
        .forEach((part) => labels.push(part));
    });
    return labels;
  };

  extractScopedLocationLabels(`${event.description || ''} ${event.title || ''}`).forEach(pushHint);

  [event.address, event.city, ...(Array.isArray(event.addresses) ? event.addresses : []), ...(Array.isArray(event.locations) ? event.locations : [])]
    .forEach(pushHint);

  const blob = String(fullText || '');
  const cityAfterA = [...blob.matchAll(/\b(?:à|au|aux)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/g)];
  cityAfterA.forEach((match) => pushHint(match?.[1]));

  const streetMatches = [...blob.matchAll(/\b(?:rue|route|avenue|boulevard|chemin|quai|pont|échangeur|sortie)\s+[A-Z0-9À-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\- ]{2,70}/gi)];
  streetMatches.forEach((match) => pushHint(match?.[0]));

  roads.forEach((road) => {
    if (event.city) pushHint(`${road} ${event.city}`);
    if (event.address) pushHint(`${road} ${event.address}`);
  });

  return hints.slice(0, 12);
}

function extractAlertDynamicHints(fullText = '') {
  const blockedHints = new Set([
    'isère',
    'isere',
    'trafic',
    'route',
    'routes',
    'alerte',
    'info',
    'infos',
    'incident',
    'perturbation',
  ]);
  const hints = [];
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = label.toLowerCase();
    if (!label || blockedHints.has(normalized) || hints.includes(label)) return;
    hints.push(label);
  };

  const blob = String(fullText || '');
  const scopedMatches = [...blob.matchAll(/\b(?:sur|secteur|entre|vers|au niveau de)\s+([^\n.;:]+)/gi)];
  scopedMatches.forEach((match) => {
    String(match?.[1] || '')
      .split(/[,/]|\s+-\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach(pushHint);
  });

  const cityAfterA = [...blob.matchAll(/\b(?:à|au|aux)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/g)];
  cityAfterA.forEach((match) => pushHint(match?.[1]));

  return hints.slice(0, 8);
}

function extractClosureCommuneHints(event = {}, fullText = '') {
  const hints = [];
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    if (!label || hints.includes(label)) return;
    hints.push(label);
  };

  const blob = `${fullText || ''} ${event.city || ''} ${event.address || ''}`;
  TRAFFIC_COMMUNES.forEach((commune) => {
    const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(blob)) pushHint(commune);
  });

  const scopedCityMatches = [...blob.matchAll(/\b(?:commune(?:\s+de)?|mairie\s+de|[àa]u?x?)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/gi)];
  scopedCityMatches.forEach((match) => pushHint(match?.[1]));

  return hints.slice(0, 8);
}

function spreadOverlappingTrafficPoints(points = []) {
  const overlapCounters = new Map();
  return points.map((point) => {
    const key = `${Number(point.lat).toFixed(4)},${Number(point.lon).toFixed(4)}`;
    const count = overlapCounters.get(key) || 0;
    overlapCounters.set(key, count + 1);
    if (count === 0) return point;
    const angle = (count * 42) * (Math.PI / 180);
    const radius = 0.0015 + (Math.floor(count / 8) * 0.0006);
    return {
      ...point,
      lat: Number((point.lat + (Math.sin(angle) * radius)).toFixed(6)),
      lon: Number((point.lon + (Math.cos(angle) * radius)).toFixed(6)),
      precision: `${point.precision || 'estimée'} · ajustée`,
    };
  });
}

async function buildItinisereMapPoints(events = []) {
  const points = [];
  for (const event of events.slice(0, 80)) {
    const fullText = `${event.title || ''} ${event.description || ''}`;
    const roads = (Array.isArray(event.roads) && event.roads.length ? event.roads : detectRoadCodes(fullText))
      .map((road) => normalizeRoadCode(road))
      .filter(Boolean);
    const isClosureEvent = /ferm|barr|interdit|coup/.test(fullText.toLowerCase())
      || String(event.category || '').toLowerCase() === 'fermeture';
    const locationHints = extractItinisereLocationHints(event, fullText, roads);
    const dynamicAlertHints = extractAlertDynamicHints(fullText);
    const locations = Array.isArray(event.locations) ? event.locations.filter(Boolean) : locationHints;
    const communeHints = TRAFFIC_COMMUNES.filter((commune) => {
      const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${locationHints.join(' ')}`);
    });
    const candidateLocationHints = [...new Set([...locations, ...locationHints, ...dynamicAlertHints, ...communeHints])];
    let position = null;
    let anchor = '';
    let precision = 'estimée';
    let communeAnchor = null;

    if (isClosureEvent) {
      const closureCommuneHints = extractClosureCommuneHints(event, fullText);
      for (const commune of closureCommuneHints) {
        const communePoint = await geocodeClosureCommune(commune) || await geocodeTrafficLabel(commune);
        if (!communePoint) continue;
        position = { lat: communePoint.lat, lon: communePoint.lon };
        anchor = `Mairie de ${communePoint.communeName || commune}`;
        precision = 'mairie';
        break;
      }
    }

    const providedCoords = normalizeMapCoordinates(event.lat, event.lon);
    if (!isClosureEvent && providedCoords && !roads.length) {
      position = providedCoords;
      anchor = locations[0] || roads[0] || 'Itinisère';
      precision = 'source';
    }
    if (!position && providedCoords) {
      position = providedCoords;
      anchor = locations[0] || roads[0] || 'Itinisère';
      precision = 'source';
    }
    if (!position) {
      for (const location of candidateLocationHints) {
        position = await geocodeTrafficLabel(location);
        anchor = location;
        if (position) {
          precision = position.precision === 'commune' ? 'centre-ville' : (position.precision || 'localité');
          break;
        }
      }
    }

    if (!position && communeHints.length) {
      for (const commune of communeHints) {
        communeAnchor = await geocodeTrafficLabel(commune);
        if (communeAnchor) break;
      }
    }

    if (!position) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        const roadPoint = nearestPointOnCorridor(corridor, communeAnchor);
        if (!roadPoint) continue;
        position = roadPoint;
        anchor = communeHints[0] ? `${road} · ${communeHints[0]}` : `Axe ${road}`;
        precision = communeAnchor ? 'axe+commune' : 'axe';
        break;
      }
    }

    if (!position) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        position = { lat: corridor[0][0], lon: corridor[0][1] };
        anchor = `Axe ${road}`;
        precision = 'axe';
        break;
      }
    }

    if (!position) {
      for (const commune of [...communeHints, ...TRAFFIC_COMMUNES]) {
        const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${candidateLocationHints.join(' ')}`)) continue;
        position = await geocodeTrafficLabel(commune);
        anchor = commune;
        if (position) {
          precision = 'centre-ville';
          break;
        }
      }
    }

    if (!position) {
      position = await geocodeTrafficLabel((event.title || '').slice(0, 90));
      anchor = 'Localisation estimée';
    }
    if (!position) continue;

    points.push({
      ...event,
      lat: position.lat,
      lon: position.lon,
      icon: trafficMarkerIcon('itinisere', event.category, fullText),
      roads,
      anchor,
      precision,
      severity: normalizeTrafficSeverity(event.severity || (event.category === 'fermeture' ? 'rouge' : 'jaune')),
    });
  }
  return spreadOverlappingTrafficPoints(points);
}

async function renderTrafficOnMap() {
  if (!itinisereLayer || !bisonLayer || !bisonCameraLayer || !photoCameraLayer || !realtimeTrafficLayer || typeof window.L === 'undefined') return;
  const renderSequence = ++trafficRenderSequence;
  itinisereLayer.clearLayers();
  bisonLayer.clearLayers();
  bisonCameraLayer.clearLayers();
  photoCameraLayer.clearLayers();
  realtimeTrafficLayer.clearLayers();
  mapStats.traffic = 0;

  const showItinisere = document.getElementById('filter-itinisere')?.checked ?? true;
  if (showItinisere) {
    const points = await buildItinisereMapPoints(cachedItinisereEvents || []);
    if (renderSequence !== trafficRenderSequence) return;
    mapStats.traffic += points.length;
    points.forEach((point) => {
      const roadsText = point.precision === 'centre-ville' ? '' : (point.roads?.length ? `Axes détectés: ${point.roads.join(', ')}<br/>` : '');
      const locations = Array.isArray(point.locations) && point.locations.length ? point.locations.join(', ') : point.anchor;
      const icon = trafficMarkerIcon('itinisere', point.category, `${point.title || ''} ${point.description || ''}`);
      const marker = window.L.marker([point.lat, point.lon], { icon: itinisereDivIcon(point) });
      marker.bindPopup(`<strong>${escapeHtml(icon)} ${escapeHtml(point.title || 'Évènement Itinisère')}</strong><br/><span class="badge neutral">${escapeHtml(point.category || 'trafic')} · ${escapeHtml(point.severity || 'jaune')}</span><br/>${escapeHtml(point.description || '')}<br/>Localisation: ${escapeHtml(locations || 'Commune Isère')} (${escapeHtml(point.precision || 'estimée')})<br/>${roadsText}<a href="${escapeHtml(point.link || '#')}" target="_blank" rel="noreferrer">Détail Itinisère</a>`);
      marker.addTo(itinisereLayer);
    });
  }

  const showBisonAccidents = document.getElementById('filter-bison-accidents')?.checked ?? true;
  if (showBisonAccidents) {
    if (renderSequence !== trafficRenderSequence) return;
    const incidents = Array.isArray(cachedRealtimeTraffic?.incidents) ? cachedRealtimeTraffic.incidents : [];
    const bisonAccidents = incidents.filter((incident) => isAccidentIncident(incident) && isIncidentInIsere(incident));
    bisonAccidents.forEach((incident) => {
      const coords = normalizeMapCoordinates(incident.lat, incident.lon);
      const popupHtml = `<strong>💥 ${escapeHtml(incident.title || 'Accident en cours')}</strong><br/>${escapeHtml(incident.description || '')}<br/><span class="badge red">Bison Futé · accident</span>`;
      const pointIcon = emojiDivIcon('💥', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      let markerPlaced = false;
      if (coords) {
        window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonLayer);
        markerPlaced = true;
      }
      if (Array.isArray(incident.line) && incident.line.length > 1) {
        const lineLatLng = incident.line
          .map((point) => normalizeMapCoordinates(point.lat, point.lon))
          .filter(Boolean)
          .map((point) => [point.lat, point.lon]);
        if (lineLatLng.length > 1) {
          if (!markerPlaced) {
            const midPoint = lineLatLng[Math.floor(lineLatLng.length / 2)];
            if (midPoint) window.L.marker(midPoint, { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonLayer);
          }
          window.L.polyline(lineLatLng, { color: '#d9480f', weight: 4, opacity: 0.7 }).bindPopup(popupHtml).addTo(bisonLayer);
        }
      }
    });
    mapStats.traffic += bisonAccidents.length;
  }

  const showBisonCameras = document.getElementById('filter-bison-cameras')?.checked ?? true;
  if (showBisonCameras) {
    BISON_FUTE_CAMERAS.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = cameraPopupMarkup(camera);
      const pointIcon = emojiDivIcon('🎥', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonCameraLayer);
    });
    mapStats.traffic += BISON_FUTE_CAMERAS.length;
  }

  const showPhotoCameras = document.getElementById('filter-photo-cameras')?.checked ?? true;
  if (showPhotoCameras) {
    ITINISERE_PHOTO_CAMERAS.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = photoCameraPopupMarkup(camera);
      const pointIcon = emojiDivIcon('📷', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(photoCameraLayer);
    });
    mapStats.traffic += ITINISERE_PHOTO_CAMERAS.length;
  }

  const showWazeClosedRoads = document.getElementById('filter-waze-closed-roads')?.checked ?? true;
  if (showWazeClosedRoads) {
    if (renderSequence !== trafficRenderSequence) return;
    const incidents = Array.isArray(cachedRealtimeTraffic?.incidents) ? cachedRealtimeTraffic.incidents : [];
    const filteredIncidents = incidents.filter((incident) => incident.subtype === 'road_closed' && isIncidentInIsere(incident));
    filteredIncidents.forEach((incident) => {
      const popupHtml = `<strong>⛔ ${escapeHtml(incident.title || 'Route fermée')}</strong><br/>${escapeHtml(incident.description || '')}<br/><span class="badge neutral">fermeture · rouge</span>`;
      const pointIcon = emojiDivIcon('⛔', { className: 'map-emoji-icon--traffic-closed', iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10] });
      const coords = normalizeMapCoordinates(incident.lat, incident.lon);
      let markerPlaced = false;
      if (coords) {
        window.L.marker([coords.lat, coords.lon], { icon: pointIcon })
          .bindPopup(popupHtml)
          .addTo(realtimeTrafficLayer);
        markerPlaced = true;
      }
      if (Array.isArray(incident.line) && incident.line.length > 1) {
        const lineLatLng = incident.line
          .map((point) => normalizeMapCoordinates(point.lat, point.lon))
          .filter(Boolean)
          .map((point) => [point.lat, point.lon]);
        if (lineLatLng.length > 1) {
          if (!markerPlaced) {
            const midPoint = lineLatLng[Math.floor(lineLatLng.length / 2)];
            if (midPoint) {
              window.L.marker(midPoint, { icon: pointIcon }).bindPopup(popupHtml).addTo(realtimeTrafficLayer);
            }
          }
          window.L.polyline(lineLatLng, { color: trafficLevelColor('rouge'), weight: 5, opacity: 0.75 })
            .bindPopup(popupHtml)
            .addTo(realtimeTrafficLayer);
        }
      }

    });
    mapStats.traffic += filteredIncidents.length;
  }

  updateMapSummary();
}

function renderMapIconSuggestions(category = 'autre') {
  const container = document.getElementById('map-icon-suggestions');
  if (!container) return;
  const icons = MAP_ICON_SUGGESTIONS[category] || MAP_ICON_SUGGESTIONS.autre;
  setHtml('map-icon-suggestions', `${icons
    .map((icon) => `<button type="button" class="ghost inline-action map-icon-chip" data-map-icon="${escapeHtml(icon)}">${escapeHtml(icon)}</button>`)
    .join('')}<span class="muted">ou saisissez votre emoji.</span>`);
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

  mapPoints = loadedPoints
    .map((point) => {
      const coords = normalizeMapCoordinates(point.lat, point.lon);
      if (!coords) return null;
      return { ...point, lat: coords.lat, lon: coords.lon };
    })
    .filter(Boolean);
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
    .map((point) => {
      const pointIcon = point.icon_url ? '🖼️' : (point.icon || iconForCategory(point.category));
      return `<li><strong>${escapeHtml(pointIcon)} ${escapeHtml(point.name)}</strong> · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} <button type="button" data-remove-point="${point.id}">Supprimer</button></li>`;
    })
    .join('') || '<li>Aucun point personnalisé.</li>';
  setHtml('custom-points-list', listMarkup);

  mapStats.custom = filteredPoints.length;
  updateMapSummary();
  if (!mapPointsLayer) return;
  filteredPoints.forEach((point) => {
    const marker = window.L.marker([point.lat, point.lon], { icon: markerIconForPoint(point) });
    const popupIcon = point.icon_url ? '🖼️' : (point.icon || iconForCategory(point.category));
    marker.bindPopup(`<strong>${escapeHtml(popupIcon)} ${escapeHtml(point.name)}</strong><br/>Catégorie: ${escapeHtml(point.category)}${point.icon_url ? '<br/>Type: POI avec icône personnalisée' : ''}<br/>${escapeHtml(point.notes || 'Sans note')}`);
    marker.addTo(mapPointsLayer);
  });
  if (showFeedback) setMapFeedback(`${filteredPoints.length} marqueur(s) opérationnel(s)/POI affiché(s).`);
}

function onMapClickAddPoint(event) {
  if (!mapAddPointMode) return;
  pendingMapPointCoords = event.latlng;
  openMapPointModal('poi');
}

function openMapPointModal(defaultCategory = 'autre') {
  const modal = document.getElementById('map-point-modal');
  if (!modal) return;
  const form = document.getElementById('map-point-form');
  if (form) {
    form.reset();
    form.elements.namedItem('category').value = defaultCategory;
    form.elements.namedItem('name').value = `Point ${new Date().toLocaleTimeString()}`;
    form.elements.namedItem('icon').value = iconForCategory(defaultCategory);
    form.elements.namedItem('icon_url').value = '';
    mapIconTouched = false;
    renderMapIconSuggestions(defaultCategory);
  }
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', 'open');
}
function renderMeteoAlerts(meteo = {}) {
  const current = meteo.current_alerts || [];
  const tomorrow = meteo.tomorrow_alerts || [];
  const alertDetailMarkup = (alert = {}) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).filter(Boolean);
    const detailsText = ['orange', 'rouge'].includes(level) && details.length
      ? `<br><span class="meteo-detail">${details.map((detail) => escapeHtml(detail)).join('<br>')}</span>`
      : '';
    const label = ({ vert: 'Vert', jaune: 'Jaune', orange: 'Orange', rouge: 'Rouge' })[level] || level;
    return `<li><strong>${escapeHtml(alert.phenomenon || '-')}</strong> · <span class="meteo-alert-level ${level}">${label}</span>${detailsText}</li>`;
  };
  const section = (title, alerts) => `<li><strong>${title}</strong><ul>${alerts.map((alert) => alertDetailMarkup(alert)).join('') || '<li>Aucune alerte significative.</li>'}</ul></li>`;
  setHtml('meteo-alerts-list', `${section('En cours (J0)', current)}${section('Demain (J1)', tomorrow)}`);
}

function renderItinisereEvents(events = [], targetId = 'itinerary-list') {
  cachedItinisereEvents = Array.isArray(events) ? events : [];
  const target = document.getElementById(targetId);
  if (!target) return;
  setHtml(targetId, events.slice(0, 20).map((e) => {
    const title = escapeHtml(e.title || 'Évènement');
    const description = escapeHtml(e.description || '');
    const safeLink = String(e.link || '').startsWith('http') ? e.link : '#';
    const mapQuery = escapeHtml(e.title || '').replace(/"/g, '&quot;');
    const category = escapeHtml(e.category || 'trafic');
    const severity = normalizeTrafficSeverity(e.severity || 'jaune');
    const roads = Array.isArray(e.roads) && e.roads.length ? ` · Axes: ${escapeHtml(e.roads.join(', '))}` : '';
    const locations = Array.isArray(e.locations) && e.locations.length ? ` · Lieux: ${escapeHtml(e.locations.slice(0, 3).join(', '))}` : '';
    const period = e.period_start || e.period_end ? `<br><span class="muted">Période: ${escapeHtml(e.period_start || '?')} → ${escapeHtml(e.period_end || '?')}</span>` : '';
    return `<li><strong>${title}</strong> <span class="badge neutral">${category} · ${severity}</span>${roads}${locations}<br>${description}${period}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Détail</a><br><button type="button" class="ghost inline-action" data-map-query="${mapQuery}">Voir sur la carte</button></li>`;
  }).join('') || '<li>Aucune perturbation publiée.</li>');
}



function sortPrefectureItemsByRecency(items = []) {
  const toTimestamp = (value) => {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...items].sort((a, b) => toTimestamp(b?.published_at) - toTimestamp(a?.published_at));
}

function renderPrefectureNews(prefecture = {}) {
  const items = sortPrefectureItemsByRecency(Array.isArray(prefecture.items) ? prefecture.items : []);
  const latestTitle = items[0]?.title || "Actualité Préfecture de l'Isère";
  setText('prefecture-news-title', latestTitle);
  setText('prefecture-status', `${prefecture.status || 'inconnu'} · ${items.length} actualité(s)`);
  setText('prefecture-info', `Dernière mise à jour: ${prefecture.updated_at ? new Date(prefecture.updated_at).toLocaleString() : 'inconnue'}`);
  setHtml('prefecture-news-list', items.slice(0, 6).map((item) => {
    const title = escapeHtml(item.title || 'Actualité Préfecture');
    const description = escapeHtml(item.description || '');
    const published = item.published_at ? escapeHtml(item.published_at) : 'Date non précisée';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.isere.gouv.fr';
    return `<li><strong>${title}</strong><br><span class="muted">${published}</span>${description ? `<br>${description}` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'actualité</a></li>`;
  }).join('') || '<li>Aucune actualité disponible pour le moment.</li>');
}

function sanitizeMeteoInformation(info = '') {
  const text = String(info || '').trim();
  const unwanted = "Consultez la carte de Vigilance de Météo-France sur l'ISERE (38) : Information sur les risques météorologiques de la journée en cours.";
  if (text === unwanted) return '';
  return text;
}

function renderBisonFuteSummary(bison = {}) {
  cachedBisonFute = bison || {};
  const today = bison.today || {};
  const tomorrow = bison.tomorrow || {};
  const isereToday = today.isere || {};
  const isereTomorrow = tomorrow.isere || {};
  const nationalToday = today.national || {};
  const nationalTomorrow = tomorrow.national || {};
  const accidents = (Array.isArray(cachedRealtimeTraffic?.incidents) ? cachedRealtimeTraffic.incidents : [])
    .filter((incident) => isAccidentIncident(incident) && isIncidentInIsere(incident));

  setText('bison-status', `${bison.status || 'inconnu'} · Isère départ ${isereToday.departure || 'inconnu'} / retour ${isereToday.return || 'inconnu'} · ${accidents.length} accident(s) en cours`);
  setText('bison-info', `National J0: ${nationalToday.departure || 'inconnu'} / ${nationalToday.return || 'inconnu'} · J1: ${nationalTomorrow.departure || 'inconnu'} / ${nationalTomorrow.return || 'inconnu'}`);
  setText('map-bison-isere', `${isereToday.departure || 'inconnu'} (retour ${isereToday.return || 'inconnu'})`);
  setText('home-feature-bison-isere', `${isereToday.departure || 'inconnu'} / ${isereToday.return || 'inconnu'}`);

  const bisonMarkup = [
    `<li><strong>Aujourd'hui (${today.date || '-'})</strong><br>Isère départ: ${isereToday.departure || 'inconnu'} · Isère retour: ${isereToday.return || 'inconnu'}<br>National départ: ${nationalToday.departure || 'inconnu'} · National retour: ${nationalToday.return || 'inconnu'}<br><a href="https://www.bison-fute.gouv.fr" target="_blank" rel="noreferrer">Voir la carte Bison Futé</a></li>`,
    `<li><strong>Demain (${tomorrow.date || '-'})</strong><br>Isère départ: ${isereTomorrow.departure || 'inconnu'} · Isère retour: ${isereTomorrow.return || 'inconnu'}<br>National départ: ${nationalTomorrow.departure || 'inconnu'} · National retour: ${nationalTomorrow.return || 'inconnu'}</li>`,
    `<li><strong>Accidents en cours (Isère)</strong><br>${accidents.length ? `${accidents.length} signalement(s) actifs` : 'Aucun accident signalé pour le moment'}</li>`,
  ].join('');
  setHtml('bison-list', bisonMarkup);
}

function renderHomeMeteoSituation(situations = []) {
  const markup = situations.map((item) => `<li>${item.label}: <strong>${normalizeLevel(item.level)}</strong></li>`).join('') || '<li>Aucune vigilance significative en cours.</li>';
  setHtml('home-meteo-situation', markup);
}

function georisquesDangerLevel(commune = {}) {
  const seismicMatch = String(commune.seismic_zone || commune.zone_sismicite || '').match(/(\d+)/);
  const seismic = Number(seismicMatch?.[1] || 0);
  const flood = Number(commune.flood_documents || commune.nb_documents || 0);
  const ppr = Number(commune.ppr_total || 0);
  const movements = Number(commune.ground_movements_total || 0);
  const radonClass = Number(commune.radon_class || 0);
  let score = 0;
  if (seismic >= 3) score += 2;
  else if (seismic >= 2) score += 1;
  if (flood > 0) score += 1;
  if (ppr >= 3) score += 2;
  else if (ppr > 0) score += 1;
  if (movements >= 3) score += 2;
  else if (movements > 0) score += 1;
  if (radonClass >= 3) score += 2;
  else if (radonClass >= 2) score += 1;

  if (score >= 7) return { label: 'Très élevé', css: 'tres-eleve' };
  if (score >= 5) return { label: 'Élevé', css: 'eleve' };
  if (score >= 3) return { label: 'Modéré', css: 'modere' };
  return { label: 'Faible', css: 'faible' };
}

function renderGeorisquesPcsRisks(monitored = []) {
  const pcsByName = new Map(
    cachedMunicipalities
      .filter((municipality) => municipality?.pcs_active)
      .map((municipality) => [String(municipality.name || '').trim().toLowerCase(), municipality]),
  );

  const pcsMonitored = monitored
    .filter((commune) => pcsByName.has(String(commune.name || commune.commune || '').trim().toLowerCase()))
    .sort((a, b) => {
      const levelA = georisquesDangerLevel(a);
      const levelB = georisquesDangerLevel(b);
      const rank = { 'Très élevé': 4, 'Élevé': 3, 'Modéré': 2, 'Faible': 1 };
      return rank[levelB.label] - rank[levelA.label];
    });

  const markup = pcsMonitored.map((commune) => {
    const danger = georisquesDangerLevel(commune);
    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> <span class="danger-chip ${danger.css}">${danger.label}</span><br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Inondation: <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · PPR: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong></li>`;
  }).join('') || '<li>Aucune commune PCS active avec détails Géorisques.</li>';

  setHtml('georisques-pcs-risks-list', markup);
}

function switchGeorisquesTab(tab = 'overview') {
  const isOverview = tab !== 'pcs';
  document.getElementById('georisques-overview-section')?.toggleAttribute('hidden', !isOverview);
  document.getElementById('georisques-overview-section')?.classList.toggle('hidden', !isOverview);
  document.getElementById('georisques-pcs-section')?.toggleAttribute('hidden', isOverview);
  document.getElementById('georisques-pcs-section')?.classList.toggle('hidden', isOverview);
  document.getElementById('georisques-tab-overview')?.classList.toggle('is-active', isOverview);
  document.getElementById('georisques-tab-pcs')?.classList.toggle('is-active', !isOverview);
  document.getElementById('georisques-tab-overview')?.setAttribute('aria-selected', isOverview ? 'true' : 'false');
  document.getElementById('georisques-tab-pcs')?.setAttribute('aria-selected', isOverview ? 'false' : 'true');
}

function renderGeorisquesDetails(georisques = {}) {
  const monitored = georisques.monitored_communes || georisques.monitored_municipalities || georisques.communes || [];
  const errorDetails = Array.isArray(georisques.errors) ? georisques.errors.filter(Boolean) : [];
  const movementTypes = georisques.movement_types && typeof georisques.movement_types === 'object' ? georisques.movement_types : {};
  const recentMovements = Array.isArray(georisques.recent_ground_movements) ? georisques.recent_ground_movements : [];
  const radonDistribution = georisques.radon_distribution && typeof georisques.radon_distribution === 'object' ? georisques.radon_distribution : null;

  setText('georisques-page-status', georisques.status || 'inconnu');
  setText('georisques-page-seismic', georisques.highest_seismic_zone_label || 'inconnue');
  setText('georisques-page-flood-docs', String(georisques.flood_documents_total ?? 0));
  setText('georisques-page-ppr-total', String(georisques.ppr_total ?? 0));
  setText('georisques-page-ground-movements', String(georisques.ground_movements_total ?? 0));
  setText('georisques-page-cavities', String(georisques.cavities_total ?? 0));
  setText('georisques-page-radon-alert', String(georisques.communes_with_radon_moderate_or_high ?? 0));
  setText('georisques-page-api-mode', georisques.api_mode || 'auto');

  const sourceText = `Source: ${georisques.source || 'inconnue'} · Dernière mise à jour: ${georisques.updated_at ? new Date(georisques.updated_at).toLocaleString() : 'inconnue'}`;
  const errorsText = errorDetails.length ? ` · Anomalies: ${errorDetails.join(' | ')}` : '';
  const radonText = radonDistribution ? ` · Radon (faible/moyen/élevé): ${Number(radonDistribution.faible || 0)}/${Number(radonDistribution.moyen || 0)}/${Number(radonDistribution.eleve || 0)}` : '';
  const pprCategories = georisques.ppr_categories && typeof georisques.ppr_categories === 'object' ? georisques.ppr_categories : null;
  const pprText = pprCategories ? ` · PPR (N/M/T): ${Number(pprCategories.pprn || 0)}/${Number(pprCategories.pprm || 0)}/${Number(pprCategories.pprt || 0)}` : '';
  const preventionText = ` · DICRIM: ${Number(georisques.dicrim_total || 0)} · TIM: ${Number(georisques.tim_total || 0)} · Info-risques: ${Number(georisques.risques_information_total || 0)}`;
  setText('georisques-page-source', `${sourceText}${radonText}${pprText}${preventionText}${errorsText}`);
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

    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> (${escapeHtml(commune.code_insee || commune.insee || '-')})<br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Radon: <strong>${escapeHtml(commune.radon_label || 'inconnu')}</strong><br>Inondation (AZI): <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · PPR: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong> · Cavités: <strong>${Number(commune.cavities_total || 0)}</strong><br>DICRIM: <strong>${escapeHtml(commune.dicrim_publication_year || 'non renseigné')}</strong> · TIM: <strong>${Number(commune.tim_total || 0)}</strong> · Info-risques: <strong>${Number(commune.risques_information_total || 0)}</strong><br>PPR par risque: ${pprText}${communeErrors.length ? `<br><span class="muted">Anomalies commune: ${escapeHtml(communeErrors.join(' | '))}</span>` : ''}<br>${docsMarkup}</li>`;
  }).join('') || '<li>Aucune commune remontée par Géorisques.</li>';
  setHtml('georisques-communes-list', markup);
  renderGeorisquesPcsRisks(monitored);

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
    setHtml('municipality-document-preview', municipalityPreviewMarkup(contentType || '', objectUrl));
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

  setHtml('municipality-details-content', `
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
  `);

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

function safeDateToLocale(value, options = {}) {
  const timestamp = new Date(value || 0);
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0
    ? timestamp.toLocaleString('fr-FR', options)
    : '-';
}

function buildSituationLogMarkup(log = {}) {
  const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
  const at = safeDateToLocale(log.event_time || log.created_at || Date.now());
  const scope = formatLogScope(log);
  const icon = log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢';
  return `<li><strong>${at}</strong> · <span class="badge neutral">${status}</span> · <span class="badge neutral">${scope}</span><br>${icon} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'Évènement')}</strong> · ${escapeHtml(log.description || '')}</li>`;
}

function buildCriticalRisksMarkup(dashboard = {}, externalRisks = {}) {
  const risks = [];
  const meteo = externalRisks?.meteo_france || {};
  const criticalLevels = new Set(['orange', 'rouge']);
  const currentAlerts = (meteo.current_alerts || []).filter((alert) => criticalLevels.has(normalizeLevel(alert.level)));

  currentAlerts.forEach((alert) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).filter(Boolean);
    const detailsText = details.length ? `<br>${details.map((detail) => escapeHtml(detail)).join('<br>')}` : '';
    risks.push(`<li><strong>${escapeHtml(alert.phenomenon || 'Phénomène météo')}</strong> · <span class="risk-${level}">${level}</span>${detailsText}</li>`);
  });

  const itinisereEvents = externalRisks?.itinisere?.events || [];
  const bisonIsere = externalRisks?.bison_fute?.today?.isere || {};
  const georisques = externalRisks?.georisques?.data && typeof externalRisks.georisques.data === 'object'
    ? { ...externalRisks.georisques.data, ...externalRisks.georisques }
    : (externalRisks?.georisques || {});

  risks.push(`<li><strong>Itinisère</strong> · ${(itinisereEvents || []).length} événement(s) actif(s) · Statut ${escapeHtml(externalRisks?.itinisere?.status || 'inconnu')}</li>`);
  risks.push(`<li><strong>Bison Futé</strong> · Départs ${escapeHtml(bisonIsere.departure || 'inconnu')} · Retours ${escapeHtml(bisonIsere.return || 'inconnu')}</li>`);
  risks.push(`<li><strong>Géorisques</strong> · Sismicité ${escapeHtml(georisques.highest_seismic_zone_label || 'inconnue')} · ${Number(georisques.flood_documents_total ?? 0)} document(s) inondation</li>`);

  const fromDashboard = Array.isArray(dashboard?.latest_logs) ? dashboard.latest_logs : [];
  const criticalLogs = fromDashboard.filter((log) => ['orange', 'rouge'].includes(normalizeLevel(log.danger_level)));
  if (criticalLogs.length) {
    risks.unshift(`<li><strong>Main courante</strong> · ${criticalLogs.length} évènement(s) critique(s) orange/rouge.</li>`);
  }

  return risks.join('') || '<li>Aucun risque critique détecté.</li>';
}

function renderSituationOverview() {
  const target = document.getElementById('situation-content');
  if (!target) return;

  const dashboard = cachedDashboardSnapshot && Object.keys(cachedDashboardSnapshot).length
    ? cachedDashboardSnapshot
    : (readSnapshot(STORAGE_KEYS.dashboardSnapshot) || {});
  const externalRisks = cachedExternalRisksSnapshot && Object.keys(cachedExternalRisksSnapshot).length
    ? cachedExternalRisksSnapshot
    : (readSnapshot(STORAGE_KEYS.externalRisksSnapshot) || {});

  const vigilance = normalizeLevel(dashboard.vigilance || externalRisks?.meteo_france?.level || 'vert');
  const crues = normalizeLevel(dashboard.crues || externalRisks?.vigicrues?.water_alert_level || 'vert');
  const globalRisk = normalizeLevel(dashboard.global_risk || vigilance);
  const crisisCount = Number(dashboard.communes_crise ?? 0);

  const logs = Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs : (Array.isArray(cachedLogs) ? cachedLogs.slice(0, 8) : []);
  const openLogs = logs.filter((log) => String(log.status || '').toLowerCase() !== 'clos');
  const closedLogs = logs.filter((log) => String(log.status || '').toLowerCase() === 'clos');
  const prefectureItems = Array.isArray(externalRisks?.prefecture_isere?.items)
    ? sortPrefectureItemsByRecency(externalRisks.prefecture_isere.items).slice(0, 4)
    : [];
  const kpiCards = [
    { label: 'Vigilance météo', value: vigilance, info: 'Source Météo-France', css: normalizeLevel(vigilance) },
    { label: 'Niveau crues', value: crues, info: 'Source Vigicrues', css: normalizeLevel(crues) },
    { label: 'Risque global', value: globalRisk, info: 'Calcul consolidé', css: normalizeLevel(globalRisk) },
    { label: 'Communes en crise', value: String(crisisCount), info: 'PCS actif', css: crisisCount > 0 ? 'rouge' : 'vert' },
  ];

  setHtml('situation-content', `
    <div class="situation-top-grid">
      ${kpiCards.map((card) => `<article class="tile situation-tile"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${card.info}</p></article>`).join('')}
    </div>

    <div class="situation-middle-grid">
      <article class="tile situation-summary">
        <h3>Dernières informations Préfecture</h3>
        <ul class="list compact">
          ${prefectureItems.map((item) => {
            const title = escapeHtml(item.title || 'Actualité Préfecture');
            const published = item.published_at ? escapeHtml(item.published_at) : '';
            const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.isere.gouv.fr';
            return `<li><strong>${title}</strong>${published ? `<br><span class="muted">${published}</span>` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'actualité</a></li>`;
          }).join('') || '<li>Aucune actualité Préfecture disponible.</li>'}
        </ul>
      </article>
      <article class="tile situation-risks">
        <h3>Risques en cours (orange / rouge)</h3>
        <ul class="list compact">${buildCriticalRisksMarkup(dashboard, externalRisks)}</ul>
      </article>
    </div>

    <h3>Fil de situation</h3>
    <div class="situation-log-columns">
      <div>
        <h4>Crises en cours</h4>
        <ul class="list">${openLogs.slice(0, 8).map((log) => buildSituationLogMarkup(log)).join('') || '<li>Aucune crise en cours.</li>'}</ul>
      </div>
      <div>
        <h4>Crises clôturées</h4>
        <ul class="list">${closedLogs.slice(0, 8).map((log) => buildSituationLogMarkup(log)).join('') || '<li>Aucune crise clôturée récente.</li>'}</ul>
      </div>
    </div>
  `);
}

function renderDashboard(dashboard = {}) {
  cachedDashboardSnapshot = dashboard && typeof dashboard === 'object' ? dashboard : {};
  renderSituationOverview();
}

async function loadDashboard() {
  const cached = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (cached) renderDashboard(cached);
  else renderSituationOverview();

  try {
    const dashboard = await api('/dashboard');
    renderDashboard(dashboard);
    saveSnapshot(STORAGE_KEYS.dashboardSnapshot, dashboard);
  } catch (error) {
    if (cached) {
      document.getElementById('dashboard-error').textContent = `tableau de bord (cache): ${sanitizeErrorMessage(error.message)}`;
      return;
    }
    throw error;
  }
}

function renderExternalRisks(data = {}) {
  cachedExternalRisksSnapshot = data && typeof data === 'object' ? data : {};
  const meteo = data?.meteo_france || {};
  const vigicrues = data?.vigicrues || {};
  const itinisere = data?.itinisere || {};
  const bisonFute = data?.bison_fute || {};
  const realtimeTraffic = data?.waze || {};
  cachedRealtimeTraffic = realtimeTraffic || {};
  const prefecture = data?.prefecture_isere || {};
  const georisquesPayload = data?.georisques || {};
  const georisques = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
    ? { ...georisquesPayload.data, ...georisquesPayload }
    : georisquesPayload;

  setRiskText('meteo-status', `${meteo.status || 'inconnu'} · niveau ${normalizeLevel(meteo.level || 'inconnu')}`, meteo.level || 'vert');
  setText('meteo-info', sanitizeMeteoInformation(meteo.info_state) || meteo.bulletin_title || '');
  setRiskText('vigicrues-status', `${vigicrues.status || 'inconnu'} · niveau ${normalizeLevel(vigicrues.water_alert_level || 'inconnu')}`, vigicrues.water_alert_level || 'vert');
  setText('vigicrues-info', `${(vigicrues.stations || []).length} station(s) suivie(s)`);
  setHtml('stations-list', (vigicrues.stations || []).slice(0, 10).map((s) => {
    const statusLevel = stationStatusLevel(s);
    return `<li>${s.station || s.code} · ${s.river || ''} · <span style="color:${levelColor(statusLevel)}">${statusLevel}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`;
  }).join('') || '<li>Aucune station disponible.</li>');
  const itinisereEvents = itinisere.events || [];
  const itinisereTotal = Number(itinisere.events_total ?? itinisereEvents.length);
  setText('itinisere-status', `${itinisere.status || 'inconnu'} · ${itinisereTotal} événements`);
  renderBisonFuteSummary(bisonFute);
  renderPrefectureNews(prefecture);
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} AZI · ${georisques.ppr_total ?? 0} PPR · ${georisques.ground_movements_total ?? 0} mouvements`);
  renderGeorisquesDetails(georisques);
  renderMeteoAlerts(meteo);
  renderItinisereEvents(itinisereEvents);
  setText('meteo-level', normalizeLevel(meteo.level || 'vert'));
  setText('meteo-hazards', (meteo.hazards || []).join(', ') || 'non précisé');
  setText('river-level', normalizeLevel(vigicrues.water_alert_level || 'vert'));
  const itinisereInsights = itinisere.insights || {};
  const topRoads = (itinisereInsights.top_roads || []).map((item) => `${item.road} (${item.count})`).join(', ');
  const severityBreakdown = itinisereInsights.severity_breakdown || {};
  const preciseLocations = itinisereEvents.filter((event) => Array.isArray(event.locations) && event.locations.length).length;
  setText('map-itinisere-category', itinisereInsights.dominant_category || 'inconnue');
  setText('map-itinisere-roads', topRoads || 'non renseigné');
  setText('map-itinisere-severity', `R${severityBreakdown.rouge || 0} / O${severityBreakdown.orange || 0} / J${severityBreakdown.jaune || 0} / V${severityBreakdown.vert || 0}`);
  setText('map-itinisere-precision', `${preciseLocations}/${itinisereEvents.length || 0} avec lieu identifié`);
  setText('map-seismic-level', georisques.highest_seismic_zone_label || 'inconnue');
  setText('map-flood-docs', String(georisques.flood_documents_total ?? 0));
  renderStations(vigicrues.stations || []);
  renderSituationOverview();
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
    { key: 'itinisere', label: 'Itinisère', level: `${data.itinisere?.events_total ?? (data.itinisere?.events || []).length} événement(s)`, details: data.itinisere?.source || '-' },
    { key: 'bison_fute', label: 'Bison Futé', level: data.bison_fute?.today?.isere?.departure || 'inconnu', details: data.bison_fute?.source || '-' },
    { key: 'waze', label: 'Trafic temps réel (Waze)', level: `${data.waze?.incidents_total || 0} incident(s)`, details: data.waze?.source || '-' },
    { key: 'georisques', label: 'Géorisques', level: data.georisques?.highest_seismic_zone_label || 'inconnue', details: `${data.georisques?.flood_documents_total ?? 0} document(s) inondation` },
    { key: 'prefecture_isere', label: "Préfecture Isère · Actualités", level: `${(data.prefecture_isere?.items || []).length} actualité(s)`, details: data.prefecture_isere?.source || '-' },
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
  lastApiResyncAt = data.updated_at || new Date().toISOString();
  renderApiResyncClock();
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

function renderMunicipalitiesList(municipalities = []) {
  const municipalitiesMarkup = municipalities.map((m) => {
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

  setText('municipalities-count', String(municipalities.length));
  setHtml('municipalities-list', municipalitiesMarkup);
}

function applyMunicipalityFilters() {
  const search = String(document.getElementById('municipalities-search')?.value || '').trim().toLowerCase();
  const statusFilter = String(document.getElementById('municipalities-status-filter')?.value || 'all');
  const sort = String(document.getElementById('municipalities-sort')?.value || 'name_asc');

  let filtered = [...cachedMunicipalityRecords];

  if (statusFilter === 'crisis') filtered = filtered.filter((item) => Boolean(item.crisis_mode));
  if (statusFilter === 'watch') filtered = filtered.filter((item) => !item.crisis_mode);

  if (search) {
    filtered = filtered.filter((item) => [
      item.name,
      item.manager,
      item.phone,
      item.email,
      item.postal_code,
      item.contacts,
      item.additional_info,
      item.radio_channel,
    ].map((value) => String(value || '').toLowerCase()).join(' ').includes(search));
  }

  filtered.sort((a, b) => {
    if (sort === 'risk_desc') return riskRank(b.vigilance_color) - riskRank(a.vigilance_color);
    if (sort === 'population_desc') return Number(b.population || 0) - Number(a.population || 0);
    return String(a.name || '').localeCompare(String(b.name || ''), 'fr');
  });

  renderMunicipalitiesList(filtered);
}

async function loadMunicipalities(preloaded = null) {
  let municipalities = [];
  if (Array.isArray(preloaded)) {
    municipalities = preloaded;
    localStorage.setItem(STORAGE_KEYS.municipalitiesCache, JSON.stringify(municipalities));
  } else {
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
  }

  cachedMunicipalityRecords = municipalities;
  cachedMunicipalities = municipalities;
  populateLogMunicipalityOptions(municipalities);
  syncLogScopeFields();
  syncLogOtherFields();
  applyMunicipalityFilters();
  await renderMunicipalitiesOnMap(municipalities);
}

function computeLogCriticality(level) {
  return riskRank(level);
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

async function loadLogs(preloaded = null) {
  const logs = Array.isArray(preloaded) ? preloaded : await api('/logs');
  cachedLogs = Array.isArray(logs) ? logs : [];
  renderLogsList();
  renderSituationOverview();
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

async function loadUsers(preloaded = null) {
  if (!canManageUsers()) return;
  const users = Array.isArray(preloaded) ? preloaded : await api('/auth/users');
  const isAdmin = currentUser?.role === 'admin';
  setHtml('users-table', users.map((u) => {
    const actionButtons = isAdmin
      ? `<div class="users-actions"><button type="button" data-user-edit="${u.id}">Modifier</button><button type="button" data-user-reset="${u.id}">Réinitialiser mot de passe</button><button type="button" class="ghost" data-user-delete="${u.id}">Supprimer</button></div>`
      : '-';
    return `<tr><td>${escapeHtml(u.username)}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.municipality_name || '-')}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td><td>${actionButtons}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Aucun utilisateur.</td></tr>');
}

async function loadOperationsBootstrap(forceRefresh = false) {
  const suffix = forceRefresh ? '?refresh=true' : '';
  const payload = await api(`/operations/bootstrap${suffix}`, { cacheTtlMs: 5000 });
  if (!payload || typeof payload !== 'object') throw new Error('Réponse bootstrap invalide');

  if (payload.dashboard) {
    renderDashboard(payload.dashboard);
    saveSnapshot(STORAGE_KEYS.dashboardSnapshot, payload.dashboard);
  }
  if (payload.external_risks) {
    renderExternalRisks(payload.external_risks);
    renderApiInterconnections(payload.external_risks);
    saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, payload.external_risks);
    saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, payload.external_risks);
  }

  await loadMunicipalities(payload.municipalities || []);
  await loadLogs(payload.logs || []);
  if (canManageUsers()) await loadUsers(payload.users || []);

  const perf = payload.perf || {};
  const duration = Number(perf.backend_duration_ms || 0);
  const countM = Number(perf.municipality_count || (payload.municipalities || []).length || 0);
  const countL = Number(perf.log_count || (payload.logs || []).length || 0);
  setText('operations-perf', `Perf: ${duration} ms · ${countM} communes · ${countL} événements`);
  return payload;
}

async function refreshAll(forceRefresh = false) {
  return withPreservedScroll(async () => {
    try {
      await loadOperationsBootstrap(forceRefresh);
      await loadMapPoints();
      await renderTrafficOnMap();
      renderResources();
      document.getElementById('dashboard-error').textContent = '';
      return;
    } catch (bootstrapError) {
      setText('operations-perf', 'Perf: mode dégradé (chargement par modules)');
      const loaders = [
        { label: 'tableau de bord', loader: loadDashboard, optional: true },
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

      if (!blockingFailures.length) {
        const errorTarget = document.getElementById('dashboard-error');
        if (errorTarget && !errorTarget.textContent.trim()) {
          const warning = optionalFailures.length
            ? `Modules secondaires indisponibles: ${optionalFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ')}`
            : '';
          errorTarget.textContent = warning || `Bootstrap indisponible: ${sanitizeErrorMessage(bootstrapError.message)}`;
        }
        return;
      }

      const message = blockingFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ');
      document.getElementById('dashboard-error').textContent = `Bootstrap: ${sanitizeErrorMessage(bootstrapError.message)} · ${message}`;
      setMapFeedback(message, true);
    }
  });
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  document.querySelectorAll('[data-requires-map-point]').forEach((node) => setVisibility(node, canCreateMapPoints()));
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
    setHtml('map-checks-list', '<li>Aucun diagnostic exécuté.</li>');
    return;
  }
  setHtml('map-checks-list', checks.map((check) => `<li><span class="${check.ok ? 'ok' : 'ko'}">${check.ok ? 'OK' : 'KO'}</span> · ${escapeHtml(check.label)}${check.detail ? ` — ${escapeHtml(check.detail)}` : ''}</li>`).join(''));
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
  document.getElementById('georisques-tab-overview')?.addEventListener('click', () => switchGeorisquesTab('overview'));
  document.getElementById('georisques-tab-pcs')?.addEventListener('click', () => switchGeorisquesTab('pcs'));
  switchGeorisquesTab('overview');
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
  document.getElementById('map-add-point-btn')?.addEventListener('click', () => {
    if (!canEdit()) {
      setMapFeedback('Vous n\'avez pas le droit de créer un POI.', true);
      return;
    }
    mapAddPointMode = !mapAddPointMode;
    pendingMapPointCoords = null;
    const button = document.getElementById('map-add-point-btn');
    button?.classList.toggle('active', mapAddPointMode);
    button?.setAttribute('aria-pressed', String(mapAddPointMode));
    setMapFeedback(mapAddPointMode
      ? 'Mode création POI actif: cliquez sur la carte pour positionner le point.'
      : 'Mode création POI désactivé.');
  });
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
  document.getElementById('filter-google-traffic-flow')?.addEventListener('change', () => applyGoogleTrafficFlowOverlay());
  document.getElementById('api-refresh-btn')?.addEventListener('click', async () => {
    try {
      await loadApiInterconnections(true);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('situation-refresh-btn')?.addEventListener('click', async () => {
    const button = document.getElementById('situation-refresh-btn');
    if (button) {
      button.disabled = true;
      button.textContent = 'Actualisation...';
    }
    try {
      await refreshAll(true);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Actualiser la situation';
      }
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
  document.getElementById('map-point-category-filter')?.addEventListener('change', renderCustomPoints);
  document.getElementById('map-point-form-cancel')?.addEventListener('click', () => {
    const modal = document.getElementById('map-point-modal');
    mapAddPointMode = false;
    document.getElementById('map-add-point-btn')?.classList.remove('active');
    document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
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
    const iconUrl = form.elements.icon_url.value.trim() || null;
    try {
      await saveMapPoint({
        name: form.elements.name.value.trim(),
        category,
        icon,
        icon_url: iconUrl,
        notes: form.elements.notes.value.trim() || null,
        lat: pendingMapPointCoords.lat,
        lon: pendingMapPointCoords.lng,
      });
      pendingMapPointCoords = null;
      mapAddPointMode = false;
      document.getElementById('map-add-point-btn')?.classList.remove('active');
      document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
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
  const debouncedLogsRender = debounce(renderLogsList, 180);
  ['logs-search', 'logs-municipality-filter', 'logs-scope-filter', 'logs-sort'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', debouncedLogsRender);
    document.getElementById(id)?.addEventListener('change', renderLogsList);
  });

  const debouncedMunicipalityFilter = debounce(applyMunicipalityFilters, 180);
  ['municipalities-search', 'municipalities-status-filter', 'municipalities-sort'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', debouncedMunicipalityFilter);
    document.getElementById(id)?.addEventListener('change', applyMunicipalityFilters);
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
  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'resource-type-filter', 'filter-itinisere', 'filter-bison-accidents', 'filter-bison-cameras', 'filter-photo-cameras', 'filter-waze-closed-roads'].forEach((id) => {
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
  if (liveEventsTimer) clearInterval(liveEventsTimer);
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  if (apiResyncTimer) clearInterval(apiResyncTimer);
  if (photoCameraRefreshTimer) clearInterval(photoCameraRefreshTimer);
  showHome();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => token && refreshAll(false), AUTO_REFRESH_MS);
}

async function refreshLiveEvents() {
  if (!token || document.hidden) return;
  return withPreservedScroll(async () => {
    try {
      const [logs, risks] = await Promise.all([
        api('/logs', { cacheTtlMs: 0, bypassCache: true }),
        api('/external/isere/risks', { cacheTtlMs: 0, bypassCache: true }),
      ]);

      cachedLogs = Array.isArray(logs) ? logs : [];
      renderLogsList();

      if (cachedDashboardSnapshot && typeof cachedDashboardSnapshot === 'object') {
        cachedDashboardSnapshot = {
          ...cachedDashboardSnapshot,
          latest_logs: cachedLogs.slice(0, 8),
          updated_at: new Date().toISOString(),
        };
        saveSnapshot(STORAGE_KEYS.dashboardSnapshot, cachedDashboardSnapshot);
      }

      renderExternalRisks(risks);
      saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, risks);
      saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, risks);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = `Actualisation live des évènements: ${sanitizeErrorMessage(error.message)}`;
    }
  });
}

function startLiveEventsRefresh() {
  if (liveEventsTimer) clearInterval(liveEventsTimer);
  liveEventsTimer = setInterval(refreshLiveEvents, EVENTS_LIVE_REFRESH_MS);
}

function startApiPanelAutoRefresh() {
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  if (apiResyncTimer) clearInterval(apiResyncTimer);
  apiResyncTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (activePanel === 'api-panel') renderApiResyncClock();
  }, 1000);

  apiPanelTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (!token || activePanel !== 'api-panel' || document.hidden) return;
    withPreservedScroll(async () => {
      await loadApiInterconnections(false);
    }).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }, API_PANEL_REFRESH_MS);
}

async function loadHomeLiveStatus() {
  return withPreservedScroll(async () => {
    try {
      const data = await api('/public/live', {
        logoutOn401: false,
        omitAuth: true,
        cacheTtlMs: 0,
        bypassCache: true,
      });
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
  });
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
    startLiveEventsRefresh();
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
    if (token) refreshAll(false);
  });
  window.addEventListener('focus', () => {
    loadHomeLiveStatus();
    if (token) refreshAll(false);
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
    startLiveEventsRefresh();
  } catch (error) {
    if (Number(error?.status) === 401) {
      logout();
      return;
    }
    document.getElementById('login-error').textContent = `Session conservée mais API indisponible: ${sanitizeErrorMessage(error?.message || 'erreur inconnue')}`;
    showLogin();
  }
})();
