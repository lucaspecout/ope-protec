const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
function harness() {
  const context = vm.createContext({
    sitrepRow: (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`,
    sitrepLevelBadge: (level) => String(level),
    sitrepTable: (headers, rows, note) => `<table>${headers.join(' · ')}${rows.join('')}</table><p>${note}</p>`,
    sitrepSection: (title, content) => `<section>${title}${content}</section>`,
  });
  for (const name of ['escapeHtml', 'mergeVigieauSlot', 'vigieauLevelKey', 'vigieauLevelRank',
    '_vigieauDisplayColor', 'vigieauWaterLabel', 'getVigieauSituationState',
    'summarizeVigieauUsages', 'buildVigieauSituationMarkup', 'buildVigieauReportMarkup']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing production function: ${name}`);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
  }
  return context;
}

const zone = { zone: 'Bassin test', level: 'crise', level_color: 'rouge', water_type: 'SOU',
  usages: [{ name: 'Arrosage', theme: 'Arroser', description: 'Mesure publiée', profiles: ['particulier'] }] };
const previous = { status: 'online', complete: true, alerts: [zone], alerts_total: 1,
  usages_total: 1, max_level: 'rouge', updated_at: '2026-10-20T12:00:00Z' };

test('a confirmed empty snapshot withdraws old restrictions and counters', () => {
  const context = harness();
  const result = context.mergeVigieauSlot(previous, { status: 'online', complete: true, alerts: [], max_level: 'vert' });
  assert.equal(result.alerts.length, 0);
  assert.equal(result.alerts_total, 0);
  assert.equal(result.usages_total, 0);
  assert.equal(result.max_level, 'vert');
  assert.equal(result.retained_previous, false);
});

test('failed, pending or incomplete empty snapshots preserve observed restrictions', () => {
  const context = harness();
  for (const status of ['offline', 'degraded', 'pending', 'stale', 'partial', 'online']) {
    const result = context.mergeVigieauSlot(previous, { status, complete: false, alerts: [], alerts_total: 0,
      max_level: 'vert', updated_at: '2026-10-21T12:00:00Z' });
    assert.equal(result.alerts, previous.alerts);
    assert.equal(result.alerts_total, 1);
    assert.equal(result.max_level, 'rouge');
    assert.equal(result.updated_at, previous.updated_at);
    assert.equal(result.retained_previous, true);
    assert.equal(context.getVigieauSituationState(result).confirmed, false);
  }
});

test('a fresh rich result replaces retained data and unrelated deltas preserve it', () => {
  const context = harness();
  const retained = context.mergeVigieauSlot(previous, { status: 'offline', alerts: [] });
  const replacement = { ...zone, zone: 'Nouvelle zone', level: 'alerte', level_color: 'jaune' };
  const result = context.mergeVigieauSlot(retained, { status: 'online', complete: true, alerts: [replacement], max_level: 'jaune' });
  assert.equal(result.alerts[0], replacement);
  assert.equal(result.retained_previous, false);
  assert.equal(context.getVigieauSituationState(result).confirmed, true);
  assert.equal(context.mergeVigieauSlot(result, {}), result);
});

test('unknown availability is never presented as confirmed absence', () => {
  const context = harness();
  const uncertain = ['pending', 'offline', 'degraded', 'stale', 'partial'].map((status) => ({ status, alerts: [] }));
  for (const payload of [...uncertain, {}, { status: 'online' }, { status: 'online', alerts: {} }]) {
    for (const render of ['buildVigieauSituationMarkup', 'buildVigieauReportMarkup']) {
      const html = context[render](payload);
      assert.match(html, /[àa] confirmer/i);
      assert.doesNotMatch(html, /Aucune restriction signalée/);
    }
  }
});

test('Situation and reports preserve total count above the eight-zone preview', () => {
  const context = harness();
  const payload = { status: 'online', complete: true, alerts: Array.from({ length: 25 }, (_, index) => ({ ...zone, zone: `Zone ${index}` })) };
  assert.equal(context.getVigieauSituationState(payload).total, 25);
  const modal = context.buildVigieauSituationMarkup(payload);
  const report = context.buildVigieauReportMarkup(payload);
  assert.match(modal, /25/);
  assert.match(report, /25 zone\(s\) signalée\(s\) au total/);
  assert.match(report, /aperçu des huit premières/);
  assert.match(report, /Arrosage/);
  assert.doesNotMatch(report, /\[object Object\]/);
  assert.doesNotMatch(report, /Zone 8</);
});

test('crisis and reinforced alert retain their severity and HTML is escaped', () => {
  const context = harness();
  for (const [level, color] of [['crise', 'rouge'], ['alerte renforcée', 'orange'], ['alerte', 'jaune'], ['vigilance', 'vert']]) {
    assert.equal(context.getVigieauSituationState({ status: 'online', alerts: [{ ...zone, level }] }).color, color);
  }
  const payload = { status: 'online', alerts: [{ ...zone, zone: '<img src=x onerror=alert(1)>', usages: [{ name: '<script>test</script>' }] }] };
  for (const render of ['buildVigieauSituationMarkup', 'buildVigieauReportMarkup']) {
    const html = context[render](payload);
    assert.match(html, /&lt;img/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>|<img/);
  }
});
