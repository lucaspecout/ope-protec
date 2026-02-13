const ISERE_CENTER = [45.35, 5.55];
const ISERE_ZOOM = 9;
const REFRESH_INTERVAL_MS = 3 * 60 * 1000;

const map = L.map('map').setView(ISERE_CENTER, ISERE_ZOOM);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const statusBox = document.getElementById('status');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const resetBtn = document.getElementById('reset-btn');
const searchResults = document.getElementById('search-results');

const counters = {
  disruptions: document.getElementById('count-disruptions'),
  stops: document.getElementById('count-stops'),
  pois: document.getElementById('count-pois'),
  meteo: document.getElementById('meteo-level')
};

let searchIndex = [];

const showError = (message) => {
  statusBox.className = 'error';
  statusBox.textContent = message;
};
const clearError = () => {
  statusBox.className = '';
  statusBox.textContent = '';
};

const vigilanceColors = { vert: '#2e7d32', jaune: '#fbc02d', orange: '#ef6c00', rouge: '#c62828' };

const levelToFrench = {
  green: 'vert',
  yellow: 'jaune',
  orange: 'orange',
  red: 'rouge',
  1: 'vert',
  2: 'jaune',
  3: 'orange',
  4: 'rouge'
};

const meteoLayer = L.layerGroup();
const vigicruesLayer = L.geoJSON(null, {
  style: (feature) => {
    const level = normalizeLevel(feature?.properties?.vigilance || feature?.properties?.niveau);
    return { color: vigilanceColors[level] || '#607d8b', weight: 4, opacity: 0.9 };
  },
  onEachFeature: (feature, layer) => {
    const props = feature.properties || {};
    const level = normalizeLevel(props.vigilance || props.niveau || props.couleur || 'vert');
    const name = props.nom || props.libelle || props.troncon || 'Tronçon Vigicrues';
    layer.bindPopup(`<b>${name}</b><br/>Vigilance crue: <b>${level}</b>`);
  }
});

const itinisereLayers = {
  roads: L.layerGroup(),
  disruptions: L.layerGroup(),
  stops: L.layerGroup(),
  pois: L.layerGroup(),
  lines: L.geoJSON(null, { style: { color: '#3f51b5', weight: 3, opacity: 0.75 } })
};

const overlays = {
  meteo: meteoLayer,
  crues: vigicruesLayer,
  roads: itinisereLayers.roads,
  disruptions: itinisereLayers.disruptions,
  stops: itinisereLayers.stops,
  pois: itinisereLayers.pois,
  lines: itinisereLayers.lines
};

Object.values(overlays).forEach((layer) => layer.addTo(map));

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.style.background = '#fff';
  div.style.padding = '10px';
  div.style.borderRadius = '10px';
  div.style.boxShadow = '0 1px 5px rgba(0,0,0,0.2)';
  div.innerHTML = ['vert', 'jaune', 'orange', 'rouge']
    .map((lvl) => `<div><span style="display:inline-block;width:12px;height:12px;background:${vigilanceColors[lvl]};margin-right:7px"></span>${lvl}</div>`)
    .join('');
  return div;
};
legend.addTo(map);

function normalizeLevel(rawLevel) {
  if (rawLevel === null || rawLevel === undefined) return 'vert';
  const normalized = String(rawLevel).trim().toLowerCase();
  return levelToFrench[normalized] || normalized;
}

