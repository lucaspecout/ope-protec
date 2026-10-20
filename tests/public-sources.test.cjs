const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/public_sources.js'), 'utf8');
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.html = ''; this.value = ''; this.checked = false; this.open = false; this.listeners = {}; this.dataset = {}; this.textContent = ''; }
  get innerHTML() { return this.html; }
  set innerHTML(value) { this.html = value; if (this.tagName === 'select') this.value = ''; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  dispatch(name) { return this.listeners[name]?.({ target: this }); }
}
const station = { id: '38000001', commune: '<img src=x onerror=alert(1)>', address: 'Rue test', postal_code: '38000', lat: 45.18, lon: 5.72,
  fuels: [{ fuel: 'Gazole', price_eur: 1.7, updated_at: '2026-10-20T10:00:00Z', old_price: false, shortage: null }], hours: [], services: [] };
function snapshot() { return {
  fuel_isere: { status: 'online', stations_total: 1, temporary_shortage_stations: 0, stations: [station], note: 'Déclarations, stock non garanti.' },
  onde_isere: { status: 'online', stations_total: 1, dry_stations: 1, observed_at: '2026-09-25', note: 'Observation de campagne.', stations: [{ id: 'V1', name: 'Station ruisseau', commune: 'Grenoble', river: 'Ruisseau test', flow_code: '3', flow_label: 'Assec', lat: 45.2, lon: 5.7, observed_at: '2026-09-25' }] },
  catnat_isere: { status: 'online', events_total: 1, preview_limit: 150, coverage: { communes_total: 1, communes_checked: 1 }, communes: [{ code: '38185', name: 'Grenoble', checked: true, events_total: 1 }], events: [{ id: 'ORDER', code_insee: '38185', commune: 'Grenoble', risk: 'Inondation', event_start: '1993-09-09', event_end: '1993-09-10', published_at: '1994-02-18' }] },
  energy_aura: { status: 'online', observed_at: '2026-10-20T13:45:00Z', latest: { consumption_mw: 0, generation_mw: { solaire: 0, nucleaire: null } }, generation_labels: { solaire: 'Solaire', nucleaire: 'Nucléaire' }, series: [{ at: '2026-10-20T13:45:00Z', consumption_mw: 0 }] },
  recalls: { status: 'online', items_total: 2, targeted_total: 1, unspecified_total: 1, note: 'Zone déclarative.', items: [
    { id: '123', name: 'Produit <script>unsafe</script>', brand: 'Marque', scope: 'national', active: null, published_at: '2026-10-20T10:00:00Z', source_url: 'https://rappel.conso.gouv.fr/fiche-rappel/123/interne' },
    { id: '124', name: 'Autre produit', scope: 'unspecified', active: true, published_at: '2026-10-20T09:00:00Z' },
  ] },
}; }

function harness({ active = 'official-sources-panel', request } = {}) {
  const ids = [
    'public-source-cards', 'public-fuel-summary', 'public-fuel-search', 'public-fuel-type', 'public-fuel-shortage', 'public-fuel-results',
    'public-onde-summary', 'public-onde-search', 'public-onde-flow', 'public-onde-results', 'public-catnat-summary', 'public-catnat-commune', 'public-catnat-results',
    'public-energy-summary', 'public-energy-chart', 'public-energy-generation', 'public-recalls-summary', 'public-recalls-search', 'public-recalls-scope', 'public-recalls-active', 'public-recalls-results',
    'filter-public-fuel', 'filter-public-onde', 'public-recall-detail-123',
  ];
  const selects = ['public-fuel-type', 'public-fuel-shortage', 'public-onde-flow', 'public-catnat-commune', 'public-recalls-scope', 'public-recalls-active'];
  const nodes = new Map(ids.map(id => [id, new Element(selects.includes(id) ? 'select' : 'div')]));
  ['public-fuel-type', 'public-fuel-shortage', 'public-onde-flow'].forEach(id => { nodes.get(id).value = 'all'; });
  nodes.get('public-recalls-scope').value = 'relevant'; nodes.get('public-recalls-active').value = 'active';
  const listeners = {}, calls = [], chartCalls = [], mapCalls = { removed: 0, groups: 0, popups: [], centers: [] };
  const session = { panel: active };
  const api = async (url, options) => { calls.push({ url, options }); return request ? request(url, options) : { status: 'online', events: [] }; };
  const leafletMap = { removeLayer() { mapCalls.removed++; }, setView(point, zoom) { mapCalls.centers.push({ point, zoom }); } };
  const L = {
    layerGroup() { mapCalls.groups++; return { addTo() { return this; } }; },
    circleMarker() { return { bindPopup(html) { mapCalls.popups.push(html); return this; }, addTo() { return this; } }; },
  };
  const context = vm.createContext({ window: { L, OfficialSources: { chart(points, unit) { chartCalls.push({ points, unit }); return '<svg data-test-chart></svg>'; } } }, leafletMap, URL, console, api,
    localStorage: { getItem() { return session.panel; } },
    document: { getElementById(id) { return nodes.get(id) || null; }, addEventListener(name, callback) { listeners[name] = callback; } },
    setActivePanel(id) { session.panel = id; context.window.PublicSources.activate(id); },
  });
  vm.runInContext(source, context, { filename: 'web/public_sources.js' });
  listeners.DOMContentLoaded();
  return { ui: context.window.PublicSources, nodes, calls, chartCalls, mapCalls, listeners, session };
}

