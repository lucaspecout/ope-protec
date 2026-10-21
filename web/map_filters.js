/* Keep the map controls in place while navigating their categories. */
(function () {
  'use strict';

  const descriptions = {
    basemap: 'Fond, relief et satellite',
    weather: 'Mesures, pluie et imagerie',
    water: 'Crues, écoulement et inondations',
    risks: 'Industrie, séismes et feux',
    resources: 'Accueil, secours et réseaux',
    traffic: 'Routes, carburants et transports',
    mountain: 'Cols et avalanches',
    tools: 'Itinéraire, dessin et analyse',
    lists: 'Points et dessins ajoutés',
  };
  let controller = null;
  let activeCategory = null;
  const scrollPositions = new Map();

  function activeText(count) {
    return count === 0 ? 'Aucune couche active' : `${count} couche${count > 1 ? 's' : ''} active${count > 1 ? 's' : ''}`;
  }

  function refresh() {
    if (!controller) return;
    for (const category of controller.categories) {
      // Amenities and source criteria refine one layer; they are not layers.
      const layers = [...category.node.querySelectorAll('input[type="checkbox"][data-map-layer], select[data-map-layer]')];
      const count = layers.filter(input => input.tagName === 'SELECT'
        ? Boolean(input.value) && input.value !== 'none' : input.checked).length;
      const label = layers.length ? activeText(count)
        : category.id === 'tools' ? 'Outils terrain'
          : category.id === 'lists' ? 'POI et formes' : 'Ajustez les options de cette catégorie';
      category.badge.hidden = layers.length === 0;
      category.badge.textContent = String(count);
      category.badge.setAttribute('aria-hidden', 'true');
      category.button.setAttribute('aria-label', `${category.title}, ${label}`);
      if (category.id === activeCategory && controller.count.textContent !== label) {
        controller.count.textContent = label;
      }
    }
  }

  function saveScroll() {
    if (controller?.scroller) scrollPositions.set(activeCategory || '', controller.scroller.scrollTop);
  }

  function restoreScroll(category) {
    if (controller?.scroller) controller.scroller.scrollTop = scrollPositions.get(category || '') || 0;
  }

  function focus(node) {
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  function openCategory(id, options = {}) {
    if (!controller) init();
    const selected = controller?.categories.find(category => category.id === id);
    if (!selected) return false;
    if (activeCategory === id) {
      refresh();
      return true;
    }
    saveScroll();
    activeCategory = id;
    controller.root.dataset.activeCategory = id;
    controller.navigation.hidden = true;
    controller.header.hidden = false;
    controller.title.textContent = selected.title;
    for (const category of controller.categories) {
      const isSelected = category === selected;
      category.node.hidden = !isSelected;
      category.node.open = isSelected;
      category.button.setAttribute('aria-expanded', String(isSelected));
    }
    refresh();
    restoreScroll(id);
    if (options.focus !== false) focus(controller.title);
    return true;
  }

  function showCategories(options = {}) {
    if (!controller) return false;
    const previous = activeCategory;
    saveScroll();
    activeCategory = null;
    controller.root.dataset.activeCategory = '';
    controller.navigation.hidden = false;
    controller.header.hidden = true;
    for (const category of controller.categories) {
      category.node.hidden = true;
      category.node.open = false;
      category.button.setAttribute('aria-expanded', 'false');
    }
    refresh();
    restoreScroll(null);
    if (options.focus !== false && previous) {
      focus(controller.categories.find(category => category.id === previous)?.button);
    }
    return true;
  }

  function init() {
    const root = document.getElementById('map-filter-menu');
    if (!root) return false;
    if (controller?.root === root) {
      refresh();
      return true;
    }
    const navigation = document.getElementById('map-filter-categories');
    const header = document.getElementById('map-filter-category-header');
    const back = document.getElementById('map-filter-back');
    const title = document.getElementById('map-filter-current-title');
    const count = document.getElementById('map-filter-current-count');
    if (!navigation || !header || !back || !title || !count) return false;
    const nodes = [...root.querySelectorAll('details[data-map-filter-category]')];
    if (!nodes.length) return false;
    controller?.observers.forEach(observer => observer.disconnect());
    const previous = activeCategory;
    navigation.replaceChildren();
    const categories = nodes.map(node => {
      const id = node.dataset.mapFilterCategory;
      const name = node.querySelector('summary')?.textContent.trim() || id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-filter-category-button';
      button.dataset.mapFilterOpen = id;
      button.setAttribute('aria-controls', node.id);
      button.setAttribute('aria-expanded', 'false');
      const label = document.createElement('span');
      label.className = 'map-filter-category-label';
      const nameNode = document.createElement('strong');
      nameNode.textContent = name;
      const description = document.createElement('small');
      description.textContent = node.dataset.mapFilterDescription || descriptions[id] || '';
      label.append(nameNode, description);
      const badge = document.createElement('span');
      badge.className = 'map-filter-category-count';
      const arrow = document.createElement('span');
      arrow.className = 'map-filter-category-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      button.append(label, badge, arrow);
      button.addEventListener('click', () => openCategory(id));
      navigation.append(button);
      return { id, node, title: name, button, badge };
    });
    controller = { root, navigation, header, title, count, categories, observers: [],
      scroller: root.closest('#map-controls-panel') || root.parentElement };
    title.setAttribute('tabindex', '-1');
    count.setAttribute('aria-live', 'polite');
    back.addEventListener('click', () => showCategories());
    root.addEventListener('change', refresh);
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && activeCategory && event.target.tagName !== 'SELECT') {
        event.preventDefault();
        showCategories();
      }
    });
    navigation.addEventListener('keydown', event => {
      const index = categories.findIndex(category => category.button === event.target);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % categories.length;
      if (event.key === 'ArrowUp') next = (index + categories.length - 1) % categories.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = categories.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      focus(categories[next].button);
    });
    if (typeof MutationObserver !== 'undefined') {
      for (const category of categories) {
        const observer = new MutationObserver(refresh);
        observer.observe(category.node, { childList: true, subtree: true, attributes: true, attributeFilter: ['checked'] });
        controller.observers.push(observer);
      }
    }
    root.classList.add('map-filter-menu--enhanced');
    // Native details remain the fallback when this small enhancement cannot run.
    activeCategory = null;
    if (previous && categories.some(category => category.id === previous)) {
      openCategory(previous, { focus: false });
    } else {
      showCategories({ focus: false });
    }
    return true;
  }

  window.MapFilters = { init, openCategory, showCategories, refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
