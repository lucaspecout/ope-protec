const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function harness(overrides = {}) {
  const nodes = new Map();
  const timers = [];
  const apiCalls = [];
  const saved = new Map();
  const draws = [];
  const panel = { active: false };
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { querySelectorAll: () => [] },
    setRiskText: (id, text, level) => Object.assign(get(id), { textContent: text, level }),
    setText: (id, text) => { get(id).textContent = text; },
    setHtml: (id, html) => { get(id).innerHTML = html; },
    createPayloadSignature: JSON.stringify,
    getFluxPayload: (key, data) => data[key] || {},
    _queuePendingServiceAutoRefresh: () => {},
    renderApiResyncClock: () => {},
    lastRenderedApiInterconnectionsSignature: null,
    lastApiResyncAt: null,
    _currentFluxFilter: 'all',
    formatApiJson: () => '{}',
    telecomPointsCache: [], telecomLoaded: false, telecomAnfrRevision: '', telecomRetryTimer: null,
    cachedExternalRisksSnapshot: {}, _telecomLoadInFlight: false,
    STORAGE_KEYS: { staticTelecomCache: 'telecom-cache' }, TELECOM_POINTS_CACHE_TTL_MS: 86400000,
    readFreshSnapshot: () => null,
    readSnapshot: (key) => saved.get(key),
    saveSnapshot: (key, value) => saved.set(key, value),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => {},
    isMapPanelActive: () => panel.active,
    leafletMap: {},
    _drawResourceMarkers: () => draws.push('draw'),
    api: async (url, options) => { apiCalls.push({ url, options }); return {}; },
    ...overrides,
  });
  for (const name of ['escapeHtml', 'anfrNumericValue', 'anfrHasConfirmedCollection', 'anfrHasKnownCollection',
    'mergeAnfrSlot', 'anfrMetric', 'anfrAvailabilityMessage', 'renderAnfrSummary',
    '_fluxServiceState', '_fluxAgeLabel', '_fluxNextLabel', '_formatInterval', 'formatElapsedSince',
    'renderApiInterconnections', 'parseTelecomGenerations', 'anfrMapRevision', 'telecomCacheRecord',
    'scheduleTelecomRetry', 'syncAnfrTelecomSnapshot', 'loadTelecomPoints']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing production function: ${name}`);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
  }
  const registryEntry = source.match(/^  \{ key: 'anfr_isere'.*$/m);
  assert.ok(registryEntry, 'ANFR service must be registered');
  vm.runInContext(`const FLUX_SERVICES = [${registryEntry[0]}];`, context);
  return { context, get, timers, apiCalls, saved, draws, panel };
}

const previous = {
  status: 'online', supports_total: 124, stations_total: 280, average_support_height_m: 19.5,
  supports_points: [{ id: '38-1', lat: 45.1, lon: 5.8 }],
  updated_at: '2026-10-20T12:00:00Z', data_release: 'Octobre 2026',
};

test('ANFR missing, null and placeholder values never become a measured zero', () => {
  const { context } = harness();
  for (const value of [undefined, null, '', ' ', false, [], {}, NaN, Infinity, -1]) {
    assert.equal(context.anfrNumericValue(value), null);
    assert.match(context.anfrMetric({ status: 'unavailable', supports_total: value }), /indisponibles/);
  }
  for (const status of ['pending', 'unavailable', 'error', 'stale']) {
    assert.match(context.anfrMetric({ status, supports_total: 0 }), /indisponibles/);
  }
  assert.match(context.anfrMetric({ status: 'online', supports_total: 0 }), /^0 support/);
});

test('legacy success metadata cannot validate a zero returned during an ANFR failure', () => {
  const { context } = harness();
  for (const metadata of [{ meta: { last_success_at: previous.updated_at } },
    { retained_previous: true, updated_at: previous.updated_at },
    { schema_version: 2, retained_previous: true, last_success_at: previous.updated_at }]) {
    const payload = { status: 'degraded', supports_total: 0, ...metadata };
    assert.equal(context.anfrHasKnownCollection(payload), false);
    assert.match(context.anfrMetric(payload), /indisponibles/);
    assert.equal(context.mergeAnfrSlot({}, payload).supports_total, null);
  }
  const retained = { status: 'stale', schema_version: 3, supports_total: 0,
    retained_previous: true, last_success_at: previous.updated_at };
  assert.equal(context.anfrHasKnownCollection(retained), true);
  assert.match(context.anfrMetric(retained), /^0 support.*dernière collecte connue/);
  assert.equal(context.anfrHasKnownCollection({ ...retained, last_success_at: 'invalid' }), false);
});

test('failed refresh retains the real ANFR collection, points and its observation date', () => {
  const { context } = harness();
  for (const status of ['pending', 'unavailable', 'error', 'stale', 'partial']) {
    const result = context.mergeAnfrSlot(previous, { status, supports_total: 0, stations_total: 0,
      supports_points: [], average_support_height_m: null, updated_at: '2026-10-21T12:00:00Z',
      data_release: '', error: "ConnectionResetError(104, 'Connection reset by peer')" });
    assert.equal(result.status, status);
    assert.equal(result.supports_total, 124);
    assert.equal(result.stations_total, 280);
    assert.equal(result.average_support_height_m, 19.5);
    assert.equal(result.supports_points, previous.supports_points);
    assert.equal(result.updated_at, previous.updated_at);
    assert.equal(result.data_release, previous.data_release);
    assert.equal(result.retained_previous, true);
    assert.match(context.anfrMetric(result), /dernière collecte connue/);
  }
  assert.equal(context.mergeAnfrSlot(previous, {}), previous);
});

test('a newer retained ANFR collection replaces an older browser snapshot during an outage', () => {
  const { context } = harness();
  const newer = { ...previous, schema_version: 3, status: 'stale', complete: false,
    retained_previous: true, supports_total: 225, stations_total: 500,
    supports_points: [{ id: 'new-antenna', lat: 45.2, lon: 5.7 }],
    updated_at: '2026-10-21T12:00:00Z', last_success_at: '2026-10-21T12:00:00Z',
    last_attempt_at: '2026-10-22T12:00:00Z', data_release: 'Nouvelle collecte',
    source: 'https://data.anfr.fr/', error: 'Source indisponible' };
  const result = context.mergeAnfrSlot(previous, newer);
  for (const key of ['schema_version', 'supports_total', 'stations_total', 'supports_points',
    'updated_at', 'last_success_at', 'last_attempt_at', 'data_release', 'source']) {
    assert.equal(result[key], newer[key], key);
  }
  assert.equal(result.status, 'stale');
  assert.equal(result.retained_previous, true);
  assert.match(context.anfrMetric(result), /225 support.*dernière collecte connue/);
  const older = context.mergeAnfrSlot(result, { ...previous, schema_version: 3, status: 'stale',
    retained_previous: true, last_success_at: previous.updated_at,
    last_attempt_at: '2026-10-23T12:00:00Z' });
  assert.equal(older.supports_total, 225);
  assert.equal(older.updated_at, newer.updated_at);
  assert.equal(older.last_attempt_at, '2026-10-23T12:00:00Z', 'refresh metadata still follows the latest response');
});

test('equal collection dates prefer the schema 3 ANFR reference and preserve its schema thereafter', () => {
  const { context } = harness();
  const verified = { ...previous, schema_version: 3, status: 'stale', complete: false,
    retained_previous: true, supports_total: 180, stations_total: 360,
    last_success_at: previous.updated_at, data_release: 'Référence mobile vérifiée' };
  const result = context.mergeAnfrSlot(previous, verified);
  assert.equal(result.supports_total, 180);
  assert.equal(result.schema_version, 3);
  assert.equal(result.data_release, verified.data_release);
  const olderSchema = context.mergeAnfrSlot(result, { ...previous, schema_version: 2,
    status: 'stale', last_success_at: previous.updated_at });
  assert.equal(olderSchema.supports_total, 180);
  assert.equal(olderSchema.schema_version, 3);
  assert.equal(olderSchema.data_release, verified.data_release);
});

test('a newer verified retained empty ANFR collection can replace old antennas', () => {
  const { context } = harness();
  const result = context.mergeAnfrSlot(previous, { schema_version: 3, status: 'stale', complete: false,
    retained_previous: true, supports_total: 0, stations_total: 0, supports_points: [],
    updated_at: '2026-10-21T12:00:00Z', last_success_at: '2026-10-21T12:00:00Z' });
  assert.equal(result.supports_total, 0);
  assert.equal(result.supports_points.length, 0);
  assert.equal(result.updated_at, '2026-10-21T12:00:00Z');
  assert.equal(result.average_support_height_m, undefined, 'old measurement fields do not leak into a new collection');
  assert.match(context.anfrMetric(result), /^0 support.*dernière collecte connue/);
});

test('a future failure timestamp and legacy success metadata cannot replace real ANFR observations with zero', () => {
  const { context } = harness();
  const result = context.mergeAnfrSlot({ ...previous, schema_version: 3 }, {
    schema_version: 2, status: 'degraded', supports_total: 0, stations_total: 0,
    supports_points: [], updated_at: '2099-01-01T12:00:00Z', retained_previous: true,
    meta: { last_success_at: '2099-01-01T12:00:00Z' }, error: 'Connection reset' });
  assert.equal(result.supports_total, previous.supports_total);
  assert.equal(result.supports_points, previous.supports_points);
  assert.equal(result.updated_at, previous.updated_at);
  assert.equal(result.schema_version, 3);
});

test('a confirmed empty ANFR collection clears stale antennas and counters', () => {
  const { context } = harness();
  const retained = context.mergeAnfrSlot(previous, { status: 'unavailable', error: 'Reset' });
  const result = context.mergeAnfrSlot(retained, { status: 'online', complete: true,
    supports_total: 0, stations_total: 0, supports_points: [], updated_at: '2026-10-21T12:00:00Z' });
  assert.equal(result.supports_total, 0);
  assert.equal(result.stations_total, 0);
  assert.equal(result.supports_points.length, 0);
  assert.equal(result.average_support_height_m, null);
  assert.equal(result.retained_previous, false);
  assert.equal(result.error, null);
  assert.match(context.anfrMetric(result), /^0 support/);
});

test('an incomplete or failed online response cannot erase the previous ANFR collection', () => {
  const { context } = harness();
  for (const flags of [{ complete: false }, { truncated: true }, { error: 'Connection reset' }]) {
    const result = context.mergeAnfrSlot(previous, { status: 'online', supports_total: 0, ...flags });
    assert.equal(result.supports_total, 124);
    assert.equal(result.updated_at, previous.updated_at);
    assert.equal(result.retained_previous, true);
  }
});

test('an initial ANFR failure is not assigned an observation timestamp or zero counters', () => {
  const { context, get } = harness();
  const result = context.mergeAnfrSlot({}, { status: 'unavailable', supports_total: 0,
    updated_at: '2026-10-21T12:00:00Z', error: 'ConnectionResetError(104)' });
  assert.equal(result.supports_total, null);
  assert.equal(result.updated_at, undefined);
  assert.equal(result.last_attempt_at, '2026-10-21T12:00:00Z');
  context.renderAnfrSummary(result);
  assert.match(get('anfr-status').textContent, /Indisponible/);
  assert.doesNotMatch(get('anfr-status').textContent, /0 support/);
  assert.doesNotMatch(get('anfr-info').textContent, /0 station|ConnectionReset/);
  assert.doesNotMatch(get('anfr-list').innerHTML, />0</);
});

test('ANFR service and interconnection views show clear failures and escape source labels', () => {
  const { context, get } = harness();
  const payload = context.mergeAnfrSlot({ ...previous, data_release: '<img src=x>' }, {
    status: 'unavailable', error: "('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))",
  });
  context.renderAnfrSummary(payload);
  assert.match(get('anfr-list').innerHTML, /&lt;img/);
  assert.match(get('anfr-list').innerHTML, /dernière collecte conservée/);
  assert.doesNotMatch(get('anfr-list').innerHTML, /<img|ConnectionResetError/);
  context.renderApiInterconnections({ anfr_isere: payload });
  const row = get('flux-service-list').innerHTML;
  assert.match(row, /124 support/);
  assert.match(row, /dernière collecte connue/);
  assert.match(row, /Nouvelle tentative automatique/);
  assert.doesNotMatch(row, /ConnectionResetError|reset by peer|Connection aborted/);
});

test('successful ANFR views preserve legitimate zero, including average height', () => {
  const { context, get } = harness();
  const payload = { status: 'online', supports_total: 0, stations_total: 0, average_support_height_m: 0 };
  context.renderAnfrSummary(payload);
  assert.match(get('anfr-status').textContent, /En ligne · 0 support/);
  assert.match(get('anfr-info').textContent, /0 station\(s\) · hauteur moyenne 0 m/);
  assert.equal(get('anfr-status').level, 'vert');
  assert.equal(context.anfrAvailabilityMessage(payload), '');
});

const outage = { id: 'outage-1', lat: 45.2, lon: 5.8, commune: 'Grenoble', operator: 'Test', data: '4G' };
const antennaResource = { id: 'anfr-old', type: 'anfr_antenna', lat: 45.1, lon: 5.7 };
const outageResource = { id: 'arcep-outage-1', type: 'arcep_mobile_outage', lat: 45.2, lon: 5.8 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('ARCEP-only legacy caches and pending empty ANFR points do not prevent a retry', async () => {
  const h = harness({ readFreshSnapshot: () => [outageResource] });
  h.context.api = async (...args) => {
    h.apiCalls.push(args);
    return { anfr_isere: { status: 'pending', supports_total: null, supports_points: [] },
      arcep_isere: { status: 'online', outages_points: [outage] } };
  };
  const points = await h.context.loadTelecomPoints();
  assert.equal(h.apiCalls.length, 1, 'an ARCEP-only cache does not complete ANFR loading');
  assert.equal(points.length, 1);
  assert.equal(points[0].type, 'arcep_mobile_outage');
  assert.equal(h.timers.length, 1, 'retry is scheduled even when ARCEP points are available');
  assert.equal(h.timers[0].delay, 180000);
  await h.timers[0].callback();
  assert.equal(h.apiCalls.length, 1, 'a hidden map performs no retry download');
  assert.equal(h.context.telecomLoaded, false, 'opening the map can resume loading');
});

test('ANFR revision recovery bypasses a cached ARCEP-only result and rebuilds only the active map', async () => {
  const h = harness({ readFreshSnapshot: () => [outageResource] });
  h.context.telecomPointsCache = [outageResource];
  h.context.telecomLoaded = true;
  const payload = { ...previous, schema_version: 3, complete: true,
    source: 'https://data.anfr.fr/visualisation/information/?id=observatoire_2g_3g_4g' };
  h.context.cachedExternalRisksSnapshot = { anfr_isere: payload, arcep_isere: { outages_points: [outage] } };
  assert.equal(h.context.syncAnfrTelecomSnapshot(payload), true);
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.draws.length, 0);
  assert.equal(h.context.telecomLoaded, false);
  h.panel.active = true;
  h.context.syncAnfrTelecomSnapshot(payload);
  await flush();
  assert.equal(h.apiCalls.length, 0, 'the new SSE snapshot already contains the antenna data');
  assert.equal(h.draws.length, 1);
  const points = h.context.telecomPointsCache;
  assert.equal(points.filter((point) => point.type === 'anfr_antenna').length, 1);
  assert.equal(points.filter((point) => point.type === 'arcep_mobile_outage').length, 1);
  assert.equal(points[0].source, payload.source);
  assert.equal(h.context.syncAnfrTelecomSnapshot(payload), false, 'the same revision causes no rebuild');
  assert.equal(h.draws.length, 1);
  assert.ok(h.saved.get('telecom-cache').anfr_revision);
});

test('a confirmed empty ANFR map revision clears cached antennas without erasing ARCEP points', async () => {
  const h = harness({ readFreshSnapshot: () => [antennaResource, outageResource] });
  h.context.telecomPointsCache = [antennaResource, outageResource];
  h.context.cachedExternalRisksSnapshot = { anfr_isere: { schema_version: 3, status: 'online',
    complete: true, supports_total: 0, supports_points: [], updated_at: previous.updated_at },
  arcep_isere: { outages_points: [outage] } };
  const points = await h.context.loadTelecomPoints();
  assert.equal(points.length, 1);
  assert.equal(points[0].type, 'arcep_mobile_outage');
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.timers.length, 0);
});

test('an ANFR failure preserves existing map antennas and retries past the response cache', async () => {
  const h = harness();
  h.panel.active = true;
  h.context.telecomPointsCache = [antennaResource];
  h.context.api = async (url, options) => {
    h.apiCalls.push({ url, options });
    return { anfr_isere: { status: 'unavailable', supports_points: [] }, arcep_isere: { outages_points: [outage] } };
  };
  await h.context.loadTelecomPoints();
  assert.equal(h.context.telecomPointsCache.filter((point) => point.type === 'anfr_antenna').length, 1);
  await h.timers[0].callback();
  assert.equal(h.apiCalls.length, 2);
  assert.equal(h.apiCalls[1].options.bypassCache, true);
  assert.equal(h.apiCalls[1].options.cacheTtlMs, 0);
  assert.equal(h.draws.length, 1);
});

test('ANFR recovery arriving during an older HTTP response supplies the current map revision', async () => {
  const h = harness();
  let finish;
  h.context.api = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.context.loadTelecomPoints();
  h.context.cachedExternalRisksSnapshot = { anfr_isere: { ...previous, schema_version: 3 } };
  finish({ anfr_isere: { status: 'pending', supports_points: [] }, arcep_isere: { outages_points: [outage] } });
  const points = await pending;
  assert.equal(points.filter((point) => point.type === 'anfr_antenna').length, 1);
  assert.equal(h.context.telecomAnfrRevision, h.context.anfrMapRevision(h.context.cachedExternalRisksSnapshot.anfr_isere));
  assert.equal(h.timers.length, 0);
});