test('five public feeds render with escaped provider text and no network collection', () => {
  const h = harness(); h.ui.update(snapshot());
  assert.equal((h.nodes.get('public-source-cards').innerHTML.match(/class="public-source-card"/g) || []).length, 5);
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.nodes.get('public-fuel-results').innerHTML, /<img/);
  assert.match(h.nodes.get('public-recalls-results').innerHTML, /&lt;script&gt;/);
  assert.match(h.nodes.get('public-fuel-summary').innerHTML, /stock non garanti/);
  assert.match(h.nodes.get('public-onde-results').innerHTML, /25\/09\/2026/);
  assert.equal(h.calls.length, 0);
});

test('fuel filters distinguish temporary rupture and a declared price without guaranteeing stock', () => {
  const h = harness(); h.ui.update(snapshot());
  h.nodes.get('public-fuel-shortage').value = 'temporary'; h.nodes.get('public-fuel-shortage').dispatch('input');
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /Aucune station/);
  h.nodes.get('public-fuel-shortage').value = 'priced'; h.nodes.get('public-fuel-shortage').dispatch('input');
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /Aucune rupture déclarée/);
  h.nodes.get('public-fuel-search').value = 'introuvable'; h.nodes.get('public-fuel-search').dispatch('input');
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /Aucune station/);
});

test('ONDE station filters and regional zero consumption preserve real values', () => {
  const h = harness(); h.ui.update(snapshot());
  assert.match(h.nodes.get('public-energy-summary').innerHTML, /0 MW/);
  assert.match(h.nodes.get('public-energy-generation').innerHTML, /0 MW/);
  assert.match(h.nodes.get('public-energy-generation').innerHTML, /Non renseigné/);
  assert.equal(h.chartCalls[0].points[0].central, 0);
  h.nodes.get('public-onde-flow').value = 'visible'; h.nodes.get('public-onde-flow').dispatch('input');
  assert.match(h.nodes.get('public-onde-results').innerHTML, /Aucun relevé/);
});

test('recall default scope keeps national cases and lets users review other zones', () => {
  const h = harness(); h.ui.update(snapshot());
  assert.match(h.nodes.get('public-recalls-results').innerHTML, /Échéance non renseignée/);
  assert.doesNotMatch(h.nodes.get('public-recalls-results').innerHTML, /Autre produit/);
  h.nodes.get('public-recalls-scope').value = 'unspecified'; h.nodes.get('public-recalls-scope').dispatch('input');
  assert.match(h.nodes.get('public-recalls-results').innerHTML, /Autre produit/);
  assert.equal(h.calls.length, 0);
});

