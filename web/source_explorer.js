/* Source navigation keeps the existing data views and their filters mounted. */
(function () {
  'use strict';
  const THEMES = { weather: 'Météo & eau', territory: 'Territoire & risques', energy: 'Énergie', daily: 'Vie quotidienne', transport: 'Transport & circulation', telecom: 'Télécommunications', environment: 'Environnement', news: 'Actualités & veille', health: 'Santé & ressources' };
  const CATEGORY_THEMES = { 'Météo': 'weather', 'Eau': 'weather', 'Référentiels': 'territory', 'Risques': 'territory', 'Données': 'territory', 'Électricité': 'energy', 'Énergie': 'energy', 'Logistique': 'daily', 'Veille': 'daily', 'Transport': 'transport', 'Télécom': 'telecom', 'Actualités': 'news', 'Santé': 'health', 'Environnement': 'environment' };
  const DESCRIPTIONS = {
    meteo_france: 'Vigilance départementale, phénomènes suivis et bulletins Météo-France.',
    meteo_forets_isere: 'Danger météorologique de feux de forêt prévu pour l’Isère.',
    apic_isere: 'Avertissements de pluie intense à l’échelle des communes.',
    vigicrues: 'Mesures des stations et vigilance des tronçons des cours d’eau.',
    vigicrues_flash_isere: 'Avertissements de crues rapides pour les cours d’eau surveillés.',
    vigieau: 'Zones de restriction d’eau, publics concernés et arrêtés applicables.',
    groundwater_isere: 'Niveaux, profondeur et tendances des nappes phréatiques de l’Isère.',
    rnb_isere: 'Référentiel national des bâtiments et couverture disponible en Isère.',
    atmo_aura: 'Indice de qualité de l’air et informations sur les épisodes de pollution.',
    georisques: 'Synthèse des risques naturels et technologiques du territoire.',
    itinisere: 'Perturbations, incidents et événements sur les routes de l’Isère.',
    autoroutes_isere: 'Événements des grands axes, réunis depuis Bison Futé, APRR et Vinci.',
    sncf_isere: 'Alertes ferroviaires, incidents et travaux concernant l’Isère.',
    ter_aura: 'Perturbations et informations de circulation des TER de la région.',
    mreseau: 'Alertes tramway, bus et cars du réseau de l’agglomération grenobloise.',
    cars_region_aura: 'Informations de circulation et perturbations des cars régionaux.',
    prefecture_isere: 'Dernières publications de la préfecture de l’Isère.',
    dauphine_isere: 'Articles et informations locales du Dauphiné Libéré.',
    france_bleu_isere: 'Informations locales de la rédaction France Bleu / ici Isère.',
    placegrenet: 'Derniers articles de la rédaction Place Gre’net.',
    grenoble_metro: 'Actualités et publications de Grenoble Alpes Métropole.',
    ars_aura: 'Alertes sanitaires et publications de l’Agence régionale de santé.',
    seismes_isere: 'Séismes récents détectés, localisation et magnitude.',
    avalanche_isere: 'Bulletins de risque d’avalanche et niveaux par massif.',
    feux_foret_isere: 'Derniers signalements d’incendies publiés par FeuxDeForet.fr.',
    copernicus_ems: 'Événements de catastrophe suivis par GDACS en France et en Europe.',
    cols_alpins_isere: 'État et conditions de circulation des cols alpins surveillés.',
    anfr_isere: 'Supports, stations et caractéristiques des réseaux mobiles recensés.',
    arcep_isere: 'Sites mobiles déclarés indisponibles et communes concernées.',
    isere_opendata: 'Écoles, maisons de santé et points d’aide alimentaire du département.',
    finess_isere: 'Établissements de santé et ressources du référentiel FINESS.',
    geodae_isere: 'Défibrillateurs recensés, localisation et accessibilité déclarée.',
  };
  const DEFAULT_URLS = {
    meteo_observations: 'https://meteofrance.com/', meteo_radar: 'https://meteofrance.com/meteo-radar', vigicrues_forecasts: 'https://www.vigicrues.gouv.fr/',
    onde_isere: 'https://onde.eaufrance.fr/', insee_population: 'https://www.insee.fr/fr/statistiques/8735162', industrial_sites: 'https://www.georisques.gouv.fr/', catnat_isere: 'https://www.georisques.gouv.fr/',
    energy_aura: 'https://www.rte-france.com/donnees-publications/eco2mix-donnees-temps-reel/donnees-regionales', enedis: 'https://www.enedis.fr/panne-et-interruption', fuel_isere: 'https://www.prix-carburants.gouv.fr/', recalls: 'https://rappel.conso.gouv.fr/',
  };
  const SOURCES = [
    { key: 'meteo_observations', title: 'Observations météo', publisher: 'Météo-France', theme: 'weather', description: 'Température, pluie et rafales mesurées dans les stations de l’Isère.', icon: 'M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9-1 4 4 0 1 1 1 9H7M8 19v2m4-2v2m4-2v2' },
    { key: 'meteo_radar', title: 'Radar de pluie', publisher: 'Météo-France', theme: 'weather', description: 'Images de précipitations collectées et animation sur la carte.', icon: 'M12 3v9l6-6M3 12a9 9 0 1 0 9-9M7 12a5 5 0 1 0 5-5' },
    { key: 'vigicrues_forecasts', title: 'Prévisions des cours d’eau', publisher: 'Vigicrues', theme: 'weather', description: 'Courbes de hauteur et de débit prévues aux stations suivies.', icon: 'M3 17c3-4 5 4 9 0s6 3 9 0M3 21c3-4 5 4 9 0s6 3 9 0M5 11l5-5 4 3 5-6m-4 0h4v4' },
    { key: 'onde_isere', title: 'Écoulement des ruisseaux', publisher: 'OFB · ONDE', theme: 'weather', description: 'Derniers relevés de campagne : écoulement visible, non visible ou assec.', icon: 'M12 3c-2 4-6 7-6 11a6 6 0 0 0 12 0c0-4-4-7-6-11M9 15a3 3 0 0 0 3 3' },
    { key: 'insee_population', title: 'Population & territoire', publisher: 'INSEE · Filosofi', theme: 'territory', description: 'Population résidente et classes d’âge pour préparer une analyse de zone.', icon: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a6 6 0 0 1 12 0v3m3-17a4 4 0 0 1 0 8m1 3a5 5 0 0 1 4 5' },
    { key: 'industrial_sites', title: 'Sites industriels', publisher: 'Géorisques · ICPE / Seveso', theme: 'territory', description: 'Établissements industriels, localisation et classement réglementaire.', icon: 'M3 21V10l6 3V8l6 4V3h5v18H3m4-4h1m4 0h1m4 0h1' },
    { key: 'catnat_isere', title: 'Catastrophes naturelles', publisher: 'Géorisques · CatNat', theme: 'territory', description: 'Reconnaissances publiées au Journal officiel et historique par commune.', icon: 'M6 3h9l4 4v14H6V3m9 0v5h4M9 12h7m-7 4h7M3 6v15' },
    { key: 'energy_aura', title: 'Électricité régionale', publisher: 'RTE · éCO2mix', theme: 'energy', description: 'Consommation et production d’électricité en Auvergne-Rhône-Alpes.', icon: 'M13 2 4 14h7l-1 8 10-13h-7l0-7' },
    { key: 'enedis', title: 'Diagnostic électrique', publisher: 'Enedis', theme: 'energy', description: 'Accès au diagnostic officiel d’une coupure à une adresse.', icon: 'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8m6 10v4' },
    { key: 'fuel_isere', title: 'Stations & carburants', publisher: 'Prix des carburants', theme: 'daily', description: 'Prix déclarés, ruptures temporaires et localisation des stations-service.', icon: 'M4 21V4h10v17M6 7h6v5H6V7m-4 14h14m-2-14 4 4v7a2 2 0 0 0 4 0v-7l-4-5' },
    { key: 'recalls', title: 'Rappels de produits', publisher: 'RappelConso', theme: 'daily', description: 'Produits rappelés, lots concernés et consignes officielles aux consommateurs.', icon: 'M3 7l9-4 9 4v12l-9 4-9-4V7m0 0 9 4 9-4M12 11v12M8 5l9 4' },
  ];
  const nativeKeys = new Set(SOURCES.map(source => source.key).concat('groundwater_isere'));
  SOURCES.forEach(source => { source.url = DEFAULT_URLS[source.key]; });
  let payloadForService = (key, snapshot) => snapshot[key];
  const state = { snapshot: {}, selected: null, mode: 'cards', search: '', theme: 'all', signature: '', session: 0, refreshing: new Set() };
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normal = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const fmt = value => finite(value) ? Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—';
  const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Date non disponible';
  const status = slot => {
    if (slot.status === 'online') return { label: 'À jour', tone: 'ready' };
    if (slot.status === 'no_forecast') return { label: 'Pas de prévision publiée', tone: 'neutral' };
    if (['partial', 'stale', 'degraded'].includes(slot.status)) return { label: slot.status === 'stale' ? 'Données anciennes' : 'Couverture partielle', tone: 'warning' };
    if (['configuration_required', 'config_required', 'access_required'].includes(slot.status)) return { label: 'Accès à configurer', tone: 'setup' };
    if (['unavailable', 'error', 'offline', 'failed'].includes(slot.status)) return { label: 'Indisponible', tone: 'error' };
    return { label: 'Collecte en cours', tone: 'neutral' };
  };
  function metric(key, slot) {
    if (key === 'enedis') return { value: 'À l’adresse', label: 'diagnostic sur le site Enedis' };
    if (!['online', 'partial', 'stale', 'degraded', 'no_forecast'].includes(slot.status)) return { value: '—', label: 'en attente de données' };
    const items = (value, label) => ({ value: fmt(value), label });
    const service = SOURCES.find(source => source.key === key);
    if (service?.connected && service.liveMetric) {
      try { return { value: service.liveMetric(slot), label: 'Dernier état collecté' }; }
      catch (_) { return { value: '—', label: 'Données à consulter' }; }
    }
    switch (key) {
      case 'meteo_observations': return items(slot.stations?.length, 'stations météorologiques');
      case 'meteo_radar': return items(slot.frames?.length, 'images radar collectées');
      case 'vigicrues_forecasts': return items(slot.coverage?.with_forecasts ?? slot.stations?.filter(row => row.series?.length).length, 'stations avec prévisions');
      case 'onde_isere': return items(slot.stations_total, 'stations observées');
      case 'insee_population': return items(slot.cells_total, `carreaux · référence ${slot.data_year || 'non précisée'}`);
      case 'industrial_sites': return items(slot.sites_total, 'établissements recensés');
      case 'catnat_isere': return items(slot.events_total, 'reconnaissances commune / arrêté');
      case 'energy_aura': return items(slot.latest?.consumption_mw, 'MW consommés dans la région');
      case 'fuel_isere': return items(slot.stations_total, 'stations-service recensées');
      case 'recalls': return items(slot.items_total, 'publications · 90 derniers jours');
      default: return items(null, 'données à consulter');
    }
  }
  function renderMenus() {
    if (el('source-select')) el('source-select').innerHTML = SOURCES.map(source => `<option value="${esc(source.key)}">${esc(source.title)}</option>`).join('');
    if (el('source-theme')) { el('source-theme').innerHTML = '<option value="all">Tous les thèmes</option>' + Object.entries(THEMES).map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join(''); el('source-theme').value = state.theme; }
  }
  function registerServices(services = [], metadata = {}, getPayload) {
    if (typeof getPayload === 'function') payloadForService = getPayload;
    for (const service of services) {
      if (!/^[a-z0-9_]+$/.test(service.key)) continue;
      const existing = SOURCES.find(source => source.key === service.key);
      const url = DEFAULT_URLS[service.key] || metadata[service.key]?.url;
      if (existing) { if (url) existing.url = url; continue; }
      const theme = CATEGORY_THEMES[service.category] || 'daily';
      const icon = SOURCES.find(source => source.theme === theme)?.icon || 'M4 5h16v14H4V5m4 4h8m-8 4h8m-8 4h4';
      SOURCES.push({ key: service.key, title: service.label, publisher: service.label.split('·')[0].trim(), theme, icon,
        description: DESCRIPTIONS[service.key] || `Données et informations publiées par ${service.label}.`,
        url, connected: true, liveMetric: service.metric });
    }
    renderMenus(); state.signature = ''; render();
  }
  function renderServiceData(source, slot) {
    const target = el(`source-service-extra-${source.key}`);
    if (!target) return;
    const available = ['online', 'partial', 'stale', 'degraded', 'no_forecast'].includes(slot.status);
    const summary = available ? metric(source.key, slot).value : status(slot).label;
    const data = slot.data && typeof slot.data === 'object' ? { ...slot.data, ...slot } : slot;
    const rows = [data.forecasts, data.resources, data.points, data.buildings, data.items].find(Array.isArray) || [];
    const table = available && rows.length ? `<div class="official-table-wrap"><table><caption>${rows.length} élément(s) collecté(s)${rows.length > 200 ? ' · aperçu des 200 premiers' : ''}</caption><thead><tr><th>Élément</th><th>Localisation / date</th><th>Informations</th></tr></thead><tbody>${rows.slice(0, 200).map(row => `<tr><th scope="row">${esc(row.name || row.nom || row.title || row.nom_etablissement || row.danger || 'Élément recensé')}</th><td>${esc(row.commune || row.municipality || row.ville || row.date || row.day || row.address || 'Non renseignée')}</td><td>${esc(row.description || row.type || row.category || row.level || row.danger || row.adresse || 'Consulter la source pour le détail.')}</td></tr>`).join('')}</tbody></table></div>` : '';
    target.innerHTML = `<div class="source-service-metric"><strong>${esc(summary)}</strong></div>${slot.info_state || slot.note || slot.coverage_note ? `<p class="muted">${esc(slot.info_state || slot.note || slot.coverage_note)}</p>` : ''}${slot.error ? `<p class="error">${esc(slot.error)}</p>` : ''}${table}`;
  }
  function renderDetail() {
    const source = SOURCES.find(row => row.key === state.selected);
    if (!source) return;
    const slot = state.snapshot[source.key] || {}, badge = status(slot);
    el('source-detail-title').textContent = source.title;
    el('source-detail-category').textContent = `${THEMES[source.theme]} · ${source.publisher}`;
    el('source-detail-description').textContent = source.description;
    el('source-detail-meta').innerHTML = `<span class="source-status source-status--${badge.tone}">${esc(badge.label)}</span><span>Collecte : ${esc(when(slot.updated_at || slot.checked_at))}</span>`;
    const officialLink = el('source-official-link');
    officialLink.hidden = true;
    try { const url = new URL(source.url); if (url.protocol === 'https:') { officialLink.href = url.href; officialLink.hidden = false; } } catch (_) { /* Only curated producer links are used. */ }
    el('source-select').value = source.key;
    el('source-refresh').disabled = source.key === 'enedis' || state.refreshing.has(source.key);
    el('source-refresh').textContent = state.refreshing.has(source.key) ? 'Demande en cours…' : 'Actualiser';
    if (source.key === 'meteo_radar') {
      const frames = Array.isArray(slot.frames) ? slot.frames : [];
      el('source-radar-body').innerHTML = `<div class="official-kpis"><span><strong>${esc(metric(source.key, slot).value)}</strong>images collectées</span><span><strong>${esc(frames.length ? when(frames[frames.length - 1].observed_at) : '—')}</strong>dernière image</span></div><p>${esc(slot.info_state || slot.message || 'Consultez la pluie sur la carte et faites défiler les images collectées.')}</p><p class="muted">${esc(slot.history_note || 'L’animation se construit au fil des collectes. Les zones sans mesure restent distinctes des zones sans pluie.')}</p>`;
    }
    if (source.connected) renderServiceData(source, slot);
  }
  function updateCard(card, source) {
    const slot = state.snapshot[source.key] || {}, badge = status(slot), value = metric(source.key, slot);
    const text = (selector, next) => {
      const node = card.querySelector(selector);
      if (node && node.textContent !== String(next)) node.textContent = String(next);
    };
    const statusNode = card.querySelector('.source-status');
    const statusClass = `source-status source-status--${badge.tone}`;
    if (statusNode && statusNode.className !== statusClass) statusNode.className = statusClass;
    text('.source-status', badge.label);
    text('.source-choice-metric > strong', value.value);
    text('.source-choice-metric > span', value.label);
    text('.source-choice-footer > span', slot.updated_at || slot.checked_at ? `Collecte du ${when(slot.updated_at || slot.checked_at)}` : 'Date non disponible');
  }
  function render() {
    if (!el('source-catalog-grid')) return;
    const detail = Boolean(state.selected);
    el('source-catalog').hidden = detail;
    el('source-catalog-filters').hidden = detail;
    el('source-detail-switch').hidden = !detail;
    el('source-detail-header').hidden = !detail;
    document.querySelectorAll('[data-source-view]').forEach(view => {
      const active = view.dataset.sourceView === state.selected;
      view.hidden = !active;
      if (view.tagName === 'DETAILS') view.open = active;
    });
    document.querySelectorAll('[data-source-mode]').forEach(button => button.setAttribute('aria-pressed', String(!detail && button.dataset.sourceMode === state.mode)));
    const known = SOURCES.filter(source => state.snapshot[source.key]?.status);
    el('source-total-count').textContent = String(SOURCES.length);
    el('source-available-count').textContent = known.length ? String(known.filter(source => state.snapshot[source.key].status === 'online').length) : '—';
    el('source-attention-count').textContent = known.length ? String(known.filter(source => ['warning', 'setup', 'error'].includes(status(state.snapshot[source.key]).tone)).length) : '—';
    if (detail) { renderDetail(); return; }
    const matches = SOURCES.filter(source => (state.theme === 'all' || state.theme === source.theme) && normal(`${source.title} ${source.publisher} ${source.description} ${THEMES[source.theme]}`).includes(normal(state.search.trim())));
    el('source-result-count').textContent = `${matches.length} source${matches.length > 1 ? 's' : ''} sur ${SOURCES.length}`;
    el('source-empty').hidden = matches.length > 0;
    el('source-catalog-grid').dataset.mode = state.mode;
    const signature = JSON.stringify(matches.map(source => source.key));
    const grid = el('source-catalog-grid');
    // Live snapshots must not replace focused/visible cards or restart their
    // entrance effects. Modes are CSS-only; rebuild only for a different set.
    if (signature === state.signature && grid.children?.length === matches.length) {
      matches.forEach((source, index) => updateCard(grid.children[index], source));
      return;
    }
    state.signature = signature;
    const focused = document.activeElement?.dataset?.sourceOpen;
    grid.innerHTML = matches.map(source => {
      const slot = state.snapshot[source.key] || {}, badge = status(slot), value = metric(source.key, slot);
      return `<button type="button" class="source-choice source-choice--${source.theme}${source.connected ? ' source-choice--connected' : ''}" data-source-open="${source.key}" aria-label="Consulter ${esc(source.title)}"><span class="source-choice-top"><span class="source-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${source.icon}"/></svg></span><span class="source-status source-status--${badge.tone}">${esc(badge.label)}</span></span><span class="source-choice-heading"><span class="source-choice-publisher">${esc(source.publisher)}</span><strong>${esc(source.title)}</strong></span><span class="source-choice-description">${esc(source.description)}</span><span class="source-choice-metric"><strong>${esc(value.value)}</strong><span>${esc(value.label)}</span></span><span class="source-choice-footer"><span>${esc(slot.updated_at || slot.checked_at ? `Collecte du ${when(slot.updated_at || slot.checked_at)}` : 'Date non disponible')}</span><span class="source-choice-arrow" aria-hidden="true">↗</span></span></button>`;
    }).join('');
    if (focused) document.querySelector(`[data-source-open="${focused}"]`)?.focus({ preventScroll: true });
  }
  function open(key, { focus = true } = {}) {
    if (!SOURCES.some(source => source.key === key)) return;
    state.selected = key;
    if (typeof setActivePanel === 'function' && localStorage.getItem('activePanel') !== 'official-sources-panel') setActivePanel('official-sources-panel', { refreshSnapshot: false });
    render();
    window.OfficialSources?.activate('official-sources-panel');
    window.PublicSources?.activate('official-sources-panel');
    if (focus) el('source-detail-title')?.focus({ preventScroll: true });
    if (focus) el('source-detail-header')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
  function catalog(mode = state.mode) {
    const previous = state.selected;
    state.selected = null;
    state.mode = mode === 'list' ? 'list' : 'cards';
    render();
    if (previous) document.querySelector(`[data-source-open="${previous}"]`)?.focus({ preventScroll: true });
  }
  function update(snapshot = {}) {
    let changed = false;
    SOURCES.forEach(source => {
      const derived = source.key === 'autoroutes_isere';
      if (derived && !['bison_fute', 'aprr_isere', 'vinci_autoroutes'].some(key => key in snapshot)) return;
      const payload = derived ? payloadForService(source.key, snapshot) : snapshot[source.key];
      if (payload && typeof payload === 'object' && JSON.stringify(payload) !== JSON.stringify(state.snapshot[source.key])) { state.snapshot[source.key] = payload; changed = true; }
    });
    if (changed) render();
  }
  function reset() {
    ++state.session;
    state.snapshot = {}; state.selected = null; state.signature = ''; state.search = ''; state.theme = 'all'; state.mode = 'cards'; state.refreshing.clear();
    if (el('source-search')) el('source-search').value = '';
    if (el('source-theme')) el('source-theme').value = 'all';
    render();
  }
  function bind() {
    const panel = el('official-sources-panel');
    if (!panel) return;
    renderMenus();
    panel.addEventListener('click', event => {
      const card = event.target.closest('[data-source-open]');
      if (card) open(card.dataset.sourceOpen);
      const mode = event.target.closest('[data-source-mode]');
      if (mode) catalog(mode.dataset.sourceMode);
    });
    el('source-search').addEventListener('input', event => { state.search = event.target.value; render(); });
    el('source-theme').addEventListener('change', event => { state.theme = event.target.value; render(); });
    el('source-select').addEventListener('change', event => open(event.target.value));
    el('source-back').addEventListener('click', () => catalog());
    el('source-clear-filters').addEventListener('click', () => { state.search = ''; state.theme = 'all'; el('source-search').value = ''; el('source-theme').value = 'all'; render(); el('source-search').focus(); });
    el('source-radar-map').addEventListener('click', () => { if (el('filter-official-radar')) el('filter-official-radar').checked = true; window.MapFilters?.refresh(); if (typeof setActivePanel === 'function') setActivePanel('map-panel', { refreshSnapshot: false }); });
    el('source-refresh').addEventListener('click', async () => {
      const key = state.selected, session = state.session, button = el('source-refresh');
      if (!SOURCES.some(source => source.key === key) || key === 'enedis' || button.disabled) return;
      state.refreshing.add(key);
      button.disabled = true;
      button.textContent = 'Demande en cours…';
      const keys = key === 'autoroutes_isere' ? ['bison_fute', 'aprr_isere', 'vinci_autoroutes'] : [key];
      try { await Promise.all(keys.map(serviceKey => api(`/external/isere/risks/${encodeURIComponent(serviceKey)}/refresh`, { method: 'POST', maxRetries: 0 }))); if (session === state.session && state.selected === key) button.textContent = 'Collecte demandée'; }
      catch (_) { if (session === state.session && state.selected === key) button.textContent = 'Réessayer'; }
      finally { if (session === state.session) { state.refreshing.delete(key); if (state.selected === key) button.disabled = false; } }
    });
    render();
  }
  window.SourceExplorer = { update, open, reset, registerServices, hasNativeView: key => nativeKeys.has(key), activate: panel => { if (panel === 'official-sources-panel') render(); }, isSourceVisible: key => state.selected === key && localStorage.getItem('activePanel') === 'official-sources-panel' };
  document.addEventListener('DOMContentLoaded', bind, { once: true });
})();
