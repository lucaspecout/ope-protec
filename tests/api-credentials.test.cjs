const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../web/api_credentials.js'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.parent = null; this.listeners = {}; this.dataset = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false;
    this.classList = { toggle: (name, set) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (set) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  append(...nodes) { nodes.forEach((node) => { node.parent = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.children.forEach((node) => { node.parent = null; }); this.children = []; this.append(...nodes); }
  replaceWith(node) { const parent = this.parent; parent.children[parent.children.indexOf(this)] = node; node.parent = parent; this.parent = null; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  dispatch(name) { this.listeners[name]?.({ preventDefault() {} }); }
  querySelectorAll(selector) {
    const match = (node) => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector;
    return this.children.flatMap((child) => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get text() { return [this.textContent, ...this.children.map((child) => child.text)].join(' '); }
}

const service = (source = 'missing') => ({ id: 'tomtom', label: 'TomTom', description: 'Trajets', help_url: 'https://example.com/access', configured: source !== 'missing', fields: [{ id: 'api_key', label: 'Clé API', configured: source !== 'missing', source }] });
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
function harness({ admin = true, response = service(), request } = {}) {
  const nodes = new Map(['api-credentials', 'api-credentials-list', 'api-credentials-status', 'api-credentials-reload'].map((id) => [id, new Element()]));
  const calls = [];
  const session = { admin };
  const api = async (url, options = {}) => {
    calls.push({ url, options });
    if (request) return request(url, options);
    if (!options.method) return { services: [response] };
    if (options.method === 'PUT') return service('application');
    return { ok: true, message: 'Connexion réussie.', duration_ms: 100 };
  };
  const context = vm.createContext({ window: {}, URL, console, document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag) } });
  vm.runInContext(source, context, { filename: 'web/api_credentials.js' });
  const ui = context.window.ApiCredentials;
  ui.configure({ api, isAdmin: () => session.admin });
  const root = nodes.get('api-credentials-list');
  const input = () => root.querySelectorAll('input').find((node) => node.type === 'password');
  const button = (text) => root.querySelectorAll('button').find((node) => node.textContent === text);
  return { ui, nodes, root, calls, session, input, button };
}

test('credentials load only for an administrator opening Interconnexions API', async () => {
  const h = harness({ admin: false });
  h.ui.activate('api-panel'); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.nodes.get('api-credentials').hidden, true);
  h.session.admin = true;
  h.ui.activate('map-panel'); await flush(); assert.equal(h.calls.length, 0);
  h.ui.activate('api-panel'); await flush(); assert.equal(h.calls.length, 1);
  h.ui.activate('api-panel'); await flush(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.bypassCache, true);
  assert.equal(h.input().type, 'password'); assert.equal(h.input().autocomplete, 'new-password');
  assert.equal(h.input().value, '');
});

test('test submits a draft without saving and preserves it for the subsequent save', async () => {
  const h = harness(); h.ui.activate('api-panel'); await flush();
  h.input().value = 'private-value';
  h.button('Tester la connexion').dispatch('click'); await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, '/api/admin/integrations/tomtom/test');
  assert.equal(h.calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { values: { api_key: 'private-value' }, clear_fields: [] });
  assert.equal(h.calls[1].options.maxRetries, 0);
  assert.equal(h.input().value, 'private-value');
  assert.match(h.root.text, /Connexion réussie/); assert.doesNotMatch(h.root.text, /private-value/);
  h.root.querySelector('form').dispatch('submit'); await flush();
  assert.equal(h.calls[2].options.method, 'PUT'); assert.equal(h.input().value, '');
  assert.match(h.root.text, /Enregistré dans l’application/);
});

test('empty values retain current credentials and clearing an override is explicit', async () => {
  const h = harness({ response: service('application') }); h.ui.activate('api-panel'); await flush();
  h.button('Tester la connexion').dispatch('click'); await flush();
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { values: {}, clear_fields: [] });
  const checkbox = h.root.querySelectorAll('input').find((node) => node.type === 'checkbox');
  h.input().value = 'discard-this'; checkbox.checked = true; checkbox.dispatch('change');
  assert.equal(h.input().value, ''); assert.equal(h.input().disabled, true);
  h.root.querySelector('form').dispatch('submit'); await flush();
  assert.deepEqual(JSON.parse(h.calls[2].options.body), { values: {}, clear_fields: ['api_key'] });
});

test('a save with no changes does not send a request', async () => {
  const h = harness(); h.ui.activate('api-panel'); await flush();
  h.root.querySelector('form').dispatch('submit'); await flush();
  assert.equal(h.calls.length, 1); assert.match(h.root.text, /Renseignez une nouvelle valeur/);
});

test('logout clears inputs and discards a pending connection-test result', async () => {
  let complete;
  const h = harness({ request: async (_, options) => options.method ? new Promise((resolve) => { complete = resolve; }) : { services: [service()] } });
  h.ui.activate('api-panel'); await flush();
  const oldInput = h.input(); oldInput.value = 'secret-before-logout';
  h.button('Tester la connexion').dispatch('click'); await flush();
  h.ui.reset(); h.session.admin = false;
  assert.equal(oldInput.value, ''); assert.equal(h.root.children.length, 0);
  complete({ ok: true, message: 'Late result' }); await flush();
  assert.equal(h.root.children.length, 0); assert.equal(h.nodes.get('api-credentials').hidden, true);
});

test('a pending catalog cannot repopulate credentials after logout', async () => {
  let complete;
  const h = harness({ request: () => new Promise((resolve) => { complete = resolve; }) });
  h.ui.activate('api-panel'); await flush(); h.ui.reset();
  complete({ services: [service()] }); await flush(); assert.equal(h.root.children.length, 0);
});

test('upstream exception bodies are hidden and draft secrets are redacted from test messages', async () => {
  let reject = false;
  const h = harness({ request: async (_, options) => {
    if (!options.method) return { services: [service()] };
    if (reject) throw new Error('https://upstream/?key=very-secret');
    return { ok: false, message: 'Rejected very-secret', checks: [{ label: 'Provider', message: '<img src=x> very-secret' }] };
  } });
  h.ui.activate('api-panel'); await flush(); h.input().value = 'very-secret';
  h.button('Tester la connexion').dispatch('click'); await flush();
  assert.doesNotMatch(h.root.text, /very-secret/); assert.match(h.root.text, /\[masqué\]/);
  assert.equal(h.root.querySelector('img'), null);
  reject = true; h.button('Tester la connexion').dispatch('click'); await flush();
  assert.doesNotMatch(h.root.text, /very-secret|upstream/); assert.match(h.root.text, /n’a pas abouti/);
});
