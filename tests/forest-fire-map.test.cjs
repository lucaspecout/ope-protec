const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
function harness() {
  let now = Date.parse('2026-10-31T12:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const nodes = Object.fromEntries(['image','status','message','link'].map(name => [name, {
    hidden: false, textContent: '', src: '', removeAttribute(name) { if (name === 'src') this.src = ''; },
  }]));
  const calls = [];
  const context = vm.createContext({
    Date: Clock, Intl,
    document: {getElementById: id => nodes[id.split('-').at(-1)]},
    forestFireMapCache: null, forestFireMapFetchedAt: 0, forestFireMapLoading: null,
    api: async (url, options) => { calls.push({url,options}); return {status:'off_season', source_date:'2026-08-31', checked_date: context.forestFireMapDay(), image_url:null}; },
  });
  for (const name of ['forestFireMapDay','renderSituationForestFireMap','loadSituationForestFireMap']) {
    const start = source.indexOf(`function ${name}(`);
    const fullStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(fullStart,end+2),context);
  }
  return {context, nodes, calls, setNow: value => { now = Date.parse(value); }};
}

test('only a dated official map from today is displayed', () => {
  const {context, nodes} = harness();
  context.renderSituationForestFireMap({status:'online',source_date:'2026-10-31',image_url:'https://example.test/map.jpg'});
  assert.equal(nodes.image.hidden,false);
  assert.equal(nodes.message.hidden,true);
  assert.equal(nodes.status.textContent,'Carte officielle du jour');
});

test('an old image is removed and replaced with the off-season message', () => {
  const {context, nodes} = harness();
  nodes.image.src = 'old.jpg';
  context.renderSituationForestFireMap({status:'online',source_date:'2026-08-31',image_url:'old.jpg'});
  assert.equal(nodes.image.hidden,true);
  assert.equal(nodes.image.src,'');
  assert.equal(nodes.message.hidden,false);
  assert.match(nodes.message.textContent,/Hors saison — carte indisponible/);
  assert.match(nodes.message.textContent,/31\/08\/2026/);
});

test('retrieval time alone cannot make an undated map current', () => {
  const {context, nodes} = harness();
  context.renderSituationForestFireMap({status:'online',updated_at:'2026-10-31T12:00:00Z',image_url:'old.jpg'});
  assert.equal(nodes.image.hidden,true);
  assert.match(nodes.status.textContent,/date de mise à jour non vérifiable/);
});

test('map becomes unavailable at midnight in Paris without reloading the page', () => {
  const {context, nodes, setNow} = harness();
  const payload = {status:'online',source_date:'2026-10-31',image_url:'old.jpg'};
  setNow('2026-10-31T22:59:00Z');
  context.renderSituationForestFireMap(payload);
  assert.equal(nodes.image.hidden,false);
  setNow('2026-10-31T23:01:00Z');
  context.renderSituationForestFireMap(payload);
  assert.equal(nodes.image.hidden,true);
  assert.match(nodes.status.textContent,/Hors saison/);
});

test('off-season responses are cached briefly and rechecked after midnight', async () => {
  const {context, calls, setNow} = harness();
  await context.loadSituationForestFireMap();
  await context.loadSituationForestFireMap();
  assert.equal(calls.length,1);
  setNow('2026-10-31T12:16:00Z');
  await context.loadSituationForestFireMap();
  assert.equal(calls.length,2);
  setNow('2026-10-31T23:01:00Z');
  await context.loadSituationForestFireMap();
  assert.equal(calls.length,3);
  assert.equal(calls.at(-1).options.bypassCache,true);
});
