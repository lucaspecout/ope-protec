const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');

function harness(overrides = {}) {
  const nodes = new Map();
  const saved = new Map();
  const timers = [];
  const requests = [];
  const panel = { active: false };
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, textContent: '' });
    return nodes.get(id);
  };
  get('filter-resources-hosting-unknown').checked = true;
  const context = vm.createContext({
    document: { getElementById: get },
    HOSTING_RESOURCE_TYPES: new Set(['gymnase', 'salle_omnisports', 'salle_fetes']),
    SCHOOL_HOSTING_TYPES: new Set(['ecole_primaire', 'college', 'lycee', 'universite']),
    ISERE_BBOX: { latMin: 44.70, latMax: 45.95, lonMin: 4.70, lonMax: 6.60 },
    verifiedHostingPointsCache: [], verifiedHostingLoaded: false,
    verifiedHostingLoadPromise: null, verifiedHostingRetryTimer: null,
    verifiedHostingNextRetryAt: 0, verifiedHostingState: { status: 'pending', updated_at: null },
    STORAGE_KEYS: { staticHostingCache: 'hosting-cache' }, API_SLOW_ENDPOINT_TIMEOUT_MS: 45000,
    readSnapshot: (key) => saved.get(key),
    saveSnapshot: (key, value) => saved.set(key, value),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => {}, isMapPanelActive: () => panel.active,
    _drawResourceMarkers: () => {},
    api: async (url, options) => { requests.push({ url, options }); return complete([point]); },
    ...overrides,
  });
  for (const name of ['escapeHtml', 'normalizeYesNo', 'yesNoLabel', 'isHostingCandidateType',
    'estimateHostingCapacity', 'hostingAmenityStatus', 'buildHostingProfile',
    'hostingMatchesAdvancedFilters', 'formatHostingDetailsHtml', 'filterIserePoints',
    'normaliseVerifiedHostingPoints', 'renderHostingDataStatus',
    'scheduleVerifiedHostingRetry', 'loadVerifiedHostingIsere', 'hostingPopupOptions']) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing production function: ${name}`);
    const end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
  }
  return { context, get, saved, timers, requests, panel };
}

const point = { id: 'dataes-E001', name: 'Gymnase officiel', type: 'gymnase',
  installation_id: 'I001', installation_name: 'Complexe municipal',
  lat: 45.18, lon: 5.72, address: '1 rue des Sports, Grenoble',
  capacity: null, erp_category: 4, erp_capacity_max: 300,
  erp_capacity_label: '300 personnes au maximum',
  updated_at: '2026-10-20', source: 'https://equipements.sports.gouv.fr/pages/fiche/?refine.equip_numero=E001' };
const date = '2026-10-21T11:00:00Z';
const complete = (points) => ({ schema_version: 2, status: 'online', complete: true, points, updated_at: date });

test('hosting never invents capacities or amenities from a building type or surface', () => {
  const { context } = harness();
  for (const type of ['gymnase', 'salle_fetes', 'salle_omnisports', 'lycee']) {
    const profile = context.buildHostingProfile({ ...point, type, surface_m2: 8000 });
    assert.equal(profile.capacity, null);
    assert.equal(profile.accessibility, null);
    assert.equal(profile.sanitary, null);
    assert.equal(profile.heating, null);
    assert.equal(profile.parking, null);
    assert.equal(profile.surfaceM2, 8000);
  }
  assert.equal(context.estimateHostingCapacity({ capacity_min: 1, capacity_max: 300 }).value, null);
});

test('hosting public capacity and sourced positive and negative amenities remain distinct', () => {
  const { context } = harness();
  const profile = context.buildHostingProfile({ ...point, capacity: 600, capacity_source: 'Fiche officielle',
    sanitary: 'yes', heating: 'no', accessibility: 'partial', parking: false });
  assert.equal(profile.capacity, 600);
  assert.equal(profile.capacitySource, 'Fiche officielle');
  assert.equal(profile.sanitary, true);
  assert.equal(profile.heating, false);
  assert.equal(profile.accessibility, 'partial');
  assert.equal(profile.parking, false);
});

test('hosting filters preserve unknown values by default, while excluding known failures', () => {
  const { context, get } = harness();
  get('filter-resources-hosting-capacity').value = '500';
  get('filter-resources-hosting-surface').value = '1000';
  get('filter-resources-hosting-accessibility').value = 'accessible';
  get('filter-resources-hosting-sanitary').checked = true;
  assert.equal(context.hostingMatchesAdvancedFilters(point), true);
  assert.equal(context.hostingMatchesAdvancedFilters({ ...point, capacity: 300 }), false);
  assert.equal(context.hostingMatchesAdvancedFilters({ ...point, sanitary: 'no' }), false);
  assert.equal(context.hostingMatchesAdvancedFilters({ ...point, accessibility: 'no' }), false);
  get('filter-resources-hosting-unknown').checked = false;
  assert.equal(context.hostingMatchesAdvancedFilters(point), false);
  assert.equal(context.hostingMatchesAdvancedFilters({ ...point, capacity: 600, surface_m2: 1500,
    accessibility: 'yes', sanitary: 'yes' }), true);
});

test('ERP category upper bounds never become confirmed capacity in a strict filter', () => {
  const { context, get } = harness();
  get('filter-resources-hosting-capacity').value = '100';
  get('filter-resources-hosting-unknown').checked = false;
  assert.equal(context.hostingMatchesAdvancedFilters(point), false);
  const html = context.formatHostingDetailsHtml(point);
  assert.match(html, /Accueil non renseignée/);
  assert.match(html, /ERP : 300 personnes au maximum/);
  assert.match(html, /pas une capacité de couchage/);
});

test('hosting details show rich sourced information and escape untrusted values and links', () => {
  const { context } = harness();
  const html = context.formatHostingDetailsHtml({ ...point, surface_m2: 1200, operator: '<script>bad</script>',
    activities: ['Handball', 'Basket'], website: 'https://example.fr/equipement',
    phone: '04 00 00 00 00', locker_rooms: 2, shower: 'yes', opening_authorization: 'yes',
    accessibility_details: { entrance: 'yes', showers: 'no', parking: null },
    energy_sources: ['électricité'], spectator_capacity: 150, length_m: 40, width_m: 30 });
  assert.match(html, /Surface 1[\s\u202f]200 m²/);
  assert.match(html, /Gestionnaire : &lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /Handball, Basket/);
  assert.match(html, /entrée : oui, douches : non/);
  assert.match(html, /Arrêté d’ouverture au public : oui/);
  assert.match(html, /Fiche officielle de l’équipement/);
  assert.match(html, /Site de l’équipement/);
  assert.doesNotMatch(html, /\[object Object\]|<script>/);
  const unsafe = context.formatHostingDetailsHtml({ ...point, source: 'javascript:alert(1)', website: 'javascript:alert(2)' });
  assert.doesNotMatch(unsafe, /javascript:|href=/);
});

test('complete hosting collection replaces points, caches a dated snapshot and requests full coverage', async () => {
  const { context, requests, saved } = harness();
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingLoaded, true);
  assert.equal(context.verifiedHostingPointsCache.length, 1);
  assert.equal(context.verifiedHostingPointsCache[0].dynamic, true);
  assert.equal(context.verifiedHostingPointsCache[0].verified, true);
  assert.equal(saved.get('hosting-cache').updated_at, date);
  assert.match(requests[0].url, /limit=5000/);
  assert.equal(requests[0].options.cacheTtlMs, 0);
  assert.equal(requests[0].options.bypassCache, true);
  assert.ok(requests[0].options.timeoutMs >= 85000);
  assert.equal(context.normaliseVerifiedHostingPoints([null, {}, { ...point, lat: 48.8 }, point]).length, 1);
});

test('hosting concurrent requests share one collection and a manual refresh bypasses its cache', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const { context } = harness({ api: async () => { calls += 1; return pending; } });
  const first = context.loadVerifiedHostingIsere();
  const second = context.loadVerifiedHostingIsere();
  assert.equal(calls, 1);
  release(complete([point]));
  await Promise.all([first, second]);
  await context.loadVerifiedHostingIsere();
  assert.equal(calls, 1);
  let url;
  context.api = async (path) => { url = path; return complete([point]); };
  await context.loadVerifiedHostingIsere(true);
  assert.match(url, /refresh=true/);
});

test('cold hosting failure stays retryable without persisting a false empty collection', async () => {
  const { context, saved, timers, get } = harness({ api: async () => { throw new Error('Connection reset by peer'); } });
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingLoaded, false);
  assert.equal(context.verifiedHostingState.status, 'unavailable');
  assert.equal(context.verifiedHostingPointsCache.length, 0);
  assert.equal(saved.size, 0);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay >= 59000);
  assert.match(get('hosting-data-status').textContent, /momentanément indisponibles/);
  assert.doesNotMatch(get('hosting-data-status').textContent, /reset|Aucun équipement/);
});

test('hosting failures restore dated last-known points without advancing their collection date', async () => {
  const { context, saved } = harness({ api: async () => { throw new Error('offline'); } });
  saved.set('hosting-cache', { status: 'online', updated_at: date, points: [point] });
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingLoaded, false);
  assert.equal(context.verifiedHostingPointsCache[0].id, point.id);
  assert.equal(context.verifiedHostingState.updated_at, date);
  assert.equal(context.verifiedHostingState.status, 'stale');
  assert.equal(saved.get('hosting-cache').status, 'online');
});

test('pending hosting collection honors backend retry and preserves the previous successful set', async () => {
  const { context, timers } = harness({ api: async () => ({ status: 'pending', complete: false,
    points: [], count: null, retry_after_seconds: 5 }) });
  context.verifiedHostingPointsCache = [point];
  context.verifiedHostingState = { status: 'online', updated_at: date };
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingLoaded, false);
  assert.equal(context.verifiedHostingPointsCache.length, 1);
  assert.equal(context.verifiedHostingState.updated_at, date);
  assert.ok(timers[0].delay >= 4900 && timers[0].delay <= 5000);
});

test('partial hosting response merges available fiches without dropping earlier known equipment', async () => {
  const second = { ...point, id: 'dataes-E002', name: 'Deuxième salle' };
  const { context } = harness({ api: async () => ({ status: 'partial', complete: false, points: [second], updated_at: date }) });
  context.verifiedHostingPointsCache = [point];
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingPointsCache.length, 2);
  assert.equal(context.verifiedHostingLoaded, false);
  assert.equal(context.verifiedHostingState.status, 'stale');
});

test('newer retained full inventory replaces old equipment while older fallback never regresses it', async () => {
  const previousDate = '2026-10-19T11:00:00Z';
  const second = { ...point, id: 'dataes-E002', name: 'Nouvelle salle' };
  const { context } = harness({ api: async () => ({ schema_version: 2, status: 'stale',
    complete: false, retained_previous: true, points: [second], updated_at: date }) });
  context.verifiedHostingPointsCache = [point];
  context.verifiedHostingState = { status: 'online', updated_at: previousDate };
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingPointsCache.length, 1);
  assert.equal(context.verifiedHostingPointsCache[0].id, second.id);
  assert.equal(context.verifiedHostingState.updated_at, date);
  context.api = async () => ({ schema_version: 2, status: 'stale', complete: false,
    retained_previous: true, points: [point], updated_at: previousDate });
  await context.loadVerifiedHostingIsere(true);
  assert.equal(context.verifiedHostingPointsCache[0].id, second.id);
  assert.equal(context.verifiedHostingState.updated_at, date);
});

test('partial collection never advances the date of the last complete successful inventory', async () => {
  const { context } = harness({ api: async () => ({ status: 'partial', complete: false,
    points: [{ ...point, id: 'dataes-E002' }], updated_at: '2026-10-22T11:00:00Z' }) });
  context.verifiedHostingPointsCache = [point];
  context.verifiedHostingState = { status: 'online', updated_at: date };
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingPointsCache.length, 2);
  assert.equal(context.verifiedHostingState.updated_at, date);
  assert.equal(context.verifiedHostingLoaded, false);
});

test('only an explicit complete successful empty collection clears hosting data', async () => {
  for (const payload of [{ status: 'online', points: [] }, { status: 'unavailable', complete: true, points: [] }, {}]) {
    const { context } = harness({ api: async () => payload });
    context.verifiedHostingPointsCache = [point];
    await context.loadVerifiedHostingIsere();
    assert.equal(context.verifiedHostingPointsCache.length, 1);
    assert.equal(context.verifiedHostingLoaded, false);
  }
  const { context, saved } = harness({ api: async () => complete([]) });
  context.verifiedHostingPointsCache = [point];
  await context.loadVerifiedHostingIsere();
  assert.equal(context.verifiedHostingPointsCache.length, 0);
  assert.equal(context.verifiedHostingLoaded, true);
  assert.equal(saved.get('hosting-cache').points.length, 0);
});

test('hosting retry performs no request while the map is hidden and can recover on return', async () => {
  let calls = 0;
  const { context, timers, panel } = harness({ api: async () => { calls += 1; throw new Error('offline'); } });
  await context.loadVerifiedHostingIsere();
  timers[0].callback();
  assert.equal(calls, 1);
  assert.equal(context.verifiedHostingRetryTimer, null);
  panel.active = true;
  context.verifiedHostingNextRetryAt = 0;
  context.api = async () => { calls += 1; return complete([point]); };
  await context.loadVerifiedHostingIsere();
  assert.equal(calls, 2);
  assert.equal(context.verifiedHostingLoaded, true);
});

test('hosting status explains filters, shared sites and missing information', () => {
  const { context, get } = harness();
  context.verifiedHostingPointsCache = [point, { ...point, id: 'dataes-E002' }];
  context.verifiedHostingState = { status: 'online', updated_at: date };
  get('filter-resources-hosting-type').value = 'salle_fetes';
  context.renderHostingDataStatus();
  const text = get('hosting-data-status').textContent;
  assert.match(text, /0 \/ 2 équipement/);
  assert.match(text, /1 site/);
  assert.match(text, /2 capacité/);
  assert.match(text, /Élargissez les filtres/);
  assert.match(text, /couchage à confirmer/);
});

test('hosting popup leaves room for mobile map counters and limits its scrollable height', () => {
  const { context } = harness({
    leafletMap: { getContainer: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 800, width: 358, height: 700 }) }) },
  });
  context.document.querySelector = () => ({ getBoundingClientRect: () => ({ top: 110, bottom: 250 }) });
  const options = context.hostingPopupOptions();
  assert.equal(options.autoPanPaddingTopLeft[1], 162);
  assert.equal(options.maxWidth, 294);
  assert.ok(options.maxHeight <= 700 - 162 - 85);
});