test('commune history reads the authenticated cache only when selected and ignores response after logout', async () => {
  let complete;
  const h = harness({ request: () => new Promise(resolve => { complete = resolve; }) }); h.ui.update(snapshot());
  const select = h.nodes.get('public-catnat-commune'); select.value = '38185'; select.dispatch('change'); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/catnat/isere/history?code_insee=38185');
  h.ui.reset(); complete({ status: 'online', events: [{ risk: 'LATE-PRIVATE' }] }); await flush();
  assert.doesNotMatch(h.nodes.get('public-catnat-results').innerHTML, /LATE-PRIVATE/);
});

test('recall details load once on opening, escape text, and discard late response on logout', async () => {
  const h = harness({ request: async () => ({ item: { identification: '<img bad>', actions: 'Consignes publiées' } }) }); h.ui.update(snapshot());
  const details = { dataset: { publicRecallId: '123' }, open: true, matches: () => true };
  h.listeners.toggle({ target: details }); await flush();
  assert.equal(h.calls[0].url, '/api/recalls/123');
  assert.match(h.nodes.get('public-recall-detail-123').innerHTML, /&lt;img bad&gt;/);
  h.listeners.toggle({ target: details }); await flush(); assert.equal(h.calls.length, 1);
  let complete;
  const late = harness({ request: () => new Promise(resolve => { complete = resolve; }) }); late.ui.update(snapshot());
  late.listeners.toggle({ target: details }); await flush(); late.ui.reset();
  complete({ item: { actions: 'LATE-DETAIL' } }); await flush();
  assert.doesNotMatch(late.nodes.get('public-recall-detail-123').innerHTML, /LATE-DETAIL/);
});

test('unchanged snapshots do not rebuild map layers and popups escape data', () => {
  const h = harness({ active: 'map-panel' }); h.nodes.get('filter-public-fuel').checked = true; h.nodes.get('filter-public-onde').checked = true;
  const data = snapshot(); h.ui.update(data);
  assert.equal(h.mapCalls.groups, 2); assert.match(h.mapCalls.popups[0], /&lt;img/);
  h.ui.update(data); h.ui.syncMap(); assert.equal(h.mapCalls.groups, 2);
  h.nodes.get('filter-public-fuel').checked = false; h.nodes.get('filter-public-fuel').dispatch('change');
  assert.equal(h.mapCalls.removed, 1);
  h.ui.reset(); assert.equal(h.mapCalls.removed, 2);
});

test('unavailable sources show absence of data without fabricated zero counts', () => {
  const h = harness(); h.ui.update({ fuel_isere: { status: 'unavailable', error: 'Quota fournisseur' } });
  assert.match(h.nodes.get('public-fuel-summary').innerHTML, /Quota fournisseur/);
  assert.doesNotMatch(h.nodes.get('public-fuel-summary').innerHTML, /0 stations/);
  assert.match(h.nodes.get('public-fuel-results').innerHTML, /attente de collecte/);
});

test('locating a station defers centering until the map is ready and consumes the focus once', async () => {
  const h = harness(); h.ui.update(snapshot());
  const locate = { dataset: { publicLocation: 'fuel:38000001' } };
  await h.listeners.click({ target: { closest(selector) { return selector === '[data-public-location]' ? locate : null; } } });
  assert.equal(h.session.panel, 'map-panel');
  assert.equal(h.nodes.get('filter-public-fuel').checked, true);
  assert.equal(h.ui.applyMapFocus(), true);
  assert.equal(h.mapCalls.centers[0].point[0], 45.18);
  assert.equal(h.ui.applyMapFocus(), false);
});

test('fuel type changes refresh marker popups even if station identifiers are unchanged', () => {
  const h = harness({ active: 'map-panel' }); h.nodes.get('filter-public-fuel').checked = true;
  const data = snapshot(); data.fuel_isere.stations[0] = { ...station, fuels: [...station.fuels, { fuel: 'E10', price_eur: 1.6 }] };
  h.ui.update(data);
  const previous = h.mapCalls.groups;
  h.nodes.get('public-fuel-type').value = 'E10'; h.nodes.get('public-fuel-type').dispatch('input');
  assert.equal(h.mapCalls.groups, previous + 1);
  assert.doesNotMatch(h.mapCalls.popups.at(-1), /Gazole/);
  assert.match(h.mapCalls.popups.at(-1), /E10/);
});
