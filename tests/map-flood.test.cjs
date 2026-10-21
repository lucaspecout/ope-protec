const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function harness(zoom = 13) {
  const nodes = new Map([
    ['filter-flood-zones', { checked: true }], ['flood-zone-status', { hidden: true, textContent: '' }],
    ['flood-zone-retry', { hidden: true }], ['map-feedback', { textContent: '' }],
  ]);
  const layers = [], groups = [], panes = {}, events = new Map(), attached = new Set();
  const map = {
    getZoom: () => zoom,
    getPane: name => panes[name], createPane: name => (panes[name] = { style: {} }),
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    off(name, fn) { events.get(name)?.delete(fn); },
    removeLayer: layer => attached.delete(layer),
  };
  const L = {
    tileLayer: { wms(url, options) {
      const handlers = {};
      const layer = { url, options, on(name, fn) { handlers[name] = fn; return this; },
        emit(name) { handlers[name]?.(); }, bringToFront() {} };
      layers.push(layer); return layer;
    } },
    layerGroup() {
      const group = { layers: [], addLayer(layer) { this.layers.push(layer); return this; },
        addTo() { attached.add(this); return this; }, eachLayer(fn) { this.layers.forEach(fn); } };
      groups.push(group); return group;
    },
  };
  const context = vm.createContext({
    window: { L }, leafletMap: map, floodZoneWmsLayer: null, floodZoneLoadState: null,
    document: { getElementById: id => nodes.get(id) || null },
    setMapFeedback(message, error = false) { Object.assign(nodes.get('map-feedback'), { textContent: message, error }); },
  });
  for (const name of ['GEORISQUES_WMS_URL', 'GEORISQUES_PPR_WMS_URL', 'GEORISQUES_FLOOD_PPRI_LAYER']) {
    const line = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
    assert.ok(line, name);
    vm.runInContext(line[0], context);
  }
  const tri = source.match(/^const GEORISQUES_FLOOD_TRI_LAYERS = \[[\s\S]+?\]\.join\(',\'\);/m);
  assert.ok(tri);
  vm.runInContext(tri[0], context);
  for (const name of ['renderFloodZoneStatus', 'clearFloodZoneLayer', 'retryFloodZoneLayer', 'applyFloodZoneLayer']) {
    const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
    assert.notEqual(start, -1);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  const byKey = key => layers.find(layer => key === 'ppr' ? layer.options.layers === 'PPRN_ZONE_INOND' : layer.options.layers.includes('ALEA_SYNT'));
  const complete = layer => { layer.emit('loading'); layer.emit('tileload'); layer.emit('load'); };
  return { context, nodes, map, layers, groups, panes, events, attached, byKey, complete,
    zoom(value) { zoom = value; for (const fn of events.get('zoomend') || []) fn(); } };
}

test('PPR and TRI use the correct official services and their published map scales', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  assert.equal(h.byKey('ppr').url, 'https://mapsref.brgm.fr/wxs/georisques/risques');
  assert.equal(h.byKey('tri').url, 'https://www.georisques.gouv.fr/services');
  assert.equal(h.byKey('ppr').options.minZoom, 13);
  assert.equal(h.byKey('tri').options.minZoom, 11);
  assert.equal(h.byKey('tri').options.layers, 'ALEA_SYNT_01_01FOR_FXX,ALEA_SYNT_01_02MOY_FXX,ALEA_SYNT_01_04FAI_FXX');
  assert.equal(h.panes.floodZonePane.style.pointerEvents, 'none');
  assert.equal(h.panes.floodZonePane.style.zIndex, 450);
});

test('a completed load with failed tiles never claims that both layers succeeded', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  h.byKey('ppr').emit('loading'); h.byKey('ppr').emit('tileerror'); h.byKey('ppr').emit('load');
  h.complete(h.byKey('tri'));
  assert.match(h.nodes.get('flood-zone-status').textContent, /Affichage partiel.*PPR/);
  assert.doesNotMatch(h.nodes.get('flood-zone-status').textContent, /Zonages PPR et surfaces TRI chargés/);
  assert.equal(h.nodes.get('flood-zone-retry').hidden, false);
  assert.equal(h.attached.size, 1, 'a failed source does not remove the other source');
});

test('both sources must receive real tile loads before the full success state', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  h.byKey('ppr').emit('load');
  assert.match(h.nodes.get('flood-zone-status').textContent, /Chargement/);
  h.complete(h.byKey('ppr')); h.complete(h.byKey('tri'));
  assert.match(h.nodes.get('flood-zone-status').textContent, /Zonages PPR et surfaces TRI chargés/);
  assert.equal(h.nodes.get('flood-zone-retry').hidden, true);
});