function iconForTrafficType(typeRaw = '') {
  const type = String(typeRaw).toLowerCase();
  let emoji = '🚧';
  if (type.includes('ferm')) emoji = '⛔';
  if (type.includes('incident') || type.includes('accident')) emoji = '⚠️';

  return L.divIcon({
    className: 'traffic-icon',
    html: `<div style="font-size:20px">${emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function extractMeteoInfo(payload) {
  const levelRaw =
    payload?.domaines?.find?.((d) => String(d?.code) === '38')?.niveau_vigilance ||
    payload?.product?.periods?.[0]?.timelaps?.[0]?.domain_ids?.find?.((d) => String(d?.domain_id) === '38')?.color_id ||
    payload?.niveau_vigilance ||
    1;

  const bulletin =
    payload?.bulletin?.textes?.[0]?.texte || payload?.bulletin?.text || payload?.text || 'Bulletin indisponible.';

  return { level: normalizeLevel(levelRaw), bulletin };
}

function parseLatLng(item) {
  if (Array.isArray(item?.geometry?.coordinates)) {
    const [lng, lat] = item.geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
  }

  const lat = Number(item?.lat ?? item?.latitude ?? item?.y ?? item?.coordY);
  const lng = Number(item?.lon ?? item?.lng ?? item?.longitude ?? item?.x ?? item?.coordX);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
  return null;
}

function getArray(payload) {
  if (Array.isArray(payload)) return payload;
  return (
    payload?.data ||
    payload?.results ||
    payload?.features ||
    payload?.events ||
    payload?.stops ||
    payload?.places ||
    payload?.lines ||
    payload?.disruptions ||
    []
  );
}

async function loadMeteoVigilance() {
  const response = await fetch('/api/meteo-france/vigilance');
  if (!response.ok) throw new Error(`Météo-France HTTP ${response.status}`);
  const payload = await response.json();
  const { level, bulletin } = extractMeteoInfo(payload);

  counters.meteo.textContent = level;
  meteoLayer.clearLayers();
  L.circleMarker(ISERE_CENTER, {
    radius: 14,
    color: vigilanceColors[level] || '#607d8b',
    fillColor: vigilanceColors[level] || '#607d8b',
    fillOpacity: 0.85,
    weight: 2
  })
    .bindPopup(`<b>Isère (38)</b><br/>Niveau: <b>${level}</b><hr/>${bulletin}`)
    .addTo(meteoLayer);
}

async function loadVigicrues() {
  const response = await fetch('/api/vigicrues/geojson');
  if (!response.ok) throw new Error(`Vigicrues HTTP ${response.status}`);
  const geojson = await response.json();
  vigicruesLayer.clearLayers();
  vigicruesLayer.addData(geojson);
}

function buildBboxQuery() {
  const bounds = map.getBounds();
  return new URLSearchParams({
    minLon: bounds.getWest().toFixed(6),
    minLat: bounds.getSouth().toFixed(6),
    maxLon: bounds.getEast().toFixed(6),
    maxLat: bounds.getNorth().toFixed(6)
  });
}

async function fetchItinisere(path, params = new URLSearchParams()) {
  const response = await fetch(`${path}?${params.toString()}`);
  if (!response.ok) throw new Error(`Itinisère ${path} HTTP ${response.status}`);
  return response.json();
}

function addSearchItem(type, name, coords, layer) {
  if (!coords) return;
  searchIndex.push({ type, name: name || type, coords, layer });
}

async function loadItinisereLayers() {
  const bbox = buildBboxQuery();
  const center = map.getCenter();
  searchIndex = [];

  const [nearestRoadPayload, poiPayload, stopsPayload, lineShapesPayload, disruptionsPayload] = await Promise.all([
    fetchItinisere('/api/itinisere/nearest-road', new URLSearchParams({ lon: center.lng, lat: center.lat })),
    fetchItinisere('/api/itinisere/places', bbox),
    fetchItinisere('/api/itinisere/stops', bbox),
    fetchItinisere('/api/itinisere/line-shapes'),
    fetchItinisere('/api/itinisere/road-disruptions', bbox)
  ]);

  Object.values(itinisereLayers).forEach((layer) => layer.clearLayers?.());

  const nearestRoad = getArray(nearestRoadPayload)[0] || nearestRoadPayload?.road || nearestRoadPayload;
  const nearestCoord = parseLatLng(nearestRoad);
  if (nearestCoord) {
    L.circleMarker(nearestCoord, { radius: 8, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 0.8 })
      .bindPopup(`<b>Route la plus proche</b><br/>${nearestRoad?.name || nearestRoad?.libelle || 'Route identifiée'}`)
      .addTo(itinisereLayers.roads);
    addSearchItem('Route', nearestRoad?.name || nearestRoad?.libelle || 'Route proche', nearestCoord, itinisereLayers.roads);
  }

  const disruptions = getArray(disruptionsPayload);
  counters.disruptions.textContent = disruptions.length;
  disruptions.forEach((event) => {
    const coords = parseLatLng(event);
    if (!coords) return;
    const type = event.type || event.category || event.nature || 'Perturbation';
    const title = event.title || event.libelle || event.name || 'Perturbation routière';
    const description = event.description || event.comment || event.details || '';

    L.marker(coords, { icon: iconForTrafficType(type) })
      .bindPopup(`<b>${title}</b><br/>Type: ${type}<br/>${description}`)
      .addTo(itinisereLayers.disruptions);
    addSearchItem('Perturbation', title, coords, itinisereLayers.disruptions);
  });

  const stops = getArray(stopsPayload);
  counters.stops.textContent = stops.length;
  stops.forEach((stop) => {
    const coords = parseLatLng(stop);
    if (!coords) return;
    const name = stop.name || stop.libelle || stop.stopName || 'Arrêt de transport';
    L.circleMarker(coords, { radius: 5, color: '#6a1b9a', fillColor: '#ab47bc', fillOpacity: 0.75 })
      .bindPopup(`<b>Arrêt</b><br/>${name}`)
      .addTo(itinisereLayers.stops);
    addSearchItem('Arrêt', name, coords, itinisereLayers.stops);
  });

  const pois = getArray(poiPayload);
  counters.pois.textContent = pois.length;
  pois.forEach((poi) => {
    const coords = parseLatLng(poi);
    if (!coords) return;
    const name = poi.name || poi.libelle || poi.title || 'Lieu public';
    L.circleMarker(coords, { radius: 5, color: '#00695c', fillColor: '#26a69a', fillOpacity: 0.75 })
      .bindPopup(`<b>POI / PCS</b><br/>${name}`)
      .addTo(itinisereLayers.pois);
    addSearchItem('POI/PCS', name, coords, itinisereLayers.pois);
  });

  const lineShapesGeoJson = lineShapesPayload?.type
    ? lineShapesPayload
    : lineShapesPayload?.geojson || lineShapesPayload?.result || { type: 'FeatureCollection', features: [] };
  itinisereLayers.lines.addData(lineShapesGeoJson);
}

function renderSearchResults(items) {
  searchResults.innerHTML = '';
  if (!items.length) {
    searchResults.innerHTML = '<li>Aucun résultat dans la vue courante.</li>';
    return;
  }

  items.slice(0, 40).forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${item.name}</strong><br/><small>${item.type}</small>`;
    li.addEventListener('click', () => {
      map.flyTo(item.coords, 15, { duration: 0.7 });
      item.layer.eachLayer((layer) => {
        if (layer.getLatLng && layer.getLatLng().lat === item.coords[0] && layer.getLatLng().lng === item.coords[1]) {
          layer.openPopup?.();
        }
      });
    });
    searchResults.appendChild(li);
  });
}

