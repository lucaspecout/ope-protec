const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel' };
const AUTO_REFRESH_MS = 30000;
const HOME_LIVE_REFRESH_MS = 30000;
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'georisques-panel': 'Page Géorisques',
  'api-panel': 'Interconnexions API',
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
let hydroLineLayer = null;
let pcsLayer = null;
let resourceLayer = null;
let searchLayer = null;
let customPointsLayer = null;
let mapPointsLayer = null;
let mapAddPointMode = false;
let mapPoints = [];
let pendingMapPointCoords = null;
let cachedStations = [];
let cachedMunicipalities = [];
let cachedMunicipalityRecords = [];
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
  if (!message) return 'Erreur inconnue';
  if (message.includes('<!doctype') || message.includes('<html')) {
    return "L'API renvoie une page HTML au lieu d'un JSON. Vérifiez que le backend tourne bien sur le même hôte (docker compose up -d).";
  }
  return message;
}

async function api(path, options = {}) {
  const { logoutOn401 = true, omitAuth = false, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (token && !omitAuth) headers.Authorization = `Bearer ${token}`;

  let lastError = null;
  for (const origin of apiOrigins()) {
    const url = buildApiUrl(path, origin);
    try {
      const response = await fetch(url, { ...fetchOptions, headers });
      const payload = await parseJsonResponse(response, path);
      if (!response.ok) {
        const message = payload?.detail || payload?.message || `Erreur API (${response.status})`;
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
        const detail = await response.text();
        throw new Error(detail || `Erreur API (${response.status})`);
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
}

function initMap() {
  if (leafletMap || typeof window.L === 'undefined') return;
  leafletMap = window.L.map('isere-map-leaflet', { zoomControl: true }).setView([45.2, 5.72], 9);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(leafletMap);
  hydroLayer = window.L.layerGroup().addTo(leafletMap);
  hydroLineLayer = window.L.layerGroup().addTo(leafletMap);
  pcsLayer = window.L.layerGroup().addTo(leafletMap);
  resourceLayer = window.L.layerGroup().addTo(leafletMap);
  searchLayer = window.L.layerGroup().addTo(leafletMap);
  customPointsLayer = window.L.layerGroup().addTo(leafletMap);
  mapPointsLayer = window.L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', onMapClickAddPoint);
}

function setMapFeedback(message = '', isError = false) {
  const target = document.getElementById('map-feedback');
  if (!target) return;
  target.textContent = message;
  target.className = isError ? 'error' : 'muted';
}

function fitMapToData() {
  if (!leafletMap) return;
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsLayer, resourceLayer, searchLayer, customPointsLayer, mapPointsLayer].filter(Boolean);
  const bounds = window.L.latLngBounds([]);
  layers.forEach((layer) => {
    if (layer?.getBounds) {
      const layerBounds = layer.getBounds();
      if (layerBounds?.isValid && layerBounds.isValid()) bounds.extend(layerBounds);
    }
  });
  if (bounds.isValid()) leafletMap.fitBounds(bounds, { padding: [24, 24] });
}

async function loadIsereBoundary() {
  initMap();
  const data = await api('/public/isere-map');
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 } }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
  setMapFeedback('Fond de carte et contour Isère chargés.');
}


function renderStations(stations = []) {
  cachedStations = stations;
  const visible = document.getElementById('filter-hydro')?.checked ?? true;
  document.getElementById('hydro-stations-list').innerHTML = stations.slice(0, 40).map((s) => `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(s.level)}">${normalizeLevel(s.level)}</span> · ${s.height_m} m</li>`).join('') || '<li>Aucune station.</li>';
  if (!hydroLayer || !hydroLineLayer) return;
  hydroLayer.clearLayers();
  hydroLineLayer.clearLayers();
  if (!visible) return;

  const stationsWithPoints = stations.filter((s) => s.lat != null && s.lon != null);
  stationsWithPoints.forEach((s) => {
    window.L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: levelColor(s.level), fillOpacity: 0.95 })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Niveau: ${normalizeLevel(s.level)}<br>Hauteur: ${s.height_m} m`)
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

  setMapFeedback(`${stations.length} station(s) Vigicrues chargée(s).`);
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

async function renderMunicipalitiesOnMap(municipalities = []) {
  cachedMunicipalities = municipalities;
  const pcs = municipalities.filter((m) => m.pcs_active);
  document.getElementById('pcs-list').innerHTML = pcs.slice(0, 15).map((m) => `<li><strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.crisis_mode ? '🔴 CRISE' : 'veille'}</li>`).join('') || '<li>Aucune commune PCS.</li>';
  if (!pcsLayer) return;
  pcsLayer.clearLayers();
  if (!(document.getElementById('filter-pcs')?.checked ?? true)) return;
  const points = await Promise.all(pcs.map(async (m) => ({ municipality: m, point: await geocodeMunicipality(m) })));
  let renderedCount = 0;
  points.forEach(({ municipality, point }) => {
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
  setMapFeedback(`${renderedCount}/${pcs.length} commune(s) PCS géolocalisée(s).`);
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
  setMapFeedback(`${resources.length} ressource(s) affichée(s).`);
}

async function handleMapSearch() {
  const query = (document.getElementById('map-search')?.value || '').trim();
  renderResources();
  if (!query || !leafletMap) return;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Isère, France')}`);
    const payload = await parseJsonResponse(response, 'nominatim');
    if (!payload?.length) { setMapFeedback('Aucun résultat de recherche trouvé.'); return; }
    const lat = Number(payload[0].lat);
    const lon = Number(payload[0].lon);
    searchLayer.clearLayers();
    window.L.marker([lat, lon]).bindPopup(`Résultat: ${payload[0].display_name}`).addTo(searchLayer).openPopup();
    leafletMap.setView([lat, lon], 12);
    setMapFeedback(`Recherche OK: ${payload[0].display_name}`);
  } catch {
    setMapFeedback('Service de recherche temporairement indisponible.', true);
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

function iconForCategory(category) {
  return MAP_POINT_ICONS[category] || '📍';
}

function emojiDivIcon(emoji) {
  return window.L.divIcon({ className: 'map-emoji-icon', html: `<span>${escapeHtml(emoji)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15] });
}

async function loadMapPoints() {
  mapPoints = await api('/map/points');
  renderCustomPoints();
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

function renderCustomPoints() {
  if (customPointsLayer) customPointsLayer.clearLayers();
  if (mapPointsLayer) mapPointsLayer.clearLayers();

  const selectedCategory = document.getElementById('map-point-category-filter')?.value || 'all';
  const filteredPoints = mapPoints.filter((point) => selectedCategory === 'all' || point.category === selectedCategory);
  const listMarkup = filteredPoints
    .map((point) => `<li><strong>${escapeHtml(point.icon || iconForCategory(point.category))} ${escapeHtml(point.name)}</strong> · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} <button type="button" data-remove-point="${point.id}">Supprimer</button></li>`)
    .join('') || '<li>Aucun point personnalisé.</li>';
  setHtml('custom-points-list', listMarkup);

  if (!mapPointsLayer) return;
  filteredPoints.forEach((point) => {
    const marker = window.L.marker([point.lat, point.lon], { icon: emojiDivIcon(point.icon || iconForCategory(point.category)) });
    marker.bindPopup(`<strong>${escapeHtml(point.icon || iconForCategory(point.category))} ${escapeHtml(point.name)}</strong><br/>Catégorie: ${escapeHtml(point.category)}<br/>${escapeHtml(point.notes || 'Sans note')}`);
    marker.addTo(mapPointsLayer);
  });
  setMapFeedback(`${filteredPoints.length} point(s) opérationnel(s) affiché(s).`);
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
  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = events.slice(0, 8).map((e) => {
    const title = escapeHtml(e.title || 'Évènement');
    const description = escapeHtml(e.description || '');
    const safeLink = String(e.link || '').startsWith('http') ? e.link : '#';
    const mapQuery = escapeHtml(e.title || '').replace(/"/g, '&quot;');
    return `<li><strong>${title}</strong><br>${description}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Détail</a><br><button type="button" class="ghost inline-action" data-map-query="${mapQuery}">Voir sur la carte</button></li>`;
  }).join('') || '<li>Aucune perturbation publiée.</li>';
}

function renderBisonFuteSummary(bison = {}) {
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
  const list = files.map((file) => `<li><strong>${escapeHtml(file.title)}</strong> · ${escapeHtml(file.doc_type)} · ${new Date(file.created_at).toLocaleDateString()} · par ${escapeHtml(file.uploaded_by)} <a href="/municipalities/${municipalityId}/files/${file.id}" target="_blank" rel="noreferrer">Consulter</a> ${canManage ? `<button type="button" class="ghost inline-action danger" data-muni-file-delete="${file.id}" data-muni-id="${municipalityId}">Supprimer</button>` : ''}</li>`).join('');
  return list || '<li>Aucun fichier opérationnel.</li>';
}

function closeMunicipalityDetailsModal() {
  const modal = document.getElementById('municipality-details-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
    return;
  }
  modal.removeAttribute('open');
}

async function openMunicipalityDetailsModal(municipality) {
  const modal = document.getElementById('municipality-details-modal');
  const content = document.getElementById('municipality-details-content');
  if (!modal || !content || !municipality) return;

  const files = await loadMunicipalityFiles(municipality.id).catch(() => []);
  const quickActions = canMunicipalityFiles()
    ? `<div class="municipality-actions municipality-actions--modal">
         ${canEdit() ? `<button type="button" class="ghost inline-action" data-muni-detail-crisis="${municipality.id}">${municipality.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
         <button type="button" class="ghost inline-action" data-muni-detail-edit="${municipality.id}">Éditer la fiche</button>` : ''}
         <button type="button" class="ghost inline-action" data-muni-file-upload="${municipality.id}">Ajouter un document</button>
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
    <ul class="list compact">${municipalityFilesMarkup(files, municipality.id)}</ul>
    ${quickActions}
  `;

  if (typeof modal.showModal === 'function') {
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

function renderCriticalRisks(meteo = {}) {
  const criticalLevels = new Set(['orange', 'rouge']);
  const currentAlerts = (meteo.current_alerts || []).filter((alert) => criticalLevels.has(normalizeLevel(alert.level)));
  const markup = currentAlerts.map((alert) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).slice(0, 1).join(' ');
    return `<li><strong>${alert.phenomenon}</strong> · <span class="risk-${level}">${level}</span>${details ? `<br>${details}` : ''}</li>`;
  }).join('') || '<li>Aucun risque orange ou rouge en cours.</li>';
  setHtml('critical-risks-list', markup);
}

async function loadDashboard() {
  const dashboard = await api('/dashboard');
  setRiskText('vigilance', normalizeLevel(dashboard.vigilance), dashboard.vigilance);
  setRiskText('crues', normalizeLevel(dashboard.crues), dashboard.crues);
  setRiskText('risk', normalizeLevel(dashboard.global_risk), dashboard.global_risk);
  document.getElementById('risk').className = normalizeLevel(dashboard.global_risk);
  document.getElementById('crisis').textContent = String(dashboard.communes_crise || 0);
  document.getElementById('latest-logs').innerHTML = (dashboard.latest_logs || []).map((l) => `<li>${l.danger_emoji || ''} <strong style="color:${levelColor(l.danger_level)}">${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun événement récent.</li>';
}

async function loadExternalRisks() {
  const data = await api('/external/isere/risks');
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
  setHtml('stations-list', (vigicrues.stations || []).slice(0, 10).map((s) => `<li>${s.station || s.code} · ${s.river || ''} · ${normalizeLevel(s.level)} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible.</li>');
  setText('itinisere-status', `${itinisere.status || 'inconnu'} · ${(itinisere.events || []).length} événements`);
  renderBisonFuteSummary(bisonFute);
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} AZI · ${georisques.ppr_total ?? 0} PPR · ${georisques.ground_movements_total ?? 0} mouvements`);
  renderGeorisquesDetails(georisques);
  renderCriticalRisks(meteo);
  renderMeteoAlerts(meteo);
  renderItinisereEvents(itinisere.events || []);
  setText('meteo-level', normalizeLevel(meteo.level || 'vert'));
  setText('meteo-hazards', (meteo.hazards || []).join(', ') || 'non précisé');
  setText('river-level', normalizeLevel(vigicrues.water_alert_level || 'vert'));
  setText('map-seismic-level', georisques.highest_seismic_zone_label || 'inconnue');
  setText('map-flood-docs', String(georisques.flood_documents_total ?? 0));
  renderStations(vigicrues.stations || []);
}

async function loadSupervision() {
  const data = await api('/supervision/overview');
  setRiskText('supervision-meteo', `${data.alerts.meteo.status} · ${normalizeLevel(data.alerts.meteo.level || 'inconnu')}`, data.alerts.meteo.level || 'vert');
  setRiskText('supervision-vigicrues', `${data.alerts.vigicrues.status} · ${normalizeLevel(data.alerts.vigicrues.water_alert_level || 'inconnu')}`, data.alerts.vigicrues.water_alert_level || 'vert');
  document.getElementById('supervision-itinisere').textContent = `${data.alerts.itinisere.status} · ${data.alerts.itinisere.events.length} alertes`;
  document.getElementById('supervision-bison').textContent = `${data.alerts.bison_fute.status} · Isère départ ${data.alerts.bison_fute.today?.isere?.departure || 'inconnu'}`;
  document.getElementById('supervision-georisques').textContent = `${data.alerts.georisques.status} · ${data.alerts.georisques.highest_seismic_zone_label || 'inconnue'}`;
  document.getElementById('supervision-crisis-count').textContent = String(data.crisis_municipalities.length || 0);
  document.getElementById('supervision-timeline').innerHTML = (data.timeline || []).map((l) => `<li>${new Date(l.created_at).toLocaleString()} · <strong>${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun historique.</li>';
  renderItinisereEvents(data.alerts.itinisere.events || [], 'supervision-itinisere-events');
}

async function loadApiInterconnections() {
  const data = await api('/external/isere/risks');
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

async function loadMunicipalities() {
  const municipalities = await api('/municipalities');
  cachedMunicipalityRecords = municipalities;
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
  await renderMunicipalitiesOnMap(municipalities);
}


async function loadLogs() {
  const dashboard = await api('/dashboard');
  document.getElementById('logs-list').innerHTML = (dashboard.latest_logs || []).map((l) => `<li>${new Date(l.created_at).toLocaleString()} · ${l.danger_emoji || ''} <strong style="color:${levelColor(l.danger_level)}">${l.event_type}</strong> · ${l.description}</li>`).join('') || '<li>Aucun log.</li>';
}

async function loadUsers() {
  if (!canManageUsers()) return;
  const users = await api('/auth/users');
  const isAdmin = currentUser?.role === 'admin';
  document.getElementById('users-table').innerHTML = users.map((u) => {
    const actionButtons = isAdmin
      ? `<div class="users-actions"><button type="button" data-user-edit="${u.id}">Modifier</button><button type="button" data-user-reset="${u.id}">Réinitialiser mot de passe</button><button type="button" class="ghost" data-user-delete="${u.id}">Supprimer</button></div>`
      : '-';
    return `<tr><td>${escapeHtml(u.username)}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.municipality_name || '-')}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td><td>${actionButtons}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Aucun utilisateur.</td></tr>';
}

async function refreshAll() {
  const loaders = [
    ['tableau de bord', loadDashboard],
    ['risques externes', loadExternalRisks],
    ['communes', loadMunicipalities],
    ['main courante', loadLogs],
    ['utilisateurs', loadUsers],
    ['supervision', loadSupervision],
    ['interconnexions API', loadApiInterconnections],
    ['points cartographiques', loadMapPoints],
  ];

  const results = await Promise.allSettled(loaders.map(([, loader]) => loader()));
  const failures = results
    .map((result, index) => ({ result, label: loaders[index][0] }))
    .filter(({ result }) => result.status === 'rejected');

  renderResources();
  fitMapToData();

  if (!failures.length) {
    document.getElementById('dashboard-error').textContent = '';
    return;
  }

  const message = failures.map(({ label, result }) => `${label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ');
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
  document.getElementById('map-search-btn')?.addEventListener('click', handleMapSearch);
  document.getElementById('map-fit-btn')?.addEventListener('click', fitMapToData);
  document.getElementById('api-refresh-btn')?.addEventListener('click', async () => {
    try {
      await loadApiInterconnections();
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('map-search')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); handleMapSearch(); } });
  document.getElementById('map-add-point-toggle')?.addEventListener('click', () => {
    mapAddPointMode = !mapAddPointMode;
    setText('map-add-point-toggle', `Mode ajout: ${mapAddPointMode ? 'activé' : 'désactivé'}`);
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
    if (iconInput && !iconInput.value.trim()) iconInput.value = iconForCategory(category);
  });
  document.getElementById('map-point-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingMapPointCoords) return;
    const form = event.target;
    const category = form.elements.category.value || 'autre';
    const icon = form.elements.icon.value.trim() || iconForCategory(category);
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
        openMunicipalityDetailsInlineFallback(municipality);
        return;
      }

      if (!editButton && !crisisButton && !filesButton && !deleteButton && fallbackId) {
        const municipality = getMunicipality(fallbackId);
        if (!municipality) return;
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality.name}: ${municipality.crisis_mode ? 'en crise' : 'en veille'} · vigilance ${normalizeLevel(municipality.vigilance_color)}.`;
        openMunicipalityDetailsModal(municipality);
        openMunicipalityDetailsInlineFallback(municipality);
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
  document.getElementById('municipality-editor-close')?.addEventListener('click', closeMunicipalityEditor);
  document.getElementById('municipality-details-close')?.addEventListener('click', closeMunicipalityDetailsModal);
  document.getElementById('municipality-details-content')?.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-muni-detail-edit]');
    const crisisButton = event.target.closest('[data-muni-detail-crisis]');
    const uploadFileButton = event.target.closest('[data-muni-file-upload]');
    const deleteFileButton = event.target.closest('[data-muni-file-delete]');
    if (!editButton && !crisisButton && !uploadFileButton && !deleteFileButton) return;

    const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

    try {
      if (editButton) {
        if (!canEdit()) return;
        const municipality = getMunicipality(editButton.getAttribute('data-muni-detail-edit'));
        if (!municipality) return;
        closeMunicipalityDetailsModal();
        openMunicipalityEditor(municipality);
        return;
      }

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
  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'resource-type-filter'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      renderStations(cachedStations);
      await renderMunicipalitiesOnMap(cachedMunicipalities);
      renderResources();
      fitMapToData();
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
  refreshTimer = setInterval(() => token && refreshAll(), AUTO_REFRESH_MS);
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
  try {
    await api('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: form.get('event_type'), description: form.get('description'), danger_level: form.get('danger_level'), danger_emoji: form.get('danger_emoji') }),
    });
    event.target.reset();
    if (errorTarget) errorTarget.textContent = '';
    await refreshAll();
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

(async function bootstrap() {
  bindHomeInteractions();
  bindAppInteractions();
  startHomeLiveRefresh();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadHomeLiveStatus();
    if (token) refreshAll();
  });
  window.addEventListener('focus', () => {
    loadHomeLiveStatus();
    if (token) refreshAll();
  });

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