test('complete source failure is unavailable, with a retry action', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  for (const layer of h.layers) { layer.emit('loading'); layer.emit('tileerror'); layer.emit('load'); }
  assert.match(h.nodes.get('flood-zone-status').textContent, /ne peut pas être chargé/);
  assert.equal(h.nodes.get('map-feedback').error, true);
  assert.equal(h.nodes.get('flood-zone-retry').hidden, false);
});

test('small-scale views ask for a zoom instead of reporting a service failure', () => {
  const h = harness(9); h.context.applyFloodZoneLayer();
  assert.match(h.nodes.get('flood-zone-status').textContent, /Zoomez/);
  assert.equal(h.nodes.get('flood-zone-retry').hidden, true);
  h.zoom(11); h.complete(h.byKey('tri'));
  assert.match(h.nodes.get('flood-zone-status').textContent, /Surfaces TRI chargées.*Zoomez/);
  assert.doesNotMatch(h.nodes.get('flood-zone-status').textContent, /PPR et surfaces TRI chargés/);
});

test('disable removes sources and listeners, hides retry, and ignores late tile events', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  const old = h.layers.slice();
  h.nodes.get('filter-flood-zones').checked = false;
  h.context.applyFloodZoneLayer();
  assert.equal(h.attached.size, 0);
  assert.equal(h.events.get('zoomend').size, 0);
  assert.equal(h.nodes.get('flood-zone-status').hidden, true);
  assert.equal(h.nodes.get('map-feedback').textContent, '');
  for (const layer of old) { layer.emit('tileerror'); layer.emit('load'); }
  assert.equal(h.nodes.get('map-feedback').textContent, '');
  assert.equal(h.nodes.get('flood-zone-retry').hidden, true);
});

test('retry replaces the failed group and old callbacks cannot corrupt the new status', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  const old = h.layers.slice();
  old[0].emit('tileerror');
  h.context.retryFloodZoneLayer();
  assert.equal(h.groups.length, 2);
  assert.equal(h.attached.size, 1);
  assert.equal(h.events.get('zoomend').size, 1);
  for (const layer of old) layer.emit('tileerror');
  for (const layer of h.groups[1].layers) h.complete(layer);
  assert.match(h.nodes.get('flood-zone-status').textContent, /Zonages PPR et surfaces TRI chargés/);
  assert.equal(h.nodes.get('flood-zone-retry').hidden, true);
});

test('reapplying an active layer reuses its group and does not add listeners or downloads', () => {
  const h = harness(); h.context.applyFloodZoneLayer(); h.context.applyFloodZoneLayer();
  assert.equal(h.groups.length, 1);
  assert.equal(h.layers.length, 2);
  assert.equal(h.events.get('zoomend').size, 1);
});

test('tile events update the source status while preserving feedback from another map tool', () => {
  const h = harness(); h.context.applyFloodZoneLayer();
  h.nodes.get('map-feedback').textContent = 'Itinéraire calculé.';
  for (const layer of h.layers) h.complete(layer);
  assert.match(h.nodes.get('flood-zone-status').textContent, /Zonages PPR et surfaces TRI chargés/);
  assert.equal(h.nodes.get('map-feedback').textContent, 'Itinéraire calculé.');
});
