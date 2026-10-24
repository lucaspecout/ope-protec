const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/source_explorer.js'), 'utf8');

function harness(request = async () => ({})) {
  const nodes = new Map(), listeners = {}, calls = [];
  let context;
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { id, dataset: {}, hidden: false, value: '', disabled: false, innerHTML: '', textContent: '', attributes: {}, listeners: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      focus() { context.document.activeElement = this; }, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const keys = ['meteo_observations', 'meteo_radar', 'vigicrues_forecasts', 'onde_isere', 'insee_population', 'industrial_sites', 'catnat_isere', 'energy_aura', 'enedis', 'fuel_isere', 'recalls'];
  const views = keys.map(key => ({ dataset: { sourceView: key }, hidden: true, tagName: ['fuel_isere', 'onde_isere', 'catnat_isere', 'energy_aura', 'recalls'].includes(key) ? 'DETAILS' : 'ARTICLE', open: false }));
  const modes = ['cards', 'list'].map(mode => { const node = get(`mode-${mode}`); node.dataset.sourceMode = mode; return node; });
  context = vm.createContext({
    window: { OfficialSources: { activate() {} }, PublicSources: { activate() {} } },
    document: { activeElement: null, getElementById: get, addEventListener: (name, fn) => { listeners[name] = fn; }, querySelector: () => null,
      querySelectorAll: selector => selector === '[data-source-view]' ? views : selector === '[data-source-mode]' ? modes : [],
    },
    localStorage: { getItem: () => 'official-sources-panel' },
    URL, Date, Intl,
    api: (url, options) => { calls.push({ url, options }); return request(url, options); },
  });
  vm.runInContext(source, context);
  listeners.DOMContentLoaded();
  const clickMode = mode => get('official-sources-panel').listeners.click({ target: { closest: selector => selector === '[data-source-mode]' ? modes.find(node => node.dataset.sourceMode === mode) : null } });
  const input = (id, value, name = 'input') => { const node = get(id); node.value = value; node.listeners[name]({ target: node }); };
  return { ui: context.window.SourceExplorer, get, views, calls, clickMode, input };
}

test('catalogue has eleven sources, hides data and never fabricates missing counts', () => {
  const h = harness();
  assert.equal((h.get('source-catalog-grid').innerHTML.match(/data-source-open=/g) || []).length, 11);
  assert.ok(h.views.every(view => view.hidden));
  assert.equal(h.get('source-available-count').textContent, '—');
  assert.equal(h.calls.length, 0);
  h.ui.update({ fuel_isere: { status: 'unavailable', stations_total: 0 } });
  assert.match(h.get('source-catalog-grid').innerHTML, /Indisponible/);
  assert.doesNotMatch(h.get('source-catalog-grid').innerHTML, /<strong>0<\/strong>/);
});

test('search combines with theme and zero is retained for available energy', () => {
  const h = harness();
  h.ui.update({ energy_aura: { status: 'online', latest: { consumption_mw: 0 } } });
  h.input('source-theme', 'energy', 'change');
  h.input('source-search', 'electricite regionale');
  assert.equal((h.get('source-catalog-grid').innerHTML.match(/data-source-open=/g) || []).length, 1);
  assert.match(h.get('source-catalog-grid').innerHTML, /<strong>0<\/strong>/);
  h.input('source-search', 'introuvable');
  assert.equal(h.get('source-empty').hidden, false);
  h.get('source-clear-filters').listeners.click();
  assert.equal((h.get('source-catalog-grid').innerHTML.match(/data-source-open=/g) || []).length, 11);
});

test('source navigation preserves mounted filters and list mode on return', () => {
  const h = harness();
  h.clickMode('list');
  h.ui.open('fuel_isere');
  assert.equal(h.views.filter(view => !view.hidden).length, 1);
  assert.equal(h.views.find(view => view.dataset.sourceView === 'fuel_isere').open, true);
  const retainedControl = h.get('public-fuel-search'); retainedControl.value = 'Grenoble';
  h.ui.open('onde_isere'); h.ui.open('fuel_isere');
  assert.equal(retainedControl.value, 'Grenoble');
  h.get('source-back').listeners.click();
  assert.equal(h.get('source-catalog').hidden, false);
  assert.equal(h.get('source-catalog-grid').dataset.mode, 'list');
  assert.ok(h.views.every(view => view.hidden));
  assert.equal(h.calls.length, 0);
});

test('source metadata escapes provider text and rejects unsafe URLs', () => {
  const h = harness();
  h.ui.update({ meteo_radar: { status: 'error', info_state: '<img src=x onerror=alert(1)>', source_url: 'javascript:alert(1)' } });
  h.ui.open('meteo_radar');
  assert.match(h.get('source-radar-body').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.get('source-radar-body').innerHTML, /<img/);
  assert.doesNotMatch(h.get('source-detail-meta').innerHTML, /javascript:/);
  h.ui.update({ meteo_radar: { status: 'online', source_url: 'https://example.org/?a=1&b=2', frames: [] } });
  assert.equal(h.get('source-official-link').href, 'https://meteofrance.com/meteo-radar');
  assert.equal(h.get('source-official-link').hidden, false);
});

test('pending refresh stays disabled across snapshots and source navigation', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.ui.open('fuel_isere');
  const refresh = h.get('source-refresh').listeners.click();
  h.ui.update({ fuel_isere: { status: 'online', stations_total: 190 } });
  assert.equal(h.get('source-refresh').disabled, true);
  h.ui.open('onde_isere'); h.ui.open('fuel_isere');
  assert.equal(h.get('source-refresh').disabled, true);
  assert.equal(h.calls.length, 1);
  resolve({}); await refresh;
  assert.equal(h.get('source-refresh').disabled, false);
  assert.equal(h.get('source-refresh').textContent, 'Collecte demandée');
});

