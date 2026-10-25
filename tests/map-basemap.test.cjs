const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function harness() {
  const layers = [];
  const map = { removeLayer() {} };
  const context = vm.createContext({
    leafletMap: map, mapTileLayer: null, mapFloodOverlayLayer: null,
    applyGoogleTrafficFlowOverlay() {},
    window: { L: { tileLayer(url, options) {
      const layer = { url, options, addTo() { layers.push(this); return this; } };
      return layer;
    } } },
  });
  const start = source.indexOf('function applyBasemap(');
  const end = source.indexOf('\nfunction applyGoogleTrafficFlowOverlay(', start);
  vm.runInContext(source.slice(start, end), context);
  return { context, layers };
}

test('OSM uses the canonical endpoint, origin-only cross-site referrer and native zoom limit', () => {
  const { context, layers } = harness();
  context.applyBasemap('osm');
  assert.equal(layers[0].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(layers[0].options.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(layers[0].options.maxNativeZoom, 19);
  assert.equal(layers[0].options.maxZoom, 20);
  assert.match(layers[0].options.attribution, /openstreetmap.org\/copyright/);
});

test('switching between the existing basemaps still selects the requested provider', () => {
  const { context, layers } = harness();
  for (const style of ['topo', 'satellite', 'light', 'population', 'ign']) context.applyBasemap(style);
  assert.match(layers[0].url, /opentopomap/);
  assert.match(layers[1].url, /ORTHOIMAGERY/);
  assert.match(layers[2].url, /cartocdn/);
  assert.match(layers[3].url, /cartocdn/);
  assert.match(layers[4].url, /PLANIGNV2/);
});
