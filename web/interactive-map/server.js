const express = require('express');
const path = require('path');
const config = require('./config');

const app = express();

app.use(express.static(__dirname));

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

app.get('/api/itinisere/events', async (_req, res) => {
  try {
    const data = await fetchJson(config.itinisere.eventsUrl, {
      headers: {
        'x-api-key': config.itinisere.apiKey,
        Accept: 'application/json'
      }
    });
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: 'Erreur proxy Itinisère', details: error.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`Serveur proxy démarré sur http://localhost:${config.port}`);
});
