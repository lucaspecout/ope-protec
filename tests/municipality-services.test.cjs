const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/municipality_services.js'), 'utf8');
const municipality = { id: 1, name: 'Grenoble', insee_code: '38185', postal_code: '38000' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(request = async () => ({}), data = {}) {
  const calls = [], modal = { open: true }, bodies = new Map();
  const root = { isConnected: true, querySelector(selector) { return bodies.get(selector) || null; } };
  for (const key of ['risks', 'water', 'resources', 'catnat']) {
    const children = new Map(['[data-muni-water-quality]', '[data-muni-water-services]'].map(selector => [selector, { innerHTML: '' }]));
    bodies.set(`[data-muni-service-body="${key}"]`, { dataset: { muniServiceBody: key }, innerHTML: '', querySelector: selector => children.get(selector) });
    bodies.set(`[data-muni-service-refresh="${key}"]`, { disabled: false });
  }
  const context = vm.createContext({ window: {}, document: { getElementById: () => modal, addEventListener() {} }, URL, Date, console,
    api: (url, options) => { calls.push({ url, options }); return request(url, options); },
  });
  vm.runInContext(source, context);
  const ui = context.window.MunicipalityServices;
  ui.mount(root, municipality, () => data);
  return { ui, calls, modal, root, bodies, body: tab => bodies.get(`[data-muni-service-body="${tab}"]`) };
}
test('commune matching prioritizes INSEE, rejects postal-only and substring matches', () => {
  const { ui } = harness();
  assert.equal(ui.matchesMunicipality({ code_insee: '38185', commune: 'Other name' }, municipality), true);
  assert.equal(ui.matchesMunicipality({ code_insee: '38151', commune: 'Grenoble' }, municipality), false);
  assert.equal(ui.matchesMunicipality({ code_insee: '38151', details: { code_commune: '38185' } }, municipality), false);
  assert.equal(ui.matchesMunicipality({ postal_code: '38000' }, municipality), false);
  assert.equal(ui.matchesMunicipality({ commune: 'Grenoble sud' }, municipality), false);
  assert.equal(ui.matchesMunicipality({ commune: 'GRENOBLE', postal_code: '38100' }, municipality), true);
  assert.equal(ui.matchesMunicipality({ city: 'Grenoble', details: { code_departement: '38', code_commune: '185' } }, municipality), true);
  assert.equal(ui.matchesMunicipality({ commune: 'Saint Martin d’Hères' }, { name: "Saint-Martin-d'Hères", insee_code: '38421' }), true);
});
test('new tabs do not fetch before activation; CatNat is lazy and reused', async () => {
  const h = harness(async () => ({ status: 'online', events: [{ code_insee: '38185', risk: 'Inondation locale' }, { code_insee: '38151', risk: 'Autre commune' }] }));
  assert.equal(h.calls.length, 0);
  assert.match(h.ui.markup().tabs, /Ressources locales/);
  await h.ui.activate('catnat'); await h.ui.activate('catnat');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/catnat/isere/history?code_insee=38185');
  assert.match(h.body('catnat').innerHTML, /Inondation locale/);
  assert.doesNotMatch(h.body('catnat').innerHTML, /Autre commune/);
});
test('water rows are scoped, unsafe links escaped, and numerical zero is retained', async () => {
  const h = harness(async url => url.endsWith('water-quality') ? { status: 'online', code_commune: '38185', items: [{ libelle_parametre: 'Test <script>', resultat_numerique: 0, libelle_unite: 'mg/L' }] } : { status: 'online', code_commune: '38185', items: [{ prix_ttc_m3: 0, rendement_reseau: 0 }] }, {
    vigieau: { status: 'online', alerts: [{ zone: 'Zone locale', communes: [{ code: '38185' }], arrete: { url: 'javascript:alert(1)' } }, { zone: 'Zone exclue', communes: [{ code: '38151' }] }] },
    onde_isere: { stations: [{ code_insee: '38185', river: 'Cours local', flow_label: 'Assec' }, { code_insee: '38151', commune: 'Grenoble', river: 'Cours exclu' }] },
  });
  await h.ui.activate('water');
  assert.equal(h.calls.length, 2);
  assert.match(h.body('water').innerHTML, /Zone locale|Cours local/);
  assert.doesNotMatch(h.body('water').innerHTML, /Zone exclue|Cours exclu|javascript:/);
  const quality = h.body('water').querySelector('[data-muni-water-quality]').innerHTML;
  assert.match(quality, /0 mg\/L/); assert.match(quality, /&lt;script&gt;/);
  const services = h.body('water').querySelector('[data-muni-water-services]').innerHTML;
  assert.match(services, /0 €\/m³/); assert.match(services, /0 %/);
});
test('water response for another commune is never displayed', async () => {
  const h = harness(async () => ({ status: 'online', code_commune: '38151', items: [{ libelle_parametre: 'Confidentiel autre commune' }] }));
  await h.ui.activate('water');
  const quality = h.body('water').querySelector('[data-muni-water-quality]').innerHTML;
  assert.match(quality, /ne correspondent pas/); assert.doesNotMatch(quality, /Confidentiel/);
});
test('missing INSEE prevents water and CatNat requests instead of department-wide data', async () => {
  const h = harness(); h.ui.mount(h.root, { ...municipality, insee_code: '' }, () => ({}));
  await h.ui.activate('water'); await h.ui.activate('catnat');
  assert.equal(h.calls.length, 0); assert.match(h.body('catnat').innerHTML, /code INSEE/);
});
test('late responses are discarded after changing commune or closing its dialog', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.ui.activate('catnat'); await flush();
  h.ui.mount(h.root, { id: 2, name: 'Échirolles', insee_code: '38151' }, () => ({}));
  h.body('catnat').innerHTML = 'Nouvelle commune';
  resolve({ status: 'online', events: [{ code_insee: '38185', risk: 'Ancienne commune' }] }); await pending;
  assert.equal(h.body('catnat').innerHTML, 'Nouvelle commune');
  const closing = h.ui.activate('catnat'); await flush(); h.modal.open = false;
  resolve({ status: 'online', events: [] }); await closing;
  assert.doesNotMatch(h.body('catnat').innerHTML, /Historique des reconnaissances/);
});
test('failed endpoints show absence of data without exception details, and explicit retry works', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('PRIVATE upstream body'); return { status: 'online', events: [] }; });
  await h.ui.activate('catnat');
  assert.match(h.body('catnat').innerHTML, /temporairement indisponible/);
  assert.doesNotMatch(h.body('catnat').innerHTML, /PRIVATE/);
  fail = false; await h.ui.activate('catnat', true);
  assert.equal(h.calls.length, 2); assert.match(h.body('catnat').innerHTML, /Aucune reconnaissance reçue/);
});
