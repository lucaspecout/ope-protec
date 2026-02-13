const express = require('express');
const { createClient } = require('redis');
const config = require('./config');

const app = express();
app.use(express.static(__dirname));

let redisClient = null;
let redisReady = false;

function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchJson(url, options = {}) {
  const timeout = withTimeout();
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const details = typeof body === 'string' ? body : JSON.stringify(body);
      throw new Error(`HTTP ${response.status} - ${details.slice(0, 300)}`);
    }

    return body;
  } finally {
    timeout.clear();
  }
}

function createBbox(req) {
  const minLon = Number(req.query.minLon);
  const minLat = Number(req.query.minLat);
  const maxLon = Number(req.query.maxLon);
  const maxLat = Number(req.query.maxLat);

  if ([minLon, minLat, maxLon, maxLat].some(Number.isNaN)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function buildItinisereUrl(endpoint, queryParams = {}) {
  const url = new URL(endpoint, config.itinisere.baseUrl);
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  url.searchParams.set('apiKey', config.itinisere.apiKey);
  return url.toString();
}

function getCacheKey(prefix, req) {
  const query = new URLSearchParams(req.query).toString();
  return `itinisere:${prefix}:${query}`;
}

async function readCache(key) {
  if (!redisReady) return null;
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function writeCache(key, payload) {
  if (!redisReady) return;
  try {
    await redisClient.setEx(key, config.redis.ttlSeconds, JSON.stringify(payload));
  } catch {
    // no-op fallback
  }
}

async function proxyItinisere(req, res, { endpoint, query, cachePrefix }) {
  const cacheKey = getCacheKey(cachePrefix, req);
  const cached = await readCache(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const data = await fetchJson(buildItinisereUrl(endpoint, query(req)), {
      headers: { Accept: 'application/json' }
    });
    await writeCache(cacheKey, data);
    return res.json({ ...data, cached: false });
  } catch (error) {
    return res.status(502).json({
      error: 'Données mobilité non disponibles',
      details: error.message
    });
  }
}

app.get('/api/meteo-france/vigilance', async (_req, res) => {
  try {
    const url = `${config.meteoFrance.bulletinUrl}?domain=${encodeURIComponent(config.meteoFrance.domain)}&format=json`;
    const data = await fetchJson(url, {
      headers: {
        apikey: config.meteoFrance.apiKey,
        Accept: 'application/json'
      }
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Erreur proxy Météo-France', details: error.message });
  }
});

app.get('/api/vigicrues/geojson', async (_req, res) => {
  try {
    const data = await fetchJson(config.vigicrues.geojsonUrl, {
      headers: { Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.8' }
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Erreur proxy Vigicrues', details: error.message });
  }
});

app.get('/api/itinisere/nearest-road', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.nearestRoad,
    cachePrefix: 'nearest-road',
    query: ({ query }) => ({ lon: query.lon, lat: query.lat })
  })
);

app.get('/api/itinisere/nearest-place', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.nearestPlace,
    cachePrefix: 'nearest-place',
    query: ({ query }) => ({ lon: query.lon, lat: query.lat })
  })
);

app.get('/api/itinisere/places', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.placesByBoundingBox,
    cachePrefix: 'places',
    query: () => createBbox(req)
  })
);

app.get('/api/itinisere/stops', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.stopsByBoundingBox,
    cachePrefix: 'stops',
    query: () => createBbox(req)
  })
);

app.get('/api/itinisere/line-stops', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.lineStopsByBoundingBox,
    cachePrefix: 'line-stops',
    query: () => createBbox(req)
  })
);

app.get('/api/itinisere/lines', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.lines,
    cachePrefix: 'lines',
    query: ({ query }) => ({ networkId: query.networkId })
  })
);

app.get('/api/itinisere/line-shapes', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.linesShapes,
    cachePrefix: 'line-shapes',
    query: ({ query }) => ({ networkId: query.networkId })
  })
);

app.get('/api/itinisere/realtime-state', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.networkRealtimeState,
    cachePrefix: 'realtime-state',
    query: ({ query }) => ({ networkId: query.networkId })
  })
);

app.get('/api/itinisere/monitored-stop-points', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.monitoredStopPoints,
    cachePrefix: 'monitored-stop-points',
    query: ({ query }) => ({ stopAreaId: query.stopAreaId })
  })
);

app.get('/api/itinisere/trip-places', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.places,
    cachePrefix: 'trip-places',
    query: ({ query }) => ({ city: query.city, category: query.category, text: query.text })
  })
);

app.get('/api/itinisere/road-disruptions', (req, res) =>
  proxyItinisere(req, res, {
    endpoint: config.itinisere.endpoints.roadDisruptionsByBoundingBox,
    cachePrefix: 'road-disruptions',
    query: () => createBbox(req)
  })
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, redis: redisReady ? 'connected' : 'disconnected' })
);

async function start() {
  try {
    redisClient = createClient({
      url: config.redis.url,
      socket: { reconnectStrategy: () => false, connectTimeout: 2000 }
    });
    redisClient.on('error', (error) => {
      redisReady = false;
      console.warn('[redis] erreur, bascule sans cache:', error.message);
    });
    await redisClient.connect();
    redisReady = true;
    console.log('[redis] connecté');
  } catch (error) {
    redisReady = false;
    console.warn('[redis] indisponible, démarrage sans cache:', error.message);
  }

  app.listen(config.port, () => {
    console.log(`Serveur proxy démarré sur http://localhost:${config.port}`);
  });
}

start();
