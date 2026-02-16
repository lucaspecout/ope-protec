const STORAGE_KEYS = { token: 'token', activePanel: 'activePanel', customPoints: 'customPoints' };
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
let customPoints = [];
let mapAddPointMode = false;
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
  customPoints = loadCustomPoints();
  renderCustomPoints();
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
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsLayer, resourceLayer, searchLayer, customPointsLayer].filter(Boolean);
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
  if (!municipality.postal_code) return null;
  try {
    const url = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=centre&limit=1`;
    const response = await fetch(url);
    const payload = await parseJsonResponse(response, url);
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
  setMapFeedback(`${pcs.length} commune(s) PCS chargée(s).`);
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

function loadCustomPoints() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.customPoints) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomPoints() {
  localStorage.setItem(STORAGE_KEYS.customPoints, JSON.stringify(customPoints));
}

function renderCustomPoints() {
  if (customPointsLayer) customPointsLayer.clearLayers();
  const listMarkup = customPoints.map((point) => `<li><strong>${point.name}</strong> · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} <button type="button" data-remove-point="${point.id}">Supprimer</button></li>`).join('') || '<li>Aucun point personnalisé.</li>';
  setHtml('custom-points-list', listMarkup);
  if (!customPointsLayer) return;
  customPoints.forEach((point) => {
    window.L.marker([point.lat, point.lon]).bindPopup(`<strong>${point.name}</strong><br/>Point personnalisé`).addTo(customPointsLayer);
  });
}

function onMapClickAddPoint(event) {
  if (!mapAddPointMode) return;
  const defaultName = `Point ${new Date().toLocaleTimeString()}`;
  const label = window.prompt('Nom du point personnalisé', defaultName);
  if (!label) return;
  customPoints.push({ id: String(Date.now()) + String(Math.random()).slice(2, 6), name: label.trim(), lat: event.latlng.lat, lon: event.latlng.lng });
  saveCustomPoints();
  renderCustomPoints();
  setMapFeedback(`Point personnalisé ajouté: ${label.trim()}`);
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
  const monitored = georisques.monitored_communes || [];
  const errorDetails = Array.isArray(georisques.errors) ? georisques.errors.filter(Boolean) : [];
  setText('georisques-page-status', georisques.status || 'inconnu');
  setText('georisques-page-seismic', georisques.highest_seismic_zone_label || 'inconnue');
  setText('georisques-page-flood-docs', String(georisques.flood_documents_total ?? 0));
  const sourceText = `Source: ${georisques.source || 'inconnue'} · Dernière mise à jour: ${georisques.updated_at ? new Date(georisques.updated_at).toLocaleString() : 'inconnue'}`;
  const errorsText = errorDetails.length ? ` · Anomalies: ${errorDetails.join(' | ')}` : '';
  setText('georisques-page-source', `${sourceText}${errorsText}`);

  const markup = monitored.map((commune) => (
    `<li><strong>${escapeHtml(commune.name || 'Commune inconnue')}</strong> (${escapeHtml(commune.code_insee || '-')}) · Sismicité: <strong>${escapeHtml(commune.seismic_zone || 'inconnue')}</strong> · Documents inondation: <strong>${Number(commune.flood_documents || 0)}</strong></li>`
  )).join('') || '<li>Aucune commune remontée par Géorisques.</li>';
  setHtml('georisques-communes-list', markup);
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
  const georisques = data?.georisques || {};

  setRiskText('meteo-status', `${meteo.status || 'inconnu'} · niveau ${normalizeLevel(meteo.level || 'inconnu')}`, meteo.level || 'vert');
  setText('meteo-info', meteo.info_state || meteo.bulletin_title || '');
  setRiskText('vigicrues-status', `${vigicrues.status || 'inconnu'} · niveau ${normalizeLevel(vigicrues.water_alert_level || 'inconnu')}`, vigicrues.water_alert_level || 'vert');
  setText('vigicrues-info', `${(vigicrues.stations || []).length} station(s) suivie(s)`);
  setHtml('stations-list', (vigicrues.stations || []).slice(0, 10).map((s) => `<li>${s.station || s.code} · ${s.river || ''} · ${normalizeLevel(s.level)} · ${s.height_m} m</li>`).join('') || '<li>Aucune station disponible.</li>');
  setText('itinisere-status', `${itinisere.status || 'inconnu'} · ${(itinisere.events || []).length} événements`);
  renderBisonFuteSummary(bisonFute);
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} document(s) inondation suivis`);
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
  document.getElementById('municipalities-list').innerHTML = municipalities.map((m) => {
    const dangerColor = levelColor(m.vigilance_color || 'vert');
    const actions = canEdit()
      ? `<button type="button" class="ghost inline-action" data-muni-crisis="${m.id}">${m.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
         <button type="button" class="ghost inline-action" data-muni-docs="${m.id}">Ajouter documents</button>`
      : '';
    return `<li>
      <strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.phone}
      <br><span style="color:${dangerColor}">Statut: ${m.crisis_mode ? 'CRISE' : 'veille'} · Vigilance ${normalizeLevel(m.vigilance_color || 'vert')}</span>
      <br>Contacts: ${escapeHtml(m.contacts || 'Non renseignés')}
      <br>Infos: ${escapeHtml(m.additional_info || 'Aucune')}
      <br>Population: ${m.population ?? '-'} · Capacité accueil: ${m.shelter_capacity ?? '-'} · Canal radio: ${escapeHtml(m.radio_channel || '-')}
      <br>${actions}
    </li>`;
  }).join('') || '<li>Aucune commune.</li>';
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
    setMapFeedback(mapAddPointMode ? 'Cliquez sur la carte pour ajouter un point personnalisé.' : 'Mode ajout désactivé.');
  });
  document.getElementById('itinerary-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-map-query]');
    if (!button) return;
    document.getElementById('map-search').value = button.getAttribute('data-map-query') || '';
    await handleMapSearch();
  });
  document.getElementById('custom-points-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-point]');
    if (!button) return;
    const targetId = button.getAttribute('data-remove-point');
    customPoints = customPoints.filter((point) => point.id !== targetId);
    saveCustomPoints();
    renderCustomPoints();
    setMapFeedback('Point personnalisé supprimé.');
  });
  document.getElementById('municipalities-list')?.addEventListener('click', async (event) => {
    const crisisButton = event.target.closest('[data-muni-crisis]');
    const docsButton = event.target.closest('[data-muni-docs]');
    if (!crisisButton && !docsButton) return;
    try {
      if (crisisButton) {
        await api(`/municipalities/${crisisButton.getAttribute('data-muni-crisis')}/crisis`, { method: 'POST' });
      }
      if (docsButton) {
        const municipalityId = docsButton.getAttribute('data-muni-docs');
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.pdf,.png,.jpg,.jpeg';
        picker.multiple = true;
        picker.onchange = async () => {
          const files = Array.from(picker.files || []);
          if (!files.length) return;
          const formData = new FormData();
          if (files[0]) formData.append('orsec_plan', files[0]);
          if (files[1]) formData.append('convention', files[1]);
          await api(`/municipalities/${municipalityId}/documents`, { method: 'POST', body: formData });
          await loadMunicipalities();
        };
        picker.click();
        return;
      }
      await loadMunicipalities();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('user-create-role')?.addEventListener('change', syncUserCreateMunicipalityVisibility);
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
