const ISERE_CENTER = [45.35, 5.55];
const ISERE_ZOOM = 9;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const map = L.map('map').setView(ISERE_CENTER, ISERE_ZOOM);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const statusBox = document.getElementById('status');
const showError = (message) => {
  statusBox.className = 'error';
  statusBox.textContent = message;
};
const clearError = () => {
  statusBox.className = '';
  statusBox.textContent = '';
};

const vigilanceColors = {
  vert: '#2e7d32',
  jaune: '#fbc02d',
  orange: '#ef6c00',
  rouge: '#c62828'
};

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
    return {
      color: vigilanceColors[level] || '#607d8b',
      weight: 4,
      opacity: 0.9
    };
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
  'Vigilance Météo-France (Isère)': meteoLayer,
  'Vigilance crues (Vigicrues)': vigicruesLayer,
  'Itinisère · Routes proches': itinisereLayers.roads,
  'Itinisère · Perturbations routières': itinisereLayers.disruptions,
  'Itinisère · Arrêts transport': itinisereLayers.stops,
  'Itinisère · POI / lieux publics': itinisereLayers.pois,
  'Itinisère · Tracés des lignes': itinisereLayers.lines
};

Object.values(overlays).forEach((layer) => layer.addTo(map));
L.control.layers({}, overlays, { collapsed: false }).addTo(map);

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.innerHTML = ['vert', 'jaune', 'orange', 'rouge']
    .map((lvl) => `<div><i style="background:${vigilanceColors[lvl]}"></i>${lvl}</div>`)
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
  const type = typeRaw.toLowerCase();
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
    payload?.bulletin?.textes?.[0]?.texte ||
    payload?.bulletin?.text ||
    payload?.text ||
    'Bulletin de vigilance indisponible.';

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
    payload?.results ||
    payload?.features ||
    payload?.events ||
    payload?.data ||
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

async function loadItinisereLayers() {
  const bbox = buildBboxQuery();
  const center = map.getCenter();

  const [nearestRoadPayload, poiPayload, stopsPayload, lineShapesPayload, disruptionsPayload] = await Promise.all([
    fetchItinisere('/api/itinisere/nearest-road', new URLSearchParams({ lon: center.lng, lat: center.lat })),
    fetchItinisere('/api/itinisere/places', bbox),
    fetchItinisere('/api/itinisere/stops', bbox),
    fetchItinisere('/api/itinisere/line-shapes'),
    fetchItinisere('/api/itinisere/road-disruptions', bbox)
  ]);

  Object.values(itinisereLayers).forEach((layer) => {
    if (layer.clearLayers) layer.clearLayers();
  });

  const nearestRoad = getArray(nearestRoadPayload)[0] || nearestRoadPayload?.road || nearestRoadPayload;
  const nearestCoord = parseLatLng(nearestRoad);
  if (nearestCoord) {
    L.circleMarker(nearestCoord, { radius: 8, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 0.8 })
      .bindPopup(`<b>Route la plus proche</b><br/>${nearestRoad?.name || nearestRoad?.libelle || 'Route identifiée'}`)
      .addTo(itinisereLayers.roads);
  }

  getArray(disruptionsPayload).forEach((event) => {
    const coords = parseLatLng(event);
    if (!coords) return;
    const type = event.type || event.category || event.nature || 'Perturbation';
    const title = event.title || event.libelle || event.name || 'Perturbation routière';
    const description = event.description || event.comment || event.details || '';

    L.marker(coords, { icon: iconForTrafficType(type) })
      .bindPopup(`<b>${title}</b><br/>Type: ${type}<br/>${description}`)
      .addTo(itinisereLayers.disruptions);
  });

  getArray(stopsPayload).forEach((stop) => {
    const coords = parseLatLng(stop);
    if (!coords) return;
    L.circleMarker(coords, { radius: 5, color: '#6a1b9a', fillColor: '#ab47bc', fillOpacity: 0.75 })
      .bindPopup(`<b>Arrêt</b><br/>${stop.name || stop.libelle || stop.stopName || 'Arrêt de transport'}`)
      .addTo(itinisereLayers.stops);
  });

  getArray(poiPayload).forEach((poi) => {
    const coords = parseLatLng(poi);
    if (!coords) return;
    L.circleMarker(coords, { radius: 5, color: '#00695c', fillColor: '#26a69a', fillOpacity: 0.75 })
      .bindPopup(`<b>POI</b><br/>${poi.name || poi.libelle || poi.title || 'Lieu public'}`)
      .addTo(itinisereLayers.pois);
  });

  const lineShapesGeoJson = lineShapesPayload?.type
    ? lineShapesPayload
    : lineShapesPayload?.geojson || lineShapesPayload?.result || { type: 'FeatureCollection', features: [] };
  itinisereLayers.lines.addData(lineShapesGeoJson);
}

async function refreshLayers() {
  clearError();
  const errors = [];

  await Promise.allSettled([
    loadMeteoVigilance().catch((err) => errors.push(err.message)),
    loadVigicrues().catch((err) => errors.push(err.message)),
    loadItinisereLayers().catch(() => errors.push('données mobilité non disponibles'))
  ]);

  if (errors.length) {
    showError(`Certaines couches n'ont pas pu être chargées: ${errors.join(' | ')}`);
  }
}

map.on('moveend', refreshLayers);
refreshLayers();
setInterval(refreshLayers, REFRESH_INTERVAL_MS);
