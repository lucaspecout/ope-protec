/* Public feeds use the shared snapshot. Only commune history is read on demand. */
(function () {
  'use strict';
  const SOURCES = {
    fuel_isere: ['Stations-service · Isère', 'https://www.prix-carburants.gouv.fr/rubrique/opendata/'],
    onde_isere: ['Petits cours d’eau · ONDE', 'https://www.data.gouv.fr/dataservices/hubeau-ecoulement-des-cours-deau'],
    catnat_isere: ['Historique CatNat', 'https://www.georisques.gouv.fr/doc-api'],
    energy_aura: ['Électricité · Auvergne-Rhône-Alpes', 'https://www.rte-france.com/donnees-publications/eco2mix-donnees-temps-reel/donnees-regionales'],
    recalls: ['Rappels de produits · RappelConso', 'https://rappel.conso.gouv.fr/'],
  };
  const state = { slots: {}, signatures: {}, limits: { fuel: 60, onde: 60, recalls: 40 }, map: null, layers: {}, layerSignatures: {}, session: 0, historyVersion: 0, focusPoint: null };
  const el = id => document.getElementById(id);
  const put = (id, html) => { if (el(id)) el(id).innerHTML = html; };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normal = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const fmt = (value, unit = '') => finite(value) ? `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: unit === '€/L' ? 3 : 1 })}${unit ? ` ${unit}` : ''}` : 'Non renseigné';
  const when = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Date non renseignée';
    return new Date(value).toLocaleString('fr-FR', value.length === 10 ? { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' } : { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const note = text => `<p class="public-note">${esc(text)}</p>`;
  const link = (url, text) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' ? `<a href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : ''; } catch (_) { return ''; } };
  const status = slot => ({ online: 'Disponible', partial: 'Collecte partielle', stale: 'Dernières données connues', pending: 'Collecte en cours', unavailable: 'Indisponible', error: 'Indisponible' }[slot?.status] || 'En attente');
  const panel = () => typeof localStorage !== 'undefined' ? localStorage.getItem('activePanel') : null;
  const hasData = slot => ['online', 'partial', 'stale'].includes(slot?.status);
  const summary = (key, text) => {
    const slot = state.slots[key] || {};
    return `<p><strong>${esc(status(slot))}</strong>${hasData(slot) ? ` · ${esc(text)}` : ''}</p>${slot.updated_at ? note(`Collecte réussie : ${when(slot.updated_at)}`) : note('Collecte en arrière-plan ; aucune donnée datée disponible pour le moment.')}${note(slot.note || '')}${slot.error ? `<p class="public-shortage">${esc(slot.error)}</p>` : ''}${slot.cache_warning ? note(slot.cache_warning) : ''}`;
  };
  function cards() {
    put('public-source-cards', Object.entries(SOURCES).map(([key, [title, source]]) => {
      const slot = state.slots[key] || {};
      const count = key === 'fuel_isere' || key === 'onde_isere' ? slot.stations_total : key === 'catnat_isere' ? slot.events_total : key === 'recalls' ? slot.items_total : null;
      const info = key === 'energy_aura' && slot.latest ? `${fmt(slot.latest.consumption_mw, 'MW')} consommés · ${when(slot.observed_at)}` : finite(count) ? `${fmt(count)} ${key === 'catnat_isere' ? 'reconnaissances commune/arrêté' : key === 'recalls' ? 'publications récentes' : 'stations'}` : 'Collecte serveur en arrière-plan.';
      const statusNode = el(`${key}-public-status`), infoNode = el(`${key}-public-info`);
      if (statusNode) statusNode.textContent = status(slot);
      if (infoNode) infoNode.textContent = info;
      return `<article class="public-source-card"><h4>${esc(title)}</h4><span class="official-badge ${hasData(slot) ? 'available' : ''}">${esc(status(slot))}</span><p>${esc(info)}</p><div class="official-actions"><button type="button" class="ghost" data-public-focus="${key}">Consulter</button><button type="button" class="ghost" data-public-refresh="${key}">Actualiser</button>${link(source, 'Source')}</div></article>`;
    }).join(''));
  }
  function fuelRows() {
    const query = normal(el('public-fuel-search')?.value ?? el('map-fuel-search')?.value), type = el('public-fuel-type')?.value || el('map-fuel-type')?.value || 'all', filter = el('public-fuel-shortage')?.value || el('map-fuel-shortage')?.value || 'all';
    return (state.slots.fuel_isere?.stations || []).flatMap(station => {
      if (!normal(`${station.commune} ${station.address} ${station.postal_code}`).includes(query)) return [];
      const fuels = (station.fuels || []).filter(fuel => (type === 'all' || fuel.fuel === type)
        && (filter === 'all' || filter === 'temporary' && fuel.shortage === 'temporary' || filter === 'priced' && !fuel.shortage && finite(fuel.price_eur)));
      return fuels.length ? [{ ...station, fuels }] : [];
    });
  }
  function fuelText(fuel) {
    const declaration = fuel.shortage === 'temporary' ? 'Rupture temporaire déclarée' : fuel.shortage === 'discontinued' ? 'Distribution arrêtée' : 'Aucune rupture déclarée';
    return `<strong>${esc(fuel.fuel)}</strong> : ${esc(fmt(fuel.price_eur, '€/L'))}<small class="${fuel.shortage ? 'public-shortage' : fuel.old_price ? 'public-old' : ''}">${esc(declaration)}${fuel.shortage_since ? ` depuis le ${esc(when(fuel.shortage_since))}` : ''} · prix du ${esc(when(fuel.updated_at))}${fuel.old_price ? ' · prix ancien ou non daté' : ''}</small>`;
  }
  function more(kind, shown, total) { return shown < total ? `<button type="button" class="ghost" data-public-more="${kind}">Afficher davantage (${shown}/${total})</button>` : ''; }
  function renderFuel() {
    const slot = state.slots.fuel_isere || {}, rows = fuelRows(), shown = rows.slice(0, state.limits.fuel);
    put('public-fuel-summary', summary('fuel_isere', `${fmt(slot.stations_total)} stations · ${fmt(slot.temporary_shortage_stations)} avec rupture temporaire déclarée`));
    put('public-fuel-results', rows.length ? `<table><caption>${rows.length} station(s) selon les filtres</caption><thead><tr><th>Station</th><th>Carburants déclarés</th><th>Horaires et services</th><th>Carte</th></tr></thead><tbody>${shown.map(station => `<tr><th scope="row">${esc(station.commune)}<small>${esc(station.address)} · ${esc(station.postal_code)}</small></th><td>${station.fuels.map(fuelText).join('<br>')}</td><td>${station.automate_24h === true ? 'Automate 24 h/24' : station.automate_24h === false ? 'Automate non déclaré 24 h/24' : 'Horaires automate non renseignés'}<details><summary>Détail</summary>${(station.hours || []).map(day => `<small>${esc(day.day)} : ${day.closed ? 'Fermé' : day.slots.length ? day.slots.map(time => `${esc(time.from)}–${esc(time.to)}`).join(', ') : 'Non renseigné'}</small>`).join('')}${note((station.services || []).join(' · '))}</details></td><td>${finite(station.lat) && finite(station.lon) ? `<button type="button" class="ghost" data-public-location="fuel:${esc(station.id)}">Localiser</button>` : 'Position non renseignée'}</td></tr>`).join('')}</tbody></table>${more('fuel', shown.length, rows.length)}` : note(hasData(slot) ? 'Aucune station correspondant aux filtres.' : 'Stations en attente de collecte.'));
  }
  function ondeRows() {
    const query = normal(el('public-onde-search')?.value ?? el('map-onde-search')?.value), flow = el('public-onde-flow')?.value || el('map-onde-flow')?.value || 'all';
    return (state.slots.onde_isere?.stations || []).filter(station => normal(`${station.commune} ${station.river} ${station.name}`).includes(query)
      && (flow === 'all' || flow === 'visible' && String(station.flow_code).startsWith('1') || station.flow_code === flow));
  }
  function renderOnde() {
    const slot = state.slots.onde_isere || {}, rows = ondeRows(), shown = rows.slice(0, state.limits.onde);
    put('public-onde-summary', summary('onde_isere', `${fmt(slot.stations_total)} stations observées · ${fmt(slot.dry_stations)} assecs · dernière campagne disponible : ${when(slot.observed_at)}`));
    put('public-onde-results', rows.length ? `<table><caption>Dernier relevé de chaque station · ${rows.length} résultat(s)</caption><thead><tr><th>Cours d’eau / station</th><th>Commune</th><th>Observation</th><th>Date du relevé</th><th>Carte</th></tr></thead><tbody>${shown.map(station => `<tr><th scope="row">${esc(station.river)}<small>${esc(station.name)}</small></th><td>${esc(station.commune)}</td><td class="${station.flow_code === '3' ? 'public-shortage' : ''}">${esc(station.flow_label)}</td><td>${esc(when(station.observed_at))}</td><td>${finite(station.lat) && finite(station.lon) ? `<button type="button" class="ghost" data-public-location="onde:${esc(station.id)}">Localiser</button>` : 'Position non renseignée'}</td></tr>`).join('')}</tbody></table>${more('onde', shown.length, rows.length)}` : note(hasData(slot) ? 'Aucun relevé correspondant aux filtres.' : 'Relevés en attente de collecte.'));
  }
  function catnatTable(events, limit = 150) {
    return events.length ? `<table><caption>${events.length} reconnaissance(s) commune/arrêté${events.length > limit ? ` · ${limit} affichées` : ''}</caption><thead><tr><th>Commune</th><th>Nature</th><th>Événement</th><th>Publication au JO</th></tr></thead><tbody>${events.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.commune)}<small>${esc(row.code_insee)}</small></th><td>${esc(row.risk)}<small>${esc(row.id)}</small></td><td>${esc(when(row.event_start))} – ${esc(when(row.event_end))}</td><td>${esc(when(row.published_at))}</td></tr>`).join('')}</tbody></table>` : note('Aucun arrêté dans les données disponibles pour cette sélection.');
  }
  function renderCatnat() {
    const slot = state.slots.catnat_isere || {}, select = el('public-catnat-commune');
    if (select) {
      const selected = select.value;
      select.innerHTML = '<option value="">Dernières publications départementales</option>' + (slot.communes || []).map(row => `<option value="${esc(row.code)}">${esc(row.name)} · ${row.checked ? esc(fmt(row.events_total)) : 'collecte incomplète'}</option>`).join('');
      if ((slot.communes || []).some(row => row.code === selected)) select.value = selected;
    }
    const coverage = slot.coverage || {};
    put('public-catnat-summary', summary('catnat_isere', `${fmt(slot.events_total)} reconnaissances commune/arrêté · ${fmt(coverage.communes_checked)}/${fmt(coverage.communes_total)} communes vérifiées`));
    if (select?.value) { loadHistory(); return; }
    ++state.historyVersion;
    put('public-catnat-results', hasData(slot) ? note(`Aperçu des ${slot.preview_limit || 150} dernières reconnaissances au maximum. Choisir une commune pour lire son historique complet collecté. Un même arrêté peut concerner plusieurs communes.`) + catnatTable(slot.events || []) : note('Historique en attente de collecte.'));
  }
  async function loadHistory() {
    const code = el('public-catnat-commune')?.value;
    if (!code) { renderCatnat(); return; }
    const version = ++state.historyVersion, session = state.session;
    put('public-catnat-results', note('Lecture de l’historique local de la commune…'));
    try {
      const result = await api(`/api/catnat/isere/history?code_insee=${encodeURIComponent(code)}`, { maxRetries: 0, timeoutMs: 8000 });
      if (version !== state.historyVersion || session !== state.session || panel() !== 'official-sources-panel' || el('public-catnat-commune')?.value !== code) return;
      put('public-catnat-results', (result.coverage_warning ? note(result.coverage_warning) : '') + (result.status === 'pending' ? note(result.note) : catnatTable(result.events || [], 1000)));
    } catch (_) {
      if (version === state.historyVersion && session === state.session) put('public-catnat-results', note('Historique momentanément indisponible. Réessayer en sélectionnant la commune.'));
    }
  }
  function renderEnergy() {
    const slot = state.slots.energy_aura || {}, latest = slot.latest || {};
    put('public-energy-summary', summary('energy_aura', `Consommation : ${fmt(latest.consumption_mw, 'MW')} · mesure du ${when(slot.observed_at)}`) + note(slot.info_state || ''));
    const chart = window.OfficialSources?.chart;
    put('public-energy-chart', chart && slot.series?.length ? chart(slot.series.map(row => ({ at: row.at, central: row.consumption_mw })), 'MW', 'Consommation électrique régionale') : note('Courbe disponible après la première collecte.'));
    const generation = latest.generation_mw || {};
    put('public-energy-generation', Object.entries(slot.generation_labels || {}).map(([key, title]) => `<div><strong>${esc(title)}</strong><small>${esc(fmt(generation[key], 'MW'))}</small></div>`).join(''));
  }
  function renderRecalls() {
    const slot = state.slots.recalls || {}, query = normal(el('public-recalls-search')?.value), scope = el('public-recalls-scope')?.value || 'relevant', active = el('public-recalls-active')?.value || 'active';
    const rows = (slot.items || []).filter(row => normal(`${row.name} ${row.brand} ${row.distributors} ${row.identification}`).includes(query)
      && (scope === 'all' || scope === 'relevant' && row.scope !== 'unspecified' || row.scope === scope)
      && (active === 'all' || row.active !== false));
    const shown = rows.slice(0, state.limits.recalls);
    put('public-recalls-summary', summary('recalls', `${fmt(slot.items_total)} publications récentes · ${fmt(slot.targeted_total)} de portée nationale, régionale ou Isère · ${fmt(slot.unspecified_total)} autres zones / portées à vérifier`)
      + (slot.truncated ? note('Collecte plafonnée ; certaines publications peuvent manquer.') : ''));
    put('public-recalls-results', rows.length ? `<p>${rows.length} rappel(s) selon les filtres</p>${shown.map(row => `<details class="public-recall" data-public-recall-id="${esc(row.id)}"><summary>${esc(row.name || row.brand)} · ${esc(when(row.published_at))}</summary><p>${esc(row.brand)} · ${esc(row.category)} · ${row.active === false ? 'Procédure terminée selon la date publiée' : row.active === null ? 'Échéance non renseignée' : `Procédure jusqu’au ${esc(when(row.expires_at))}`}</p><div id="public-recall-detail-${esc(row.id)}">${note('Ouvrir la fiche pour lire les références, lots et consignes publiées.')}</div>${link(row.source_url, 'Fiche officielle et consignes à jour')}</details>`).join('')}${more('recalls', shown.length, rows.length)}` : note(hasData(slot) ? 'Aucun rappel correspondant aux filtres. Les autres zones et portées à vérifier sont disponibles dans le filtre « Zone déclarée ».' : 'Rappels en attente de collecte.'));
  }
  async function recallDetail(details) {
    const id = details.dataset.publicRecallId, container = el(`public-recall-detail-${id}`), session = state.session;
    if (!details.open || !container || container.dataset.loading || container.dataset.loaded) return;
    container.dataset.loading = '1';
    container.innerHTML = note('Lecture de la fiche collectée…');
    try {
      const result = await api(`/api/recalls/${encodeURIComponent(id)}`, { maxRetries: 0, timeoutMs: 8000 });
      if (session !== state.session || el(`public-recall-detail-${id}`) !== container) return;
      const row = result.item || {};
      container.innerHTML = `<dl>${[['Zone déclarée', row.sale_area], ['Références / modèles', row.models], ['Identification / lots', row.identification], ['Distributeurs', row.distributors], ['Motif publié', row.reason], ['Risque publié', row.risk], ['Consignes publiées', row.actions]].map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value || 'Non renseigné')}</dd>`).join('')}</dl>${note(`Fiche collectée le ${when(result.checked_at)}${result.status === 'stale' ? ' · cache ancien, vérifier la fiche officielle' : ''}`)}`;
      container.dataset.loaded = '1';
    } catch (_) {
      if (session === state.session && el(`public-recall-detail-${id}`) === container) container.innerHTML = note('Fiche locale indisponible. Consulter le lien officiel ou refermer puis rouvrir pour réessayer.');
    } finally { delete container.dataset.loading; }
  }
  const renderers = { fuel_isere: renderFuel, onde_isere: renderOnde, catnat_isere: renderCatnat, energy_aura: renderEnergy, recalls: renderRecalls };
  function update(snapshot = {}) {
    let changed = false;
    Object.keys(SOURCES).forEach(key => {
      if (!snapshot[key] || typeof snapshot[key] !== 'object') return;
      const signature = JSON.stringify(snapshot[key]);
      if (signature === state.signatures[key]) return;
      state.slots[key] = snapshot[key]; state.signatures[key] = signature; changed = true;
      // Hidden panels keep their controls; they render on the next activation.
      if (panel() === 'official-sources-panel') renderers[key]();
    });
    if (changed) { cards(); syncMap(); }
  }
  function removeLayer(key) {
    if (state.layers[key] && state.map) state.map.removeLayer(state.layers[key]);
    delete state.layers[key];
  }
  function syncMap() {
    if (typeof leafletMap === 'undefined' || !leafletMap || !window.L || panel() !== 'map-panel') return;
    if (state.map !== leafletMap) { Object.keys(state.layers).forEach(removeLayer); state.map = leafletMap; state.layerSignatures = {}; }
    [['fuel', 'fuel_isere', fuelRows], ['onde', 'onde_isere', ondeRows]].forEach(([kind, key, getRows]) => {
      const enabled = Boolean(el(`filter-public-${kind}`)?.checked), rows = getRows();
      const controls = kind === 'fuel' ? ['public-fuel-search', 'public-fuel-type', 'public-fuel-shortage', 'map-fuel-search', 'map-fuel-type', 'map-fuel-shortage'] : ['public-onde-search', 'public-onde-flow', 'map-onde-search', 'map-onde-flow'];
      const signature = `${enabled}:${state.signatures[key] || ''}:${controls.map(id => el(id)?.value || '').join('|')}:${rows.map(row => row.id).join(',')}`;
      const positioned = rows.filter(row => finite(row.lat) && finite(row.lon) && Math.abs(Number(row.lat)) <= 90 && Math.abs(Number(row.lon)) <= 180);
      const counter = el(`map-${kind}-results`);
      if (counter) counter.textContent = `${positioned.length} point(s) affichable(s) · ${rows.length}/${state.slots[key]?.stations?.length || 0} résultat(s)`;
      if (state.layerSignatures[kind] === signature) return;
      removeLayer(kind); state.layerSignatures[kind] = signature;
      if (!enabled) return;
      const layer = window.L.layerGroup();
      positioned.forEach(row => {
        const popup = kind === 'fuel' ? `<strong>Station-service · ${esc(row.commune)}</strong><p>${esc(row.address)}</p>${row.fuels.map(fuelText).join('<br>')}${note('Déclarations fournisseur ; stock non garanti.')}`
          : `<strong>${esc(row.name)}</strong><p>${esc(row.commune)} · ${esc(row.flow_label)}</p><p>Relevé du ${esc(when(row.observed_at))}</p>${note('Observation de campagne, pas une mesure en direct.')}`;
        const color = kind === 'fuel' ? (row.fuels.some(fuel => fuel.shortage === 'temporary') ? '#b04b26' : '#2459a1') : row.flow_code === '3' ? '#b03a43' : row.flow_code === '2' ? '#b07813' : '#148a8a';
        window.L.circleMarker([row.lat, row.lon], { radius: 6, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: .9 }).bindPopup(popup).addTo(layer);
      });
      layer.addTo(state.map); state.layers[kind] = layer;
    });
  }
  function activate(id) {
    if (id !== 'official-sources-panel') ++state.historyVersion;
    if (id !== 'map-panel') state.focusPoint = null;
    if (id === 'official-sources-panel') { cards(); Object.values(renderers).forEach(render => render()); }
    if (id === 'map-panel') syncMap();
  }
  function applyMapFocus() {
    if (!state.focusPoint || panel() !== 'map-panel' || typeof leafletMap === 'undefined' || !leafletMap) return false;
    leafletMap.setView(state.focusPoint, 14);
    state.focusPoint = null;
    return true;
  }
  function reset() {
    ++state.session; ++state.historyVersion; Object.keys(state.layers).forEach(removeLayer);
    state.map = null; state.slots = {}; state.signatures = {}; state.layerSignatures = {}; state.focusPoint = null;
    state.limits = { fuel: 60, onde: 60, recalls: 40 };
    ['public-fuel-search', 'public-onde-search', 'map-fuel-search', 'map-onde-search', 'public-recalls-search'].forEach(id => { if (el(id)) el(id).value = ''; });
    ['public-fuel-type', 'public-fuel-shortage', 'public-onde-flow', 'map-fuel-type', 'map-fuel-shortage', 'map-onde-flow'].forEach(id => { if (el(id)) el(id).value = 'all'; });
    ['map-fuel-results', 'map-onde-results'].forEach(id => { if (el(id)) el(id).textContent = ''; });
    ['public-fuel-summary', 'public-onde-summary', 'public-catnat-summary', 'public-energy-summary', 'public-recalls-summary', 'public-fuel-results', 'public-onde-results', 'public-catnat-results', 'public-recalls-results', 'public-energy-chart', 'public-energy-generation', 'public-source-cards'].forEach(id => put(id, ''));
    put('public-catnat-commune', '<option value="">Dernières publications départementales</option>');
  }
  function bind() {
    [['fuel', ['search', 'type', 'shortage'], renderFuel], ['onde', ['search', 'flow'], renderOnde]].forEach(([kind, filters, render]) => filters.forEach(filter => {
      const ids = [`public-${kind}-${filter}`, `map-${kind}-${filter}`];
      if (el(ids[1]) && el(ids[0])) el(ids[0]).value = el(ids[1]).value;
      ids.forEach(id => {
        const change = () => {
          const other = el(ids.find(otherId => otherId !== id));
          if (other) other.value = el(id).value;
          state.limits[kind] = 60; render(); syncMap();
        };
        ['input', 'change'].forEach(event => el(id)?.addEventListener(event, change));
      });
    }));
    ['public-recalls-search', 'public-recalls-scope', 'public-recalls-active'].forEach(id => el(id)?.addEventListener('input', () => { state.limits.recalls = 40; renderRecalls(); }));
    el('public-catnat-commune')?.addEventListener('change', loadHistory);
    ['fuel', 'onde'].forEach(kind => el(`filter-public-${kind}`)?.addEventListener('change', syncMap));
    document.addEventListener('click', async event => {
      const focus = event.target.closest('[data-public-focus]');
      if (focus) {
        window.SourceExplorer?.open(focus.dataset.publicFocus);
        if (typeof setActivePanel === 'function') setActivePanel('official-sources-panel', { refreshSnapshot: false });
        const target = el(`public-${focus.dataset.publicFocus}`);
        if (target) { target.open = true; target.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }
      }
      const moreButton = event.target.closest('[data-public-more]');
      if (moreButton) { const kind = moreButton.dataset.publicMore; if (kind in state.limits) { state.limits[kind] += 60; ({ fuel: renderFuel, onde: renderOnde, recalls: renderRecalls })[kind](); } }
      const locate = event.target.closest('[data-public-location]'), mapButton = event.target.closest('[data-public-map]');
      if (mapButton || locate) {
        const location = locate?.dataset.publicLocation || '', colon = location.indexOf(':'), kind = mapButton?.dataset.publicMap || location.slice(0, colon);
        if (!['fuel', 'onde'].includes(kind)) return;
        if (el(`filter-public-${kind}`)) el(`filter-public-${kind}`).checked = true;
        window.MapFilters?.refresh();
        if (locate) {
          const row = (state.slots[kind === 'fuel' ? 'fuel_isere' : 'onde_isere']?.stations || []).find(row => row.id === location.slice(colon + 1));
          if (row && finite(row.lat) && finite(row.lon)) state.focusPoint = [row.lat, row.lon];
        }
        if (typeof setActivePanel === 'function') setActivePanel('map-panel', { refreshSnapshot: false });
        syncMap();
      }
      const refresh = event.target.closest('[data-public-refresh]');
      if (!refresh || refresh.disabled || !SOURCES[refresh.dataset.publicRefresh]) return;
      refresh.disabled = true;
      try { await api(`/external/isere/risks/${encodeURIComponent(refresh.dataset.publicRefresh)}/refresh`, { method: 'POST', maxRetries: 0 }); refresh.textContent = 'Collecte demandée'; }
      catch (_) { refresh.textContent = 'Réessayer'; }
      finally { refresh.disabled = false; }
    });
    document.addEventListener('toggle', event => { if (event.target.matches?.('[data-public-recall-id]')) recallDetail(event.target); }, true);
  }
  window.PublicSources = { update, activate, reset, syncMap, applyMapFocus };
  document.addEventListener('DOMContentLoaded', bind, { once: true });
})();
