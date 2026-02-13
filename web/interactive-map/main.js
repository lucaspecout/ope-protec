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
const itinisereLayer = L.layerGroup();

const overlays = {
  'Vigilance Météo-France (Isère)': meteoLayer,
  'Vigilance crues (Vigicrues)': vigicruesLayer,
  'Événements circulation (Itinisère)': itinisereLayer
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

  return {
    level: normalizeLevel(levelRaw),
    bulletin
  };
}

async function loadMeteoVigilance() {
  const response = await fetch('/api/meteo-france/vigilance');
  if (!response.ok) throw new Error(`Météo-France HTTP ${response.status}`);
  const payload = await response.json();
  const { level, bulletin } = extractMeteoInfo(payload);

  meteoLayer.clearLayers();
  const marker = L.circleMarker(ISERE_CENTER, {
    radius: 14,
    color: vigilanceColors[level] || '#607d8b',
    fillColor: vigilanceColors[level] || '#607d8b',
    fillOpacity: 0.85,
    weight: 2
  }).bindPopup(`<b>Isère (38)</b><br/>Niveau: <b>${level}</b><hr/>${bulletin}`);

  marker.addTo(meteoLayer);
}

async function loadVigicrues() {
  const response = await fetch('/api/vigicrues/geojson');
  if (!response.ok) throw new Error(`Vigicrues HTTP ${response.status}`);
  const geojson = await response.json();
  vigicruesLayer.clearLayers();
  vigicruesLayer.addData(geojson);
}

function extractCoordinates(event) {
  if (Array.isArray(event?.geometry?.coordinates)) {
    const [lng, lat] = event.geometry.coordinates;
    return [lat, lng];
  }

  const lat = event?.lat || event?.latitude || event?.y;
  const lng = event?.lon || event?.lng || event?.longitude || event?.x;
  if (lat && lng) return [Number(lat), Number(lng)];
  return null;
}

async function loadItinisere() {
  const response = await fetch('/api/itinisere/events');
  if (!response.ok) throw new Error(`Itinisère HTTP ${response.status}`);
  const payload = await response.json();

  const events = payload?.events || payload?.features || payload?.results || [];
  itinisereLayer.clearLayers();

  events.forEach((event) => {
    const coords = extractCoordinates(event);
    if (!coords) return;
    const type = event.type || event.category || event.nature || 'Perturbation';
    const title = event.title || event.libelle || event.name || 'Événement circulation';
    const description = event.description || event.comment || event.details || '';

    L.marker(coords, { icon: iconForTrafficType(type) })
      .bindPopup(`<b>${title}</b><br/>Type: ${type}<br/>${description}`)
      .addTo(itinisereLayer);
  });
}

async function refreshLayers() {
  clearError();
  const errors = [];

  await Promise.allSettled([
    loadMeteoVigilance().catch((err) => errors.push(err.message)),
    loadVigicrues().catch((err) => errors.push(err.message)),
    loadItinisere().catch((err) => errors.push(err.message))
  ]);

  if (errors.length) {
    showError(`Certaines couches n'ont pas pu être chargées: ${errors.join(' | ')}`);
  }
}

refreshLayers();
setInterval(refreshLayers, REFRESH_INTERVAL_MS);
