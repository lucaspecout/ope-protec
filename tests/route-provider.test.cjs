const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function loadFunction(context, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `Missing production function: ${name}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `Missing function end: ${name}`);
  vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
}

const points = [[45.18, 5.72], [45.19, 5.73], [45.20, 5.74]];
const start = { lat: 45.18, lon: 5.72 };
const end = { lat: 45.20, lon: 5.74 };
const warning = 'Routage TomTom indisponible ; vérifier la clé et les droits d’accès';

function harness({ backend, browser, backendError, browserError } = {}) {
  const calls = { backend: 0, browser: 0 };
  let summary = '';
  const context = vm.createContext({
    URLSearchParams,
    API_SLOW_ENDPOINT_TIMEOUT_MS: 45000,
    api: async () => { calls.backend += 1; if (backendError) throw backendError; return backend; },
    fetchClientOsrmRoute: async () => { calls.browser += 1; if (browserError) throw browserError; return browser; },
    formatDurationSeconds: (value) => `${value || 0} s`,
    formatDistanceMeters: (value) => `${value || 0} m`,
    routeDisplayIndex: () => 1,
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    setRouteSummary: (value) => { summary = value; },
  });
  for (const name of ['sanitizeErrorMessage', 'hasDetailedRoutePolyline', 'shouldPreferBrowserRoute', 'routeProviderWarning', 'buildRouteInfoHtml', 'renderRouteEstimate', 'fetchBestRoutePayload']) {
    loadFunction(context, name);
  }
  return { context, calls, get summary() { return summary; } };
}

test('a complete TomTom route keeps its live traffic data without a browser fallback', async () => {
  const backend = { provider: 'tomtom', traffic_mode: 'live_speed', polyline: points, duration_seconds: 75 };
  const h = harness({ backend });
  assert.equal(await h.context.fetchBestRoutePayload(start, end), backend);
  assert.equal(h.calls.browser, 0);
  h.context.renderRouteEstimate(backend);
  assert.match(h.summary, /Retard trafic live/);
  assert.doesNotMatch(h.summary, /color:#9b1c1c/);
});

test('a backend OSRM route displays the TomTom failure in its summary and popup', async () => {
  const backend = { provider: 'osrm', source: 'OSRM', polyline: points, tomtom_error: warning };
  const h = harness({ backend });
  const payload = await h.context.fetchBestRoutePayload(start, end);
  assert.equal(payload, backend);
  assert.equal(h.calls.browser, 0);
  h.context.renderRouteEstimate(payload);
  assert.ok(h.summary.includes(warning));
  assert.ok(h.context.buildRouteInfoHtml({ payload }).includes(warning));
});

test('a browser route retains the TomTom diagnostic from the backend fallback', async () => {
  const backend = { provider: 'local', polyline: [points[0], points[2]], tomtom_error: warning };
  const browser = { provider: 'osrm_browser', source: 'OSRM direct', polyline: points };
  const h = harness({ backend, browser });
  const payload = await h.context.fetchBestRoutePayload(start, end);
  assert.equal(payload, browser);
  assert.equal(payload.backend_fallback, backend);
  assert.equal(payload.tomtom_error, warning);
  h.context.renderRouteEstimate(payload);
  assert.ok(h.summary.includes(warning));
  assert.ok(h.context.buildRouteInfoHtml({ payload }).includes(warning));
});

test('a failed optional browser route keeps the usable backend estimate and its diagnostic', async () => {
  const backend = { provider: 'local', duration_seconds: 90, polyline: [points[0], points[2]], tomtom_error: warning };
  const h = harness({ backend, browserError: new Error('OSRM direct unavailable') });
  assert.equal(await h.context.fetchBestRoutePayload(start, end), backend);
  assert.equal(h.calls.backend, 1);
  assert.equal(h.calls.browser, 1);
});

test('a browser route still works when the backend request fails', async () => {
  const browser = { provider: 'osrm_browser', polyline: points };
  const h = harness({ backendError: new Error('Backend unavailable'), browser });
  const payload = await h.context.fetchBestRoutePayload(start, end);
  assert.equal(payload, browser);
  assert.equal(payload.backend_error, 'Backend unavailable');
  assert.equal(h.calls.browser, 1);
});

test('route warnings support saved nested diagnostics and escape provider text', () => {
  const payload = { provider: 'osrm_browser', backend_fallback: { tomtom_error: 'TomTom <script>alert(1)</script>' } };
  const h = harness();
  h.context.renderRouteEstimate(payload);
  const popup = h.context.buildRouteInfoHtml({ payload });
  for (const html of [h.summary, popup]) {
    assert.match(html, /TomTom &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  }
});
