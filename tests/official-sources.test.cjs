const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/official_sources.js'), 'utf8');

function harness(overrides = {}) {
  const elements = new Map();
  const listeners = new Map();
  const get = (id) => {
    if (!elements.has(id)) {
      const node = { innerHTML: '', textContent: '', value: '', checked: false, disabled: false, dataset: {}, addEventListener() {} };
      Object.defineProperty(node, 'innerHTML', {
        get() { return this.html || ''; },
        set(value) { this.html = value; const match = value.match(/<option value="([^"]*)"/); if (match && !this.value) this.value = match[1]; },
      });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const layers = [], removed = [], createdUrls = [], revokedUrls = [], fileRequests = [];
  const marker = (type) => ({ type, entries: [], addTo(target) { target.entries?.push(this); layers.push(this); return this; }, bindPopup(html) { this.popup = html; return this; } });
  const context = vm.createContext({
    window: { L: { layerGroup: () => marker('group'), circleMarker: () => marker('marker'), imageOverlay: (url) => ({ ...marker('image'), url }) } },
    leafletMap: { removeLayer(layer) { removed.push(layer); } },
    document: { hidden: false, getElementById: get, addEventListener: (name, fn) => listeners.set(name, fn) },
    localStorage: { getItem: () => 'map-panel' },
    URL: class extends URL { static createObjectURL() { const url = `blob:test-${createdUrls.length}`; createdUrls.push(url); return url; } static revokeObjectURL(url) { revokedUrls.push(url); } },
    api: async () => ({ history: [] }),
    apiFile: async (url) => { fileRequests.push(url); return { blob: {}, contentType: 'image/png' }; },
    setInterval, clearInterval, setTimeout, clearTimeout, console,
    ...overrides,
  });
  vm.runInContext(source, context, { filename: 'web/official_sources.js' });
  return { ui: context.window.OfficialSources, context, get, layers, removed, createdUrls, revokedUrls, fileRequests, listeners };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const polygon = { type: 'Polygon', coordinates: [[[5, 45], [5.1, 45], [5.1, 45.1], [5, 45]]] };
const frame = { id: '20261020120000', observed_at: '2026-10-20T12:00:00Z', bounds: [[44.55, 4.65], [46, 6.65]] };

test('INSEE zero is an actual estimate and partial coverage keeps the existing total', () => {
  const { ui } = harness();
  const complete = ui.populationDecision({ status: 'online', scope_coverage_ratio: 1, population_estimated: 0 }, 999, 'surface');
  assert.equal(complete.value, 0); assert.equal(complete.useGrid, true);
  const partial = ui.populationDecision({ status: 'partial', scope_coverage_ratio: 0.5, population_estimated: 200 }, 999, 'surface');
  assert.equal(partial.value, 999); assert.equal(partial.useGrid, false); assert.match(partial.note, /50\.0/);
  const unavailable = ui.populationDecision({ status: 'pending' }, 999, 'surface');
  assert.equal(unavailable.value, 999); assert.match(unavailable.note, /import/);
});

test('source status distinguishes required credentials from an outage', () => {
  const { ui } = harness();
  assert.match(ui.status({ status: 'configuration_required' }), /configurer/);
  assert.match(ui.status({ status: 'access_required' }), /partenaire/);
  assert.equal(ui.status({ status: 'error' }), 'Indisponible');
});

test('six source views render real contracts with escaped names and no fabricated outages', () => {
  const { ui, get } = harness();
  ui.update({
    insee_population: { status: 'online', cells_total: 123, data_year: 2021 },
    meteo_observations: { status: 'online', stations: [{ id: '38001001', name: '<img src=x>', temperature_c: 0, rain_6m_mm: 0, gust_kmh: 0, observed_at: frame.observed_at }], summary: {} },
    vigicrues_forecasts: { status: 'online', stations: [{ code: 'A123', station: 'Rivière test', series: [{ variable: 'H', unit: 'm', points: [{ at: frame.observed_at, central: 0 }] }] }] },
    meteo_radar: { status: 'configuration_required', frames: [] },
    industrial_sites: { status: 'online', sites: [{ id: '123', nom: '<script>bad()</script>', commune: 'Test', seveso: 'haut' }], sites_total: 1 },
    enedis: { status: 'access_required', outages: null, official_links: [{ label: 'Diagnostic', url: 'https://www.enedis.fr/panne-et-interruption' }] },
  });
  assert.match(get('official-observation-table').innerHTML, /&lt;img/);
  assert.doesNotMatch(get('official-observation-table').innerHTML, /<img/);
  assert.match(get('official-industry-table').innerHTML, /&lt;script/);
  assert.match(get('official-forecast-chart').innerHTML, /<svg/);
  assert.match(get('official-enedis-body').innerHTML, /ne signifie pas/);
  assert.doesNotMatch(get('official-enedis-body').innerHTML, /0 coupure/);
  assert.equal((get('official-source-cards').innerHTML.match(/official-source-card/g) || []).length, 6);
});

test('industrial reference replaces identified duplicates and retains custom risks', () => {
  const { ui } = harness();
  ui.update({ industrial_sites: { status: 'online', sites: [{ id: '12', nom: 'Usine été', lat: 45, lon: 5, seveso: 'haut' }] } });
  const rows = ui.mergeIndustryResources([{ name: 'Usine ETE', type: 'lieu_risque' }, { name: 'Site ajouté', type: 'site_sensible_custom' }]);
  assert.equal(rows.length, 2); assert.equal(rows[1].officialIndustrial, true); assert.equal(rows[0].name, 'Site ajouté');
});

test('population request uses authenticated API helper and never starts a dataset import', async () => {
  const calls = [];
  const { ui } = harness({ api: async (...args) => { calls.push(args); return { status: 'pending' }; } });
  const result = await ui.estimatePopulation(polygon);
  assert.equal(result.status, 'pending'); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/population/isere/estimate');
  assert.deepEqual(JSON.parse(calls[0][1].body), { geometry: polygon });
  assert.equal(calls[0][1].maxRetries, 0);
});

test('radar fetches an authenticated PNG once and reuses its object URL', async () => {
  const h = harness(); h.get('filter-official-radar').checked = true;
  h.ui.update({ meteo_radar: { status: 'online', frames: [frame], bounds: frame.bounds } });
  h.ui.syncMap(); await flush();
  assert.deepEqual(h.fileRequests, ['/api/meteo-france/radar/frames/20261020120000.png']);
  assert.equal(h.createdUrls.length, 1); assert.equal(h.layers.filter((l) => l.type === 'image').length, 1);
  h.ui.syncMap(); await flush(); assert.equal(h.fileRequests.length, 1);
  h.ui.reset(); assert.deepEqual(h.revokedUrls, ['blob:test-0']);
});

test('a PNG request finishing after logout cannot restore an image or leak its object URL', async () => {
  let resolve;
  const h = harness({ apiFile: () => new Promise((done) => { resolve = done; }) });
  h.get('filter-official-radar').checked = true;
  h.ui.update({ meteo_radar: { status: 'online', frames: [frame] } });
  h.ui.reset(); resolve({ blob: {}, contentType: 'image/png' }); await flush();
  assert.equal(h.createdUrls.length, 0); assert.equal(h.layers.filter((l) => l.type === 'image').length, 0);
});

test('forecast chart preserves zero, ignores invalid values and escapes labels', () => {
  const { ui } = harness();
  const svg = ui.chart([{ at: frame.observed_at, central: 0 }, { at: 'invalid', central: 5 }, { at: frame.observed_at, central: Infinity }], 'm', '<script>bad</script>');
  assert.match(svg, /<svg/); assert.match(svg, /0 m/); assert.match(svg, /&lt;script/); assert.doesNotMatch(svg, /Infinity|NaN|<script>/);
});

test('unchanged official map layers are not rebuilt by another source update', () => {
  const h = harness(); h.get('filter-official-industries').checked = true;
  h.ui.update({ industrial_sites: { status: 'online', sites: [{ id: '1', nom: 'Usine', lat: 45, lon: 5 }] } });
  h.ui.syncMap(); h.ui.update({ enedis: { status: 'access_required' } }); h.ui.syncMap();
  assert.equal(h.layers.filter((layer) => layer.type === 'marker').length, 1);
  h.get('filter-official-industries').checked = false; h.ui.syncMap();
  assert.equal(h.removed.filter((layer) => layer.type === 'group').length, 1);
});