function runSearch() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    renderSearchResults(searchIndex);
    return;
  }
  const matches = searchIndex.filter((item) => `${item.type} ${item.name}`.toLowerCase().includes(query));
  renderSearchResults(matches);
}

function setupToggles() {
  document.querySelectorAll('input[data-layer]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const key = checkbox.dataset.layer;
      const layer = overlays[key];
      if (!layer) return;
      if (checkbox.checked) layer.addTo(map);
      else map.removeLayer(layer);
    });
  });
}

async function refreshLayers() {
  clearError();
  const errors = [];

  await Promise.allSettled([
    loadMeteoVigilance().catch((err) => errors.push(err.message)),
    loadVigicrues().catch((err) => errors.push(err.message)),
    loadItinisereLayers().catch((err) => errors.push(`mobilité indisponible (${err.message})`))
  ]);

  if (errors.length) showError(`Certaines couches n'ont pas pu être chargées: ${errors.join(' | ')}`);
  runSearch();
}

searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runSearch();
});
resetBtn.addEventListener('click', () => {
  searchInput.value = '';
  map.flyTo(ISERE_CENTER, ISERE_ZOOM, { duration: 0.7 });
  runSearch();
});

setupToggles();
map.on('moveend', refreshLayers);
refreshLayers();
setInterval(refreshLayers, REFRESH_INTERVAL_MS);
