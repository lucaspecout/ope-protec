const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/script.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(fetch) {
  const context = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout,
    API_REQUEST_TIMEOUT_MS: 5000,
    API_MAX_CONCURRENT_REQUESTS: 1,
    API_MAX_RETRIES_GET: 0, API_MAX_RETRIES_NON_GET: 0,
    API_RETRY_BASE_DELAY_MS: 1,
    apiRequestQueue: [], apiActiveRequests: 0,
    apiOriginFailures: new Map(), preferredApiOrigin: null,
    token: 'fixture-only',
    window: { location: { origin: 'https://example.test' } },
    prioritizedApiOrigins: () => ['https://example.test'],
    buildApiUrl: (url) => url,
    updateApiQueueVisual() {}, logout() {},
  });
  for (const name of [
    'createApiError', 'sanitizeErrorMessage', 'isNetworkFetchError',
    'normalizeApiErrorMessage', 'wait', 'runNextQueuedApiRequest',
    'queueApiRequest', 'fetchWithTimeout', 'canRetryRequest',
    'parseJsonResponse', 'requestApiAcrossOrigins',
  ]) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.notEqual(start, -1, `Missing production function: ${name}`);
    const closing = source.slice(start).search(/\n\}\r?(?:\n|$)/);
    assert.notEqual(closing, -1, `Missing function end: ${name}`);
    const end = start + closing;
    vm.runInContext(source.slice(start, end + 2), context, { filename: 'web/script.js' });
  }
  return context;
}

test('a stalled JSON body times out after its headers and releases the request queue', async () => {
  let signal;
  const context = harness(async (_url, options) => {
    signal = options.signal;
    return {
      ok: true, status: 200,
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted body'), { name: 'AbortError' })), { once: true });
      }),
    };
  });
  await assert.rejects(context.requestApiAcrossOrigins('/operations/bootstrap', {}, {
    timeoutMs: 30, maxRetries: 0,
  }), (error) => error.cause?.isTimeout === true);
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(context.apiActiveRequests, 0);
});

test('queue concurrency includes response bodies rather than only headers', async () => {
  const readers = [];
  const context = harness(async () => ({
    ok: true, status: 200,
    text: () => new Promise((resolve) => readers.push(resolve)),
  }));
  const first = context.requestApiAcrossOrigins('/first');
  const second = context.requestApiAcrossOrigins('/second');
  await tick();
  assert.equal(readers.length, 1);
  assert.equal(context.apiActiveRequests, 1);
  readers[0]('{"id":1}');
  assert.equal((await first).id, 1);
  await tick();
  assert.equal(readers.length, 2);
  readers[1]('{"id":2}');
  assert.equal((await second).id, 2);
});

test('the initial priority snapshot bypasses a slow background response body', async () => {
  let finishBackground;
  const context = harness(async (url) => ({
    ok: true, status: 200,
    text: () => url === '/slow'
      ? new Promise((resolve) => { finishBackground = resolve; })
      : Promise.resolve('{"ready":true}'),
  }));
  const background = context.requestApiAcrossOrigins('/slow');
  await tick();
  const snapshot = await context.requestApiAcrossOrigins('/operations/bootstrap', {}, { highPriority: true });
  assert.equal(snapshot.ready, true);
  assert.equal(context.apiActiveRequests, 1);
  finishBackground('{}');
  await background;
});

test('non-retryable permission errors retain their status and message', async () => {
  let requests = 0;
  const context = harness(async () => {
    requests += 1;
    return { ok: false, status: 403, text: async () => '{"detail":"Accès refusé"}' };
  });
  await assert.rejects(context.requestApiAcrossOrigins('/api/admin/integrations', { method: 'PUT' }),
    (error) => error.status === 403 && error.message === 'Accès refusé');
  assert.equal(requests, 1);
});

test('empty successful responses do not read a body', async () => {
  const context = harness(async () => ({ ok: true, status: 204, text: () => assert.fail('Unexpected body read') }));
  assert.equal(await context.requestApiAcrossOrigins('/empty'), null);
});

test('callers without a reader still receive the original Response', async () => {
  const response = { ok: true, blob: async () => 'fixture-download' };
  const context = harness(async () => response);
  assert.equal(await context.fetchWithTimeout('/download'), response);
  assert.equal(await response.blob(), 'fixture-download');
});