test('logout clears catalogue data and ignores a late refresh result', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.ui.update({ fuel_isere: { status: 'online', stations_total: 190 } });
  h.ui.open('fuel_isere');
  const refresh = h.get('source-refresh').listeners.click();
  h.ui.reset(); h.ui.open('onde_isere');
  const text = h.get('source-refresh').textContent;
  resolve({}); await refresh;
  assert.equal(h.get('source-refresh').textContent, text);
  assert.equal(h.get('source-available-count').textContent, '—');
  h.get('source-back').listeners.click();
  assert.doesNotMatch(h.get('source-catalog-grid').innerHTML, />190</);
});

test('complete application registry is merged without duplicates and every producer has a link', () => {
  const main = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
  const registryContext = vm.createContext({ anfrMetric: () => 'Inventaire ANFR' });
  const fluxStart = main.indexOf('const FLUX_SERVICES = [');
  const metaStart = main.indexOf('const SVC_CARD_META = {');
  vm.runInContext(main.slice(fluxStart, main.indexOf('\n];', fluxStart) + 3) + main.slice(metaStart, main.indexOf('\n};', metaStart) + 3) + '\nthis.services = FLUX_SERVICES; this.metadata = SVC_CARD_META;', registryContext);
  const h = harness();
  h.ui.registerServices(registryContext.services, registryContext.metadata);
  h.ui.registerServices(registryContext.services, registryContext.metadata);
  assert.equal((h.get('source-catalog-grid').innerHTML.match(/data-source-open=/g) || []).length, registryContext.services.length);
  assert.equal(h.get('source-total-count').textContent, String(registryContext.services.length));
  for (const service of registryContext.services) {
    h.ui.open(service.key);
    assert.equal(h.get('source-official-link').hidden, false, service.key);
    assert.match(h.get('source-official-link').href, /^https:\/\//, service.key);
  }
  assert.equal(h.calls.length, 0, 'opening a source reads its existing snapshot');
});

test('connected feed deltas preserve data and cannot replace curated official links', () => {
  const h = harness();
  h.ui.registerServices([{ key: 'sncf_isere', label: 'SNCF Isère', category: 'Transport', metric: data => `${data.alerts.length} alertes` }], { sncf_isere: { url: 'https://www.sncf.com/' } });
  h.ui.update({ sncf_isere: { status: 'online', alerts: [{}], source_url: 'https://untrusted.example/' } });
  h.ui.update({ fuel_isere: { status: 'online', stations_total: 190 } });
  assert.match(h.get('source-catalog-grid').innerHTML, /1 alertes/);
  h.ui.open('sncf_isere');
  assert.equal(h.get('source-official-link').href, 'https://www.sncf.com/');
  h.get('source-back').listeners.click();
  h.input('source-theme', 'transport', 'change');
  assert.equal((h.get('source-catalog-grid').innerHTML.match(/data-source-open=/g) || []).length, 1);
});

test('motorway data aggregates providers and refresh requests target the three real feeds', async () => {
  const h = harness();
  h.ui.registerServices([{ key: 'autoroutes_isere', label: 'Autoroutes Isère', category: 'Transport', metric: data => `${data.events_total} événements` }], { autoroutes_isere: { url: 'https://www.bison-fute.gouv.fr/' } }, (key, snapshot) => ({ status: 'online', events_total: snapshot.bison_fute.events_total }));
  h.ui.update({ bison_fute: { events_total: 3 } });
  assert.match(h.get('source-catalog-grid').innerHTML, /3 événements/);
  h.ui.open('autoroutes_isere');
  await h.get('source-refresh').listeners.click();
  assert.deepEqual(h.calls.map(call => call.url), ['bison_fute', 'aprr_isere', 'vinci_autoroutes'].map(key => `/external/isere/risks/${key}/refresh`));
});
