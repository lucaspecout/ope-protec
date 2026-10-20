const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

// Execute the production functions with a small browser/API harness. Loading the
// entire script would also register every map, geolocation and DOM interaction.
function loadFunction(context, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `Missing production function: ${name}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `Missing function end: ${name}`);
  vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Blocked on optional data')), 500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function refreshHarness(overrides = {}) {
  const calls = [];
  const elements = new Map();
  const payload = {
    dashboard: { vigilance: 'vert' },
    external_risks: { vigieau: { status: 'online' } },
    municipalities: [{ id: 1 }], events: [{ id: 2 }], logs: [{ id: 3 }], users: [{ id: 4 }],
    perf: { backend_duration_ms: 1 },
  };
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result; };
  const context = vm.createContext({
    Promise, Date, Boolean, Number, Array,
    console: { warn: record('warn') },
    STORAGE_KEYS: { activePanel: 'activePanel' },
    API_SLOW_ENDPOINT_TIMEOUT_MS: 45000,
    localStorage: { getItem: () => 'situation-panel' },
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '' });
      return elements.get(id);
    } },
    refreshAllInFlight: null,
    initialServerSnapshotReady: false,
    cachedExternalRisksSnapshot: {},
    _serverSnapshotSyncing: false,
    _liveEventsFailCount: 3,
    _lastRefreshAllTs: 0,
    withPreservedScroll: (fn) => fn(),
    api: async (...args) => { calls.push(['api', ...args]); return payload; },
    canManageUsers: () => true,
    markServerSnapshotFresh: record('markFresh'),
    renderDashboard: record('dashboard'),
    renderExternalRisks: record('risks'),
    renderApiInterconnections: record('interconnections'),
    saveSnapshot: record('save'),
    mergeExternalRisksSnapshot: (previous, next) => ({ ...previous, ...next }),
    loadMunicipalities: record('municipalities', Promise.resolve()),
    loadEvents: record('events', Promise.resolve()),
    loadLogs: record('logs', Promise.resolve()),
    loadUsers: record('users', Promise.resolve()),
    loadLdapBindPasswordStatus: record('ldap', new Promise(() => {})),
    loadDashboard: record('fallbackDashboard', Promise.resolve()),
    loadExternalRisks: record('fallbackRisks', Promise.resolve()),
    loadVigieauCard: record('vigieau', new Promise(() => {})),
    refreshMapDataInBackground: record('map', Promise.resolve()),
    renderResources: record('resources'),
    _ensureStaticDataLoaded: record('staticData'),
    startStartupQueue: record('queueStart'),
    setPanelLoading: record('panelLoading'),
    setServerSnapshotSyncing: record('syncing'),
    requestExternalRisksBackgroundRefresh: record('externalRefresh', Promise.resolve()),
    setStartupQueueCurrent: record('queueCurrent'),
    advanceStartupQueue: record('queueAdvance'),
    finishStartupQueue: record('queueFinish'),
    setText: record('text'),
    isTransientBackendError: () => false,
    isPendingServicePayload: () => false,
    sanitizeErrorMessage: (message) => message,
    ...overrides,
  });
  loadFunction(context, 'loadOperationsBootstrap');
  loadFunction(context, 'refreshAll');
  return { context, calls, payload };
}

test('one bootstrap applies each dataset once, without waiting for VigiEau or LDAP', async () => {
  const { context, calls } = refreshHarness();
  await promptly(context.refreshAll());
  assert.deepEqual(calls.filter(([name]) => name === 'api').map(([, endpoint]) => endpoint), ['/operations/bootstrap']);
  assert.equal(calls.find(([name]) => name === 'api')[2].highPriority, true);
  for (const name of ['dashboard', 'risks', 'interconnections', 'municipalities', 'events', 'logs', 'users']) {
    assert.equal(calls.filter(([called]) => called === name).length, 1, name);
  }
  assert.equal(calls.filter(([name]) => name === 'ldap').length, 0);
  assert.equal(calls.filter(([name]) => name === 'vigieau').length, 1);
  assert.equal(context.initialServerSnapshotReady, true);
  assert.equal(context.refreshAllInFlight, null);
  assert.equal(calls.at(-1)[0], 'queueFinish');
});

test('manual refresh bypasses the bootstrap cache and preserves optional refresh', async () => {
  const { context, calls } = refreshHarness();
  await promptly(context.refreshAll(true));
  const [, , options] = calls.find(([name]) => name === 'api');
  assert.equal(options.bypassCache, true);
  assert.equal(options.cacheTtlMs, 0);
  assert.equal(calls.find(([name]) => name === 'vigieau')[1], true);
});

test('pending municipality map geocoding does not hold the bootstrap loader', async () => {
  const { context, calls } = refreshHarness();
  Object.assign(context, {
    cachedMunicipalityRecords: [], cachedMunicipalities: [],
    readSnapshot: () => [],
    keepPreviousArray: (previous, next) => next,
    populateUserMunicipalityOptions() {}, renderContactsCitySuggestions() {}, renderGeorisquesPcsRisks() {},
    populateLogMunicipalityOptions() {}, syncLogScopeFields() {}, syncLogOtherFields() {}, applyMunicipalityFilters() {},
    renderMunicipalitiesOnMap: () => new Promise(() => {}),
  });
  loadFunction(context, 'loadMunicipalities');
  await promptly(context.refreshAll());
  assert.equal(context.cachedMunicipalities.length, 1);
  assert.equal(context.initialServerSnapshotReady, true);
  assert.equal(calls.at(-1)[0], 'queueFinish');
});

function municipalityMapHarness() {
  const requests = new Map();
  const feedback = [];
  const html = new Map();
  const filter = { checked: true };
  const layer = () => ({
    entries: [{ type: 'existing' }], clearCount: 0,
    clearLayers() { this.entries = []; this.clearCount += 1; },
  });
  const pcsLayer = layer();
  const pcsBoundaryLayer = layer();
  const feature = (type, value) => ({
    type, value, popup: '',
    bindPopup(popup) { this.popup = popup; return this; },
    addTo(target) { target.entries.push(this); return this; },
  });
  const context = vm.createContext({
    municipalitiesMapRenderVersion: 0,
    cachedMunicipalities: [], cachedCrisisPoints: [{ name: 'Existing' }],
    pcsLayer, pcsBoundaryLayer, mapStats: { pcs: 1 }, ISERE_BOUNDARY_STYLE: {},
    document: { getElementById: () => filter },
    setHtml: (id, markup) => html.set(id, markup), updateMapSummary() {},
    setMapFeedback: (message) => feedback.push(message),
    geocodeMunicipality: (municipality) => {
      const request = deferred();
      requests.set(municipality.id, request);
      return request.promise;
    },
    fetchMunicipalityContour: async (municipality) => ({ id: municipality.id }),
    window: { L: {
      circleMarker: (point) => feature('marker', point),
      circle: (point) => feature('crisis', point),
      geoJSON: (geometry) => feature('boundary', geometry),
    } },
  });
  loadFunction(context, 'escapeHtml');
  loadFunction(context, 'renderMunicipalitiesOnMap');
  return { context, requests, feedback, html, filter, pcsLayer, pcsBoundaryLayer };
}

test('overlapping municipality renders keep existing layers and apply only the newest result', async () => {
  const { context, requests, feedback, pcsLayer, pcsBoundaryLayer } = municipalityMapHarness();
  const older = [{ id: 1, name: 'Older', pcs_active: true, crisis_mode: true }];
  const latest = [{ id: 2, name: 'Latest', pcs_active: true, crisis_mode: true }];
  const olderRender = context.renderMunicipalitiesOnMap(older);
  const latestRender = context.renderMunicipalitiesOnMap(latest);
  assert.equal(pcsLayer.clearCount, 0);
  assert.equal(pcsBoundaryLayer.clearCount, 0);
  assert.equal(pcsLayer.entries[0].type, 'existing');

  requests.get(2).resolve({ lat: 45.2, lon: 5.2 });
  await latestRender;
  const latestEntries = pcsLayer.entries;
  assert.equal(latestEntries.length, 2);
  assert.match(latestEntries.find(({ type }) => type === 'marker').popup, /Latest/);
  assert.equal(pcsBoundaryLayer.entries[0].value.geometry.id, 2);
  assert.equal(context.cachedCrisisPoints[0].name, 'Latest');

  requests.get(1).resolve({ lat: 45.1, lon: 5.1 });
  await olderRender;
  assert.equal(pcsLayer.entries, latestEntries);
  assert.equal(pcsLayer.clearCount, 1);
  assert.equal(pcsBoundaryLayer.clearCount, 1);
  assert.equal(context.cachedMunicipalities, latest);
  assert.equal(context.cachedCrisisPoints[0].name, 'Latest');
  assert.equal(context.mapStats.pcs, 1);
  assert.equal(feedback.length, 1);
});

test('disabling PCS invalidates a pending render and clears crisis points immediately', async () => {
  const { context, requests, filter, pcsLayer, pcsBoundaryLayer } = municipalityMapHarness();
  const municipalities = [{ id: 1, name: 'Pending', pcs_active: true, crisis_mode: true }];
  const pendingRender = context.renderMunicipalitiesOnMap(municipalities);
  filter.checked = false;
  await context.renderMunicipalitiesOnMap(municipalities);
  assert.equal(pcsLayer.entries.length, 0);
  assert.equal(pcsBoundaryLayer.entries.length, 0);
  assert.equal(context.cachedCrisisPoints.length, 0);
  assert.equal(context.mapStats.pcs, 0);

  requests.get(1).resolve({ lat: 45.1, lon: 5.1 });
  await pendingRender;
  assert.equal(pcsLayer.entries.length, 0);
  assert.equal(pcsBoundaryLayer.entries.length, 0);
  assert.equal(pcsLayer.clearCount, 1);
});

test('municipality list and marker popups escape stored HTML in user data', async () => {
  const { context, requests, html, pcsLayer } = municipalityMapHarness();
  const municipalities = [{
    id: 1, pcs_active: true,
    name: '<img src=x onerror=alert(1)>',
    postal_code: '<svg onload=alert(2)>',
    manager: '<script>alert(3)</script>',
  }];
  const render = context.renderMunicipalitiesOnMap(municipalities);
  requests.get(1).resolve({ lat: 45.1, lon: 5.1 });
  await render;
  const list = html.get('pcs-list');
  const popup = pcsLayer.entries.find(({ type }) => type === 'marker').popup;
  for (const markup of [list, popup]) {
    assert.doesNotMatch(markup, /<(?:img|svg|script)\b/);
    assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(markup, /&lt;svg onload=alert\(2\)&gt;/);
  }
  assert.match(list, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test('a rendering failure always releases the panel and startup loaders', async () => {
  const { context, calls } = refreshHarness({ renderResources: () => { throw new Error('render failed'); } });
  await assert.rejects(context.refreshAll(), /render failed/);
  assert.equal(context.refreshAllInFlight, null);
  assert.deepEqual(calls.filter(([name]) => name === 'panelLoading').map(([, , loading]) => loading), [true, false]);
  assert.equal(calls.at(-1)[0], 'queueFinish');
});

test('bootstrap failure falls back to all datasets including external risks', async () => {
  const { context, calls } = refreshHarness({ api: async () => { throw new Error('bootstrap unavailable'); } });
  await promptly(context.refreshAll());
  assert.equal(calls.filter(([name]) => name === 'fallbackDashboard').length, 1);
  assert.equal(calls.filter(([name]) => name === 'fallbackRisks').length, 1);
  assert.equal(context.initialServerSnapshotReady, true);
  assert.equal(calls.at(-1)[0], 'queueFinish');
});

test('optional VigiEau rejection is handled after the critical refresh', async () => {
  const { context, calls } = refreshHarness({ loadVigieauCard: async () => { throw new Error('provider down'); } });
  await promptly(context.refreshAll());
  assert.equal(calls.filter(([name]) => name === 'warn').length, 1);
});

test('session starts one refresh and SSE immediately; polling waits for bootstrap', async () => {
  const initialRefresh = deferred();
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const elements = new Map();
  const context = vm.createContext({
    currentUser: { role: 'operateur' }, token: 'session-token',
    STORAGE_KEYS: { activePanel: 'activePanel' },
    cachedVigicruesPayload: {},
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', classList: { add() {}, remove() {} } });
      return elements.get(id);
    } },
    localStorage: { getItem: () => 'situation-panel' },
    roleLabel: (role) => role,
    refreshAll: () => { calls.push(['refresh']); return initialRefresh.promise; },
    isTransientBackendError: () => false,
    sanitizeErrorMessage: (message) => message,
  });
  for (const name of [
    'applyRoleVisibility', '_updateNotifBtn', 'showApp', 'buildServiceCards',
    'hydrateAppFromSnapshots', 'syncPendingLogs', 'initMobileNav', 'initMobileGeoLocate',
    'startAgentMarkersPolling', 'renderSituationOverview', 'setActivePanel',
    'syncMobileNavWithPanel', 'renderStations', 'syncLogScopeFields', 'syncLogOtherFields',
    'prefillEventTime', 'startAutoRefresh', 'startStationTimetableRefresh',
    'startLiveEventsRefresh', 'startSituationWallboardRefresh', 'startMapLiveRefresh',
    'startExternalRisksSSE', 'startLiveClock', 'startDataFreshnessIndicator',
  ]) context[name] = record(name);
  loadFunction(context, 'initializeAuthenticatedSession');
  await promptly(context.initializeAuthenticatedSession({ runRefreshInBackground: true }));
  assert.equal(calls.filter(([name]) => name === 'refresh').length, 1);
  assert.equal(calls.find(([name]) => name === 'setActivePanel')[2].refreshSnapshot, false);
  assert.equal(calls.filter(([name]) => name === 'startExternalRisksSSE').length, 1);
  assert.equal(calls.filter(([name]) => name === 'startSituationWallboardRefresh').length, 0);
  initialRefresh.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.find(([name]) => name === 'startSituationWallboardRefresh')[1].refreshImmediately, false);
});

test('navigation and focus refresh read snapshots without forcing external providers', async () => {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return result; };
  const context = vm.createContext({
    window: {},
    token: 'token', currentUser: { role: 'operateur' },
    STORAGE_KEYS: { activePanel: 'activePanel' },
    PANEL_TITLES: { 'situation-panel': 'Situation' },
    localStorage: { getItem: () => 'situation-panel', setItem() {} },
    document: {
      hidden: false, querySelectorAll: () => [],
      getElementById: () => ({ textContent: '', classList: { toggle() {} } }),
    },
    canAccessPanel: () => true,
    closeMobileSidebar() {}, updateGlobalLoadingVisual() {}, getStartupQueuePercent() {}, updateMobileNavActive() {},
    withPanelLoading: (panel, label, fn) => fn(),
    loadDashboard: record('dashboard', Promise.resolve()),
    loadExternalRisks: record('risks', Promise.resolve()),
    requestPriorityServicesForPanel: () => { throw new Error('Unexpected provider refresh'); },
  });
  loadFunction(context, 'setActivePanel');
  loadFunction(context, 'refreshActivePanelData');
  context.setActivePanel('situation-panel', { refreshSnapshot: false });
  assert.equal(calls.length, 0);
  context.setActivePanel('situation-panel');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(([name]) => name), ['dashboard', 'risks']);
  await context.refreshActivePanelData();
  assert.deepEqual(calls.map(([name]) => name), ['dashboard', 'risks', 'dashboard']);
});
