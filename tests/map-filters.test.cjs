const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/map_filters.js'), 'utf8');

function harness(options = {}) {
  const observers = [];
  const doc = { readyState: options.readyState || 'complete', activeElement: null };
  class Element {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.handlers = {};
      this.classList = { add: () => {} };
      this.hidden = false;
      this.open = false;
      this.scrollTop = 0;
      this.textContent = '';
    }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    dispatch(type, options = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
      let node = this;
      while (node) {
        for (const callback of node.handlers[type] || []) callback(event);
        node = node.parentElement;
      }
      return event;
    }
    focus(options) { doc.activeElement = this; this.focusOptions = options; }
    closest(selector) { let node = this; while (node) { if (selector === `#${node.id}`) return node; node = node.parentElement; } return null; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const matches = node => selector === 'summary' ? node.tagName === 'SUMMARY'
        : selector === 'details[data-map-filter-category]' ? node.tagName === 'DETAILS' && Boolean(node.dataset.mapFilterCategory)
          : selector === 'input[type="checkbox"][data-map-layer], select[data-map-layer]'
            ? 'mapLayer' in node.dataset && (node.tagName === 'INPUT' && node.type === 'checkbox' || node.tagName === 'SELECT') : false;
      return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
  }
  const create = (tag, id, parent) => { const node = new Element(tag, id); parent?.append(node); return node; };
  const scroller = create('aside', 'map-controls-panel');
  const menu = create('div', 'map-filter-menu', scroller);
  const navigation = create('nav', 'map-filter-categories', menu);
  const header = create('header', 'map-filter-category-header', menu);
  const back = create('button', 'map-filter-back', header);
  const title = create('h4', 'map-filter-current-title', header);
  const count = create('p', 'map-filter-current-count', header);
  const groups = {};
  for (const id of options.categories || ['weather', 'resources']) {
    const node = create('details', `map-filter-category-${id}`, menu);
    node.dataset.mapFilterCategory = id;
    const summary = create('summary', '', node);
    summary.textContent = id === 'weather' ? 'Météo' : 'Ressources';
    const body = create('div', '', node);
    const input = create('input', `${id}-layer`, body);
    input.type = 'checkbox';
    input.dataset.mapLayer = '';
    input.checked = true;
    const criterion = create('input', `${id}-criterion`, body);
    criterion.type = 'checkbox';
    criterion.checked = true;
    const select = create('select', `${id}-criterion-select`, body);
    groups[id] = { node, body, input, criterion, select };
  }
  doc.getElementById = id => {
    if (options.missing) return null;
    const find = node => node.id === id ? node : node.children.map(find).find(Boolean);
    return find(scroller) || null;
  };
  doc.createElement = tag => create(tag);
  doc.addEventListener = (type, callback) => { doc[type] = callback; };
  const context = vm.createContext({
    document: doc, window: {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node, config) { this.node = node; this.config = config; }
      disconnect() { this.disconnected = true; }
    },
    fetch() { throw new Error('Navigation must not request remote data'); },
  });
  vm.runInContext(source, context, { filename: 'web/map_filters.js' });
  const button = id => navigation.children.find(node => node.dataset.mapFilterOpen === id);
  return { api: context.window.MapFilters, doc, create, scroller, menu, navigation, header, back, title, count, groups, button, observers };
}

test('first load presents only categories and counts layers without nested criteria', () => {
  const h = harness();
  assert.equal(h.navigation.hidden, false);
  assert.equal(h.header.hidden, true);
  assert.equal(h.navigation.children.length, 2);
  assert.equal(h.doc.activeElement, null);
  for (const id of Object.keys(h.groups)) {
    assert.equal(h.groups[id].node.hidden, true);
    assert.equal(h.groups[id].node.open, false);
    assert.equal(h.button(id).children[1].textContent, '1');
    assert.equal(h.button(id).children[1].getAttribute('aria-hidden'), 'true');
    assert.match(h.button(id).getAttribute('aria-label'), /, 1 couche active$/);
    assert.equal(h.button(id).getAttribute('aria-controls'), `map-filter-category-${id}`);
  }
});

test('opening a category keeps the original controls and announces its position', () => {
  const h = harness();
  const original = h.groups.weather.input;
  h.button('weather').dispatch('click');
  assert.equal(h.menu.dataset.activeCategory, 'weather');
  assert.equal(h.navigation.hidden, true);
  assert.equal(h.header.hidden, false);
  assert.equal(h.groups.weather.node.hidden, false);
  assert.equal(h.groups.weather.node.open, true);
  assert.equal(h.groups.resources.node.hidden, true);
  assert.equal(h.groups.weather.input, original);
  assert.equal(h.title.textContent, 'Météo');
  assert.equal(h.title.getAttribute('tabindex'), '-1');
  assert.equal(h.doc.activeElement, h.title);
  assert.equal(h.count.textContent, '1 couche active');
  assert.equal(h.count.getAttribute('aria-live'), 'polite');
});

