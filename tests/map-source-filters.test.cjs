const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function harness() {
  const nodes = new Map(), listeners = {}, layers = [], requests = [], removed = [];
  const ids = [
    'filter-official-observations', 'filter-official-industries', 'filter-official-radar', 'filter-public-fuel', 'filter-public-onde',
    'map-observation-search', 'map-observation-freshness', 'map-observation-measure', 'map-observation-results',
    'map-industry-search', 'map-industry-class', 'map-industry-results', 'official-industry-search', 'official-industry-filter',
    'map-fuel-search', 'map-fuel-type', 'map-fuel-shortage', 'map-fuel-results', 'public-fuel-search', 'public-fuel-type', 'public-fuel-shortage',
    'map-onde-search', 'map-onde-flow', 'map-onde-results', 'public-onde-search', 'public-onde-flow',
    'official-observation-table', 'official-observation-summary', 'official-weather-inline', 'official-industry-table', 'official-industry-summary',
    'public-fuel-results', 'public-fuel-summary', 'public-onde-results', 'public-onde-summary',
  ];
  for (const id of ids) nodes.set(id, {
    value: /(?:freshness|measure|class|filter|type|shortage|flow)$/.test(id) ? 'all' : '',
    checked: id.startsWith('filter-') && id !== 'filter-official-radar', innerHTML: '', textContent: '', listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
    dispatch(name) { for (const fn of this.listeners[name] || []) fn({ target: this }); },
  });
  const session = { panel: 'map-panel' };
  const leafletMap = { removeLayer(layer) { removed.push(layer); }, setView() {} };
  const L = {
    layerGroup() { const layer = { entries: [], addTo() { layers.push(this); return this; } }; return layer; },
    circleMarker(coords, options) { return { coords, options, popup: '', bindPopup(html) { this.popup = html; return this; }, addTo(layer) { layer.entries.push(this); return this; } }; },
  };
  const context = vm.createContext({
    window: { L }, leafletMap, URL, console, setInterval, clearInterval,
    localStorage: { getItem() { return session.panel; } },
    document: { getElementById(id) { return nodes.get(id) || null; }, addEventListener(name, fn) { (listeners[name] ||= []).push(fn); } },
    api: async (...args) => { requests.push(args); return { history: [] }; },
    apiFile: async (...args) => { requests.push(args); return {}; },
  });
  for (const file of ['official_sources.js', 'public_sources.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context, { filename: file });
  for (const fn of listeners.DOMContentLoaded) fn();
  const change = (id, value, event = 'change') => { nodes.get(id).value = value; nodes.get(id).dispatch(event); };
  const active = () => layers.filter(layer => !removed.includes(layer));
  const popups = () => active().flatMap(layer => layer.entries.map(marker => marker.popup)).join('\n');
  return { nodes, session, requests, layers, removed, change, active, popups, official: context.window.OfficialSources, public: context.window.PublicSources };
}

const date = '2026-10-21T12:00:00Z';
function data() {
  return {
    meteo_observations: { status: 'online', stations: [
      { id: 'a', name: 'Météo Grenoble', lat: 45.18, lon: 5.72, observed_at: date, stale: false, temperature_c: 0, rain_6m_mm: 0, gust_kmh: 0 },
      { id: 'b', name: 'Météo Vienne', lat: 45.52, lon: 4.87, observed_at: '2026-10-20T12:00:00Z', stale: true, temperature_c: 12, rain_6m_mm: null, gust_kmh: null },
      { id: 'c', name: 'Météo Voiron', lat: 45.36, lon: 5.59, observed_at: null, stale: false, temperature_c: null, rain_6m_mm: 1, gust_kmh: null },
    ] },
    industrial_sites: { status: 'online', sites: [
      { id: 'h', nom: 'Industrie haute', commune: 'Grenoble', seveso: 'haut', lat: 45.18, lon: 5.72 },
      { id: 'b', nom: 'Industrie basse', commune: 'Vienne', seveso: 'bas', lat: 45.52, lon: 4.87 },
      { id: 'n', nom: 'Industrie <script>test</script>', commune: 'Échirolles', seveso: 'non', lat: 45.15, lon: 5.72 },
    ] },
    fuel_isere: { status: 'online', stations_total: 2, stations: [
      { id: 'f1', commune: 'Grenoble', address: 'Station <img src=x>', lat: 45.18, lon: 5.72, fuels: [{ fuel: 'Gazole', price_eur: 1.6, shortage: null }, { fuel: 'E10', price_eur: null, shortage: 'temporary' }] },
      { id: 'f2', commune: 'Échirolles', address: 'Station sud', lat: 45.15, lon: 5.72, fuels: [{ fuel: 'E10', price_eur: 0, shortage: null }] },
    ] },
    onde_isere: { status: 'online', stations_total: 4, stations: [
      { id: 'o1', name: 'ONDE visible', commune: 'Grenoble', river: 'Isère', flow_code: '1a', lat: 45.18, lon: 5.72 },
      { id: 'o2', name: 'ONDE faible', commune: 'Vienne', river: 'Ruisseau', flow_code: '2', lat: 45.52, lon: 4.87 },
      { id: 'o3', name: 'ONDE sec', commune: 'Échirolles', river: 'Drac', flow_code: '3', lat: 45.15, lon: 5.72 },
      { id: 'o4', name: 'ONDE sans position', commune: 'Grenoble', flow_code: '3', lat: null, lon: null },
    ] },
  };
}
function load(h) { const snapshot = data(); h.official.update(snapshot); h.public.update(snapshot); }

test('map weather filters retain measured zero and exclude unknown measurements', () => {
  const h = harness(); load(h);
  h.change('map-observation-measure', 'wind');
  assert.match(h.popups(), /Météo Grenoble/); assert.doesNotMatch(h.popups(), /Météo Vienne|Météo Voiron/);
  assert.match(h.nodes.get('official-observation-table').innerHTML, /0 km\/h/);
  assert.match(h.nodes.get('map-observation-results').textContent, /1\/3/);
  h.change('map-observation-search', 'meteo grenoble', 'input');
  assert.match(h.nodes.get('official-observation-table').innerHTML, /Météo Grenoble/);
  assert.equal(h.requests.length, 0);
});

test('weather freshness never treats an undated observation as recent or old', () => {
  const h = harness(); load(h);
  h.change('map-observation-freshness', 'fresh');
  assert.match(h.popups(), /Météo Grenoble/); assert.doesNotMatch(h.popups(), /Météo Vienne|Météo Voiron/);
  h.change('map-observation-freshness', 'stale');
  assert.match(h.popups(), /Météo Vienne/); assert.doesNotMatch(h.popups(), /Météo Grenoble|Météo Voiron/);
  h.change('map-observation-freshness', 'all');
  assert.match(h.popups(), /Météo Voiron/);
  assert.match(h.nodes.get('official-weather-inline').innerHTML, /3 station/);
  assert.equal(h.requests.length, 0);
});

test('Seveso search and classification synchronize both directions and filter map plus table', () => {
  const h = harness(); load(h);
  h.change('map-industry-class', 'non_seveso');
  assert.equal(h.nodes.get('official-industry-filter').value, 'non');
  assert.match(h.popups(), /Industrie &lt;script&gt;/); assert.doesNotMatch(h.popups(), /Industrie haute|Industrie basse|<script>/);
  assert.match(h.nodes.get('official-industry-table').innerHTML, /&lt;script&gt;/);
  h.change('official-industry-filter', 'haut', 'input');
  assert.equal(h.nodes.get('map-industry-class').value, 'haut');
  assert.match(h.popups(), /Industrie haute/); assert.doesNotMatch(h.popups(), /Industrie basse/);
  h.change('official-industry-search', 'introuvable');
  assert.equal(h.nodes.get('map-industry-search').value, 'introuvable');
  assert.match(h.nodes.get('map-industry-results').textContent, /0\/3/);
  assert.equal(h.requests.length, 0);
});

test('fuel filters work from the menu, preserve zero price and synchronize source controls', () => {
  const h = harness(); load(h);
  h.change('map-fuel-type', 'E10'); h.change('map-fuel-shortage', 'priced');
  assert.equal(h.nodes.get('public-fuel-type').value, 'E10'); assert.equal(h.nodes.get('public-fuel-shortage').value, 'priced');
  assert.match(h.popups(), /Station-service · Échirolles/); assert.doesNotMatch(h.popups(), /Gazole|Station-service · Grenoble/);
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /0 €/);
  h.change('public-fuel-shortage', 'temporary', 'input');
  assert.equal(h.nodes.get('map-fuel-shortage').value, 'temporary');
  assert.match(h.popups(), /Rupture temporaire/); assert.match(h.popups(), /&lt;img/); assert.doesNotMatch(h.popups(), /<img/);
  assert.match(h.nodes.get('map-fuel-results').textContent, /1\/2/);
  assert.equal(h.requests.length, 0);
});

test('ONDE flow and accented search synchronize both ways and count unmapped records honestly', () => {
  const h = harness(); load(h);
  h.change('map-onde-flow', '3');
  assert.equal(h.nodes.get('public-onde-flow').value, '3');
  assert.match(h.popups(), /ONDE sec/); assert.doesNotMatch(h.popups(), /ONDE faible|ONDE visible|ONDE sans position/);
  assert.match(h.nodes.get('map-onde-results').textContent, /1 point\(s\).*2\/4/);
  h.change('public-onde-search', 'echirolles', 'input');
  assert.equal(h.nodes.get('map-onde-search').value, 'echirolles');
  assert.match(h.nodes.get('public-onde-results').innerHTML, /1 résultat/);
  h.change('map-onde-search', ''); h.change('public-onde-flow', 'visible');
  assert.equal(h.nodes.get('map-onde-flow').value, 'visible');
  assert.match(h.popups(), /ONDE visible/); assert.doesNotMatch(h.popups(), /ONDE sec|ONDE faible/);
  assert.equal(h.requests.length, 0);
});

test('changing one source filter retains all unrelated layers and repeating events does not rebuild', () => {
  const h = harness(); load(h);
  const initial = h.active(), count = h.layers.length;
  h.change('map-fuel-type', 'Gazole');
  assert.equal(h.layers.length, count + 1);
  assert.equal(initial.filter(layer => h.removed.includes(layer)).length, 1);
  h.change('map-fuel-type', 'Gazole', 'input');
  h.official.syncMap(); h.public.syncMap();
  assert.equal(h.layers.length, count + 1);
  h.change('map-industry-class', 'bas');
  assert.equal(h.layers.length, count + 2);
  assert.equal(h.requests.length, 0);
});

test('source filters survive source updates and match tables on panel activation', () => {
  const h = harness(); load(h);
  h.change('map-fuel-type', 'Gazole'); h.change('map-onde-flow', '2'); h.change('map-industry-class', 'bas');
  const snapshot = data(); snapshot.fuel_isere.updated_at = date; snapshot.industrial_sites.updated_at = date;
  h.public.update(snapshot); h.official.update(snapshot);
  h.session.panel = 'official-sources-panel'; h.public.activate(h.session.panel); h.official.activate(h.session.panel);
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /Gazole/); assert.doesNotMatch(h.nodes.get('public-fuel-results').innerHTML, /E10/);
  assert.match(h.nodes.get('public-onde-results').innerHTML, /ONDE faible/); assert.doesNotMatch(h.nodes.get('public-onde-results').innerHTML, /ONDE sec/);
  assert.match(h.nodes.get('official-industry-table').innerHTML, /Industrie basse/); assert.doesNotMatch(h.nodes.get('official-industry-table').innerHTML, /Industrie haute/);
});

test('logout resets paired filters and source counters before another session', () => {
  const h = harness(); load(h);
  h.change('map-industry-class', 'bas'); h.change('map-fuel-search', 'grenoble'); h.change('map-fuel-type', 'E10');
  h.change('map-onde-flow', '3'); h.change('map-observation-freshness', 'stale');
  h.public.reset(); h.official.reset();
  for (const id of ['map-industry-class', 'official-industry-filter', 'map-fuel-type', 'public-fuel-type', 'map-onde-flow', 'public-onde-flow', 'map-observation-freshness']) assert.equal(h.nodes.get(id).value, 'all');
  for (const id of ['map-fuel-search', 'public-fuel-search']) assert.equal(h.nodes.get(id).value, '');
  for (const id of ['map-fuel-results', 'map-onde-results', 'map-industry-results', 'map-observation-results']) assert.equal(h.nodes.get(id).textContent, '');
  assert.equal(h.active().length, 0);
});
