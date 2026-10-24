const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
function harness() {
  const context = vm.createContext({ Intl, Date, URL, escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), safeDateToLocale: value => String(value) });
  for (const name of ['situationPublicData', 'buildSituationPublicModal']) {
    const start = source.indexOf(`function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  }
  return context;
}
test('monthly recalls use Paris calendar, exclude invalid and future dates, keep all scopes', () => {
  const h = harness();
  const result = h.situationPublicData({ recalls: { items: [
    { id: 1, published_at: '2026-09-30T22:30:00Z', scope: 'unspecified' },
    { id: 2, published_at: '2026-10-01T08:00:00Z' },
    { id: 3, published_at: '2026-09-30T20:00:00Z' },
    { id: 4, published_at: 'invalid' },
    { id: 5, published_at: '2026-11-01T08:00:00Z' },
  ] } }, new Date('2026-10-24T12:00:00Z'));
  assert.equal(result.monthlyRecalls.length, 2);
  assert.deepEqual(Array.from(result.recalls, row => row.id), [2, 1, 3]);
});
test('recall modal shows only 30 latest, escapes text and rejects unsafe links', () => {
  const h = harness();
  const items = Array.from({ length: 35 }, (_, i) => ({ name: `<script>${i}</script>`, published_at: new Date(Date.now() - i * 60000).toISOString(), source_url: 'javascript:alert(1)' }));
  const html = h.buildSituationPublicModal('monthly-recalls', { recalls: { status: 'online', items } });
  assert.equal((html.match(/<li>/g) || []).length, 30);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:|<script>/);
});
test('annual CatNat never falls back to truncated preview or previous year', () => {
  const h = harness();
  const year = h.situationPublicData().year;
  assert.equal(h.situationPublicData({ catnat_isere: { events: [{}] } }).annualCatnat, null);
  assert.equal(h.situationPublicData({ catnat_isere: { current_year: year - 1, current_year_events: [{}] } }).annualCatnat, null);
  const html = h.buildSituationPublicModal('annual-catnat', { catnat_isere: { status: 'partial', current_year: year, current_year_events: [{ commune: '<b>Grenoble</b>', risk: 'Inondation', published_at: `${year}-01-01` }] } });
  assert.match(html, /Collecte partielle/);
  assert.match(html, /&lt;b&gt;Grenoble/);
  assert.match(html, /Inondation/);
});
test('unavailable data stays unknown; regional zero is a valid reading', () => {
  const h = harness();
  assert.match(h.buildSituationPublicModal('monthly-recalls', {}), /indisponibles/);
  const html = h.buildSituationPublicModal('regional-energy', { energy_aura: { status: 'stale', latest: { consumption_mw: 0, production_mw: null } } });
  assert.match(html, /0 MW/);
  assert.match(html, /Indisponible/);
  assert.match(html, /Données anciennes/);
});