test('changing a filter updates the badge without moving category, focus or scroll', () => {
  const h = harness();
  h.api.openCategory('weather');
  h.scroller.scrollTop = 390;
  h.groups.weather.input.focus();
  h.groups.weather.input.checked = false;
  h.groups.weather.input.dispatch('change');
  assert.equal(h.count.textContent, 'Aucune couche active');
  assert.equal(h.button('weather').children[1].textContent, '0');
  assert.equal(h.menu.dataset.activeCategory, 'weather');
  assert.equal(h.scroller.scrollTop, 390);
  assert.equal(h.doc.activeElement, h.groups.weather.input);
  assert.equal(h.groups.weather.node.hidden, false);
});

test('return and reopen restore each scroll position and keyboard focus', () => {
  const h = harness();
  h.scroller.scrollTop = 120;
  h.button('resources').dispatch('click');
  assert.equal(h.scroller.scrollTop, 0);
  h.scroller.scrollTop = 510;
  h.back.dispatch('click');
  assert.equal(h.scroller.scrollTop, 120);
  assert.equal(h.doc.activeElement, h.button('resources'));
  assert.equal(h.header.hidden, true);
  h.button('resources').dispatch('click');
  assert.equal(h.scroller.scrollTop, 510);
  assert.equal(h.doc.activeElement, h.title);
  h.api.openCategory('weather');
  assert.equal(h.scroller.scrollTop, 0);
});

test('rerenders and repeated initialization preserve the open category and controls', () => {
  const h = harness();
  h.api.openCategory('resources', { focus: false });
  h.scroller.scrollTop = 222;
  const button = h.button('resources');
  const original = h.groups.resources.input;
  const dataNote = h.create('p', '', h.groups.resources.body);
  dataNote.textContent = 'Données actualisées';
  h.observers.find(observer => observer.node === h.groups.resources.node).callback([]);
  h.api.init();
  assert.equal(h.groups.resources.input, original);
  assert.equal(h.button('resources'), button);
  assert.equal(h.navigation.children.length, 2);
  assert.equal(h.menu.dataset.activeCategory, 'resources');
  assert.equal(h.scroller.scrollTop, 222);
  assert.equal(h.doc.activeElement, null);
});

test('Escape returns to categories while a select keeps its native Escape behavior', () => {
  const h = harness();
  h.api.openCategory('weather');
  const native = h.groups.weather.select.dispatch('keydown', { key: 'Escape' });
  assert.equal(native.defaultPrevented, false);
  assert.equal(h.menu.dataset.activeCategory, 'weather');
  const handled = h.groups.weather.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(handled.defaultPrevented, true);
  assert.equal(h.menu.dataset.activeCategory, '');
  assert.equal(h.doc.activeElement, h.button('weather'));
});

test('category buttons support arrows, Home and End without activating a layer', () => {
  const h = harness();
  for (const [id, key, expected] of [['weather', 'ArrowDown', 'resources'], ['resources', 'ArrowDown', 'weather'],
    ['weather', 'ArrowUp', 'resources'], ['resources', 'Home', 'weather'], ['weather', 'End', 'resources']]) {
    const event = h.button(id).dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.button(expected));
    assert.equal(h.navigation.hidden, false);
  }
  assert.equal(h.groups.weather.input.checked, true);
});

test('programmatic refresh supports reset without rebuilding the current category', () => {
  const h = harness();
  h.api.openCategory('resources');
  h.groups.resources.input.checked = false;
  h.api.refresh();
  assert.equal(h.count.textContent, 'Aucune couche active');
  assert.equal(h.groups.resources.node.open, true);
  assert.equal(h.api.openCategory('missing'), false);
  assert.equal(h.menu.dataset.activeCategory, 'resources');
});

test('selected background and imagery layers count only while enabled', () => {
  const h = harness();
  const imagery = h.groups.weather.select;
  imagery.dataset.mapLayer = '';
  imagery.value = 'none';
  h.api.openCategory('weather');
  assert.equal(h.count.textContent, '1 couche active');
  imagery.value = 'geocolour';
  imagery.dispatch('change');
  assert.equal(h.count.textContent, '2 couches actives');
  imagery.value = '';
  imagery.dispatch('change');
  assert.equal(h.count.textContent, '1 couche active');
  h.groups.weather.input.checked = false;
  imagery.value = 'osm';
  imagery.dispatch('change');
  assert.equal(h.count.textContent, '1 couche active');
});

test('categories without layers omit the zero badge and describe their available options', () => {
  const h = harness({ categories: ['tools', 'lists'] });
  for (const [id, expected] of [['tools', 'Outils terrain'], ['lists', 'POI et formes']]) {
    delete h.groups[id].input.dataset.mapLayer;
    h.api.openCategory(id);
    assert.equal(h.button(id).children[1].hidden, true);
    assert.equal(h.count.textContent, expected);
    assert.equal(h.groups[id].node.hidden, false);
  }
});

test('initialization waits for DOM readiness and missing markup preserves native controls', () => {
  const pending = harness({ readyState: 'loading' });
  assert.equal(pending.navigation.children.length, 0);
  pending.doc.DOMContentLoaded();
  assert.equal(pending.navigation.children.length, 2);
  const absent = harness({ missing: true });
  assert.equal(absent.api.init(), false);
  assert.equal(absent.api.openCategory('weather'), false);
  assert.equal(absent.navigation.children.length, 0);
});
