const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function harness() {
  const clock = { now: 100000 }, panel = { active: true }, calls = [], renders = [];
  const nodes = new Map(['filter-cameras', 'filter-autoroutes', 'filter-traffic-incidents'].map(id => [id, { checked: id === 'filter-cameras' }]));
  const context = vm.createContext({
    Date: { now: () => clock.now }, window: { L: {} },
    document: { getElementById: id => nodes.get(id) || null },
    isMapPanelActive: () => panel.active,
    itinisereLayer: { clearLayers() {} }, bisonLayer: { clearLayers() {} }, bisonCameraLayer: { clearLayers() {} },
    autorouteLayer: null, trafficRenderSequence: 0, mapStats: { traffic: 0 },
    cachedItinisereWebcams: [], itinisereWebcamsInFlight: null, itinisereWebcamsNextLoadAt: 0,
    API_SLOW_ENDPOINT_TIMEOUT_MS: 45000, BISON_FUTE_CAMERAS: [],
    renderTchooTrainLayer: () => 0, renderPrAutorouteLayer() {},
    updateMapSummary() {
      renders.push('render');
      // Fail quickly instead of starving the test runner if a microtask loop returns.
      if (renders.length > 100) throw Error('Repeated empty webcam render loop');
    },
    api: async (url, options) => {
      calls.push({ url, options });
      if (calls.length > 5) nodes.get('filter-cameras').checked = false;
      return { status: 'online', webcams: [] };
    },
  });
  for (const name of ['loadItinisereWebcams', 'renderTrafficOnMap']) {
    const start = source.search(new RegExp(`^async function ${name}\\(`, 'm'));
    assert.notEqual(start, -1);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  return { context, clock, panel, calls, renders, nodes };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('an empty webcam collection renders once after loading and never starts an immediate retry loop', async () => {
  const h = harness();
  await h.context.renderTrafficOnMap();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.renders.length, 2);
  for (let i = 0; i < 20; i++) await h.context.renderTrafficOnMap();
  await settle();
  assert.equal(h.calls.length, 1);
  h.clock.now += 60001;
  await h.context.renderTrafficOnMap();
  await settle();
  assert.equal(h.calls.length, 2, 'normal refresh resumes after the delay');
});

test('a webcam outage retains known cameras and delays another automatic attempt', async () => {
  const h = harness();
  const known = [{ id: 'camera-known' }];
  h.context.cachedItinisereWebcams = known;
  let attempts = 0;
  h.context.api = async () => { attempts++; throw Error('network unavailable'); };
  assert.equal(await h.context.loadItinisereWebcams(), known);
  assert.equal(await h.context.loadItinisereWebcams(), known);
  assert.equal(attempts, 1);
  await h.context.loadItinisereWebcams(true);
  assert.equal(attempts, 2, 'a forced refresh can bypass the delay');
  assert.equal(h.context.cachedItinisereWebcams, known);
});

test('overlapping webcam loads share a request and a late response does not redraw a hidden map', async () => {
  const h = harness();
  let resolve;
  h.context.api = (url, options) => {
    h.calls.push({ url, options });
    return new Promise(done => { resolve = done; });
  };
  await h.context.renderTrafficOnMap();
  const concurrent = h.context.loadItinisereWebcams();
  assert.equal(h.calls.length, 1);
  h.panel.active = false;
  resolve({ webcams: [] });
  await concurrent;
  await settle();
  assert.equal(h.renders.length, 1);
  await h.context.renderTrafficOnMap();
  assert.equal(h.renders.length, 1);
  assert.equal(h.calls.length, 1);
});
