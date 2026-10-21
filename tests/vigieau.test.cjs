const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
const productionFunctions = ['renderVigieauAlerts', 'vigieauLevelKey', 'vigieauLevelRank', 'vigieauWaterLabel',
  'vigieauProfileLabel', 'vigieauPanelMarkup', 'vigieauFilterChanged', 'vigieauFilteredZones', 'vigieauUsages',
  'vigieauDocumentLink', 'renderVigieauZoneList', 'vigieauZoneCard', 'vigieauUsageDetails', '_vigieauDisplayColor', 'formatWaterDate'];

function harness() {
  const nodes = new Map();
  class Element {
    constructor() { this.value = ''; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.html = ''; }
    set innerHTML(value) {
      this.html = value;
      for (const match of value.matchAll(/\bid="([^"]+)"/g)) if (!nodes.has(match[1])) nodes.set(match[1], new Element());
    }
    get innerHTML() { return this.html; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    contains() { return true; }
  }
  for (const prefix of ['vigieau', 'water-vigieau']) {
    for (const suffix of ['content', 'status', 'info']) nodes.set(`${prefix}-${suffix}`, new Element());
  }
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const context = vm.createContext({ URL, console, document: { getElementById: (id) => nodes.get(id) || null }, escapeHtml,
    setHtml(id, html) { if (nodes.has(id)) nodes.get(id).innerHTML = html; },
    setText(id, text) { if (nodes.has(id)) nodes.get(id).textContent = text; },
    setRiskText(id, text, color) { const node = nodes.get(id); if (node) { node.textContent = text; node.color = color; } },
  });
  for (const name of productionFunctions) {
    const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing function ${name}`);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  return { context, nodes, root: nodes.get('vigieau-content'), html: (id) => nodes.get(id).innerHTML,
    render: (data) => context.renderVigieauAlerts(data),
    filter(key, value) { const target = { dataset: { vigieauFilter: key }, value }; nodes.get(`vigieau-${key}`).value = value; context.vigieauFilterChanged(nodes.get('vigieau-content'), 'vigieau', { target }); },
  };
}

function zone(index, overrides = {}) {
  return {
    id: index, zone: `Zone ${index}`, code: `Z${index}`, level: 'alerte', water_type: 'SUP', water_type_label: 'Eaux superficielles',
    start_date: '2026-09-01', end_date: '2026-10-31', measure: 'Restrictions selon l’arrêté',
    communes: [{ code: '38185', name: 'Grenoble' }],
    usages: [{ name: 'Arrosage des jardins', theme: 'Arroser', description: 'Mesure détaillée à lire', profiles: ['particulier', 'collectivite'] },
      { name: 'Irrigation agricole', theme: 'Arroser', description: 'Mesure agricole', profiles: ['exploitation'] }],
    arrete: { number: '38-2026-001', url: 'https://documents.vigieau.gouv.fr/arrete.pdf', framework_url: 'https://documents.vigieau.gouv.fr/cadre.pdf' },
    ...overrides,
  };
}
const payload = (alerts, extra = {}) => ({ status: 'online', complete: true, updated_at: '2026-10-21T10:00:00Z', alerts, ...extra });

test('both views show real zone detail, severity/resource summaries and formatted validity dates', () => {
  const h = harness(); h.render(payload([zone(1), zone(2, { level: 'crise', water_type: 'SOU' })]));
  for (const prefix of ['vigieau', 'water-vigieau']) {
    assert.match(h.html(`${prefix}-summary`), /<strong>1<\/strong> crise/);
    assert.match(h.nodes.get(`${prefix}-status`).textContent, /crise/);
    assert.match(h.html(`${prefix}-list`), /Code Z1/);
    assert.match(h.html(`${prefix}-list`), /01\/09\/2026/);
    assert.match(h.html(`${prefix}-list`), /31\/10\/2026/);
    assert.match(h.html(`${prefix}-list`), /Arrêté préfectoral \(PDF\)/);
    assert.match(h.html(`${prefix}-list`), /Grenoble \(38185\)/);
  }
});

test('all 55 zones are reachable by pagination with a bounded first DOM and local filters', () => {
  const h = harness(); h.render(payload(Array.from({ length: 55 }, (_, index) => zone(index))));
  assert.equal((h.html('vigieau-list').match(/class="water-restriction-card"/g) || []).length, 12);
  assert.match(h.html('vigieau-pagination'), /Page 1 \/ 5/);
  h.root._vigieauState.page = 4; h.context.renderVigieauZoneList(h.root, 'vigieau');
  assert.match(h.html('vigieau-list'), /Zone 54/);
  assert.match(h.nodes.get('vigieau-count').textContent, /55 zone\(s\) sur 55/);
  h.filter('search', 'Z54');
  assert.equal(h.root._vigieauState.page, 0);
  assert.equal((h.html('vigieau-list').match(/class="water-restriction-card"/g) || []).length, 1);
  assert.match(h.html('vigieau-list'), /Zone 54/);
  assert.equal(h.html('vigieau-pagination'), '');
});

test('search ignores accents and supports known communes while level/resource/profile filters combine', () => {
  const h = harness(); h.render(payload([zone(1, { zone: 'Vallée de l’Isère', level: 'alerte renforcée', water_type: 'SOU' }), zone(2, { level: 'crise', water_type: 'AEP', communes: [] })]));
  h.filter('search', 'vallee'); assert.match(h.html('vigieau-list'), /Vallée/); assert.doesNotMatch(h.html('vigieau-list'), /Zone 2/);
  h.filter('search', '38185'); assert.match(h.html('vigieau-list'), /Vallée/);
  h.filter('level', 'alerte renforcée'); h.filter('water', 'SOU'); h.filter('profile', 'exploitation');
  assert.match(h.html('vigieau-list'), /1 mesure\(s\) détaillée\(s\) · Exploitations agricoles/);
  h.filter('water', 'AEP'); assert.match(h.html('vigieau-list'), /Aucune zone ne correspond/);
});

test('descriptions remain lazy until opened and are grouped and limited to the selected public', () => {
  const h = harness(); h.render(payload([zone(1)]));
  assert.doesNotMatch(h.html('vigieau-list'), /Mesure détaillée à lire|Mesure agricole/);
  const body = { dataset: {}, innerHTML: '' };
  const details = { open: true, dataset: { vigieauZone: '0' }, querySelector: () => body };
  h.root.listeners.toggle({ target: details });
  assert.match(body.innerHTML, /Mesure détaillée à lire/); assert.match(body.innerHTML, /<h5>Arroser<\/h5>/);
  const content = body.innerHTML; h.root.listeners.toggle({ target: details }); assert.equal(body.innerHTML, content);
  h.filter('profile', 'particulier');
  const filtered = h.context.vigieauUsageDetails(zone(1), 'particulier');
  assert.match(filtered, /Arrosage des jardins/); assert.doesNotMatch(filtered, /Irrigation agricole|Mesure agricole/);
});

test('provider markup and malicious links cannot become executable HTML', () => {
  const h = harness(); h.render(payload([zone(1, { zone: '<img src=x onerror=alert(1)>', code: '<script>', level_color: '" onclick="alert(1)',
    arrete: { number: '<svg>', url: 'javascript:alert(1)', framework_url: 'data:text/html,unsafe', municipal_url: 'http://insecure.test/a.pdf' },
    usages: [{ name: '<img>', theme: '<svg>', description: '<script>alert(1)</script>\nTexte', profiles: ['<img>'] }],
  })]));
  assert.match(h.html('vigieau-list'), /&lt;img/);
  assert.doesNotMatch(h.html('vigieau-list'), /<img|<script|javascript:|data:text|http:\/\/|onclick/);
  const detail = h.context.vigieauUsageDetails(h.root._vigieauAlerts[0], '');
  assert.match(detail, /&lt;script&gt;/); assert.doesNotMatch(detail, /<script|<svg|<img/);
  assert.match(h.context.vigieauDocumentLink('https://example.test/a.pdf?x="', 'Document'), /rel="noopener noreferrer"/);
});

test('pending, stale, incomplete and failed data never claim no restrictions or a green status', () => {
  for (const extra of [{ status: 'pending' }, { status: 'degraded' }, { status: 'offline' }, { status: 'error' }, { stale: true }, { complete: false }, { truncated: true }]) {
    const h = harness(); h.render(payload([], extra));
    assert.equal(h.nodes.get('vigieau-status').color, 'gris');
    assert.doesNotMatch(h.nodes.get('vigieau-status').textContent, /Aucune restriction/);
    assert.doesNotMatch(h.html('vigieau-list'), /Aucune restriction/);
    assert.match(h.html('vigieau-notice'), /officiel/);
  }
  const h = harness(); h.render(payload([]));
  assert.match(h.html('vigieau-list'), /Aucune restriction d’eau active/);
});

test('failed status retains supplied historical zones and unchanged snapshots preserve open details/filters', () => {
  const h = harness(); const data = payload([zone(1)], { status: 'degraded', stale: true }); h.render(data);
  assert.match(h.html('vigieau-list'), /Zone 1/); assert.match(h.html('vigieau-notice'), /indicatif/);
  const list = h.nodes.get('vigieau-list'); list.html += '<span data-open-detail>Ouvert</span>';
  h.render(data); assert.match(list.innerHTML, /data-open-detail/);
  h.filter('search', 'Z1'); h.render(payload([zone(1), zone(2)]));
  assert.equal(h.root._vigieauState.search, 'Z1'); assert.doesNotMatch(h.html('vigieau-list'), /Zone 2/);
});

test('legacy alerts still display without object coercion or invented commune/resource information', () => {
  const h = harness(); h.render(payload([{ zone: 'Ancienne zone', level: 'vigilance', measure: 'Économiser', usages: ['Arrosage', 'Piscine'] }]));
  assert.match(h.html('vigieau-list'), /Ancienne zone/);
  assert.match(h.html('vigieau-list'), /Ressource non renseignée/);
  assert.match(h.html('vigieau-list'), /Périmètre communal non fourni/);
  assert.match(h.context.vigieauUsageDetails(h.root._vigieauAlerts[0], ''), /Arrosage|Piscine/);
  assert.doesNotMatch(h.html('vigieau-list'), /\[object Object\]/);
});

test('unknown severity stays gray and partial detail is explicitly identified', () => {
  const h = harness(); h.render(payload([zone(1, { level: 'non définie', details_truncated: true, influenced_resource: true, communes: [null] })]));
  assert.equal(h.nodes.get('vigieau-status').color, 'gris');
  assert.match(h.html('vigieau-list'), /class="gris"/);
  assert.match(h.html('vigieau-list'), /détail de cette zone est partiel/);
  assert.match(h.html('vigieau-list'), /Ressource influencée/);
});
