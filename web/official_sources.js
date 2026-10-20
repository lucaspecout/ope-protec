/* Additional official data views. Snapshots arrive through the existing SSE flow. */
(function () {
  'use strict';
  const KEYS = ['insee_population', 'meteo_observations', 'vigicrues_forecasts', 'meteo_radar', 'industrial_sites', 'enedis'];
  const TITLES = ['Population INSEE · 200 m', 'Observations Météo-France', 'Prévisions Vigicrues', 'Radar Météo-France', 'Installations ICPE / Seveso', 'Électricité · Enedis'];
  const state = { snapshot: {}, signatures: {}, layers: {}, layerSignatures: {}, frameUrls: new Map(), radarVersion: 0, frameIndex: -1, timer: null, historyVersion: 0, radarId: null, map: null, sessionVersion: 0 };
  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const fmt = (value, unit = '') => finite(value) ? `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}` : 'Non mesuré';
  const when = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Date non disponible';
  const put = (id, html) => { if (el(id)) el(id).innerHTML = html; };
  const note = (text) => `<p class="muted">${esc(text)}</p>`;
  const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch (_) { return ''; } };
  const link = (url, label) => safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : '';

  function status(slot = {}) {
    const names = { online: 'Disponible', partial: 'Couverture partielle', stale: 'Dernières données connues', degraded: 'Service dégradé', pending: 'Collecte en cours', idle: 'En attente', unavailable: 'Indisponible', error: 'Indisponible', configuration_required: 'Accès à configurer', config_required: 'Accès à configurer', access_required: 'Accès partenaire requis', no_forecast: 'Aucune prévision publiée' };
    return names[slot.status] || 'En attente';
  }

  function card(key, title) {
    const slot = state.snapshot[key] || {};
    const available = ['online', 'partial', 'stale', 'degraded'].includes(slot.status);
    const summaries = {
      insee_population: `${fmt(slot.cells_total || 0)} carreaux · référence ${slot.data_year || 2021}`,
      meteo_observations: `${slot.stations?.length || 0} station(s) · mesures de pluie, vent et température`,
      vigicrues_forecasts: `${slot.coverage?.with_forecasts ?? slot.stations?.filter((s) => s.series?.length).length ?? 0} station(s) avec prévisions publiées`,
      meteo_radar: `${slot.frames?.length || 0} image(s) radar collectée(s)`,
      industrial_sites: `${fmt(slot.sites_total || slot.sites?.length || 0)} établissements · ${fmt(slot.seveso_haut_total || 0)} Seveso seuil haut`,
      enedis: 'Diagnostic officiel à l’adresse disponible. Aucun flux privé de coupures connecté.',
    };
    const detail = slot.info_state || slot.message || (available || key === 'enedis' ? summaries[key] : 'Collecte serveur en arrière-plan.');
    if (el(`${key}-official-status`)) el(`${key}-official-status`).textContent = status(slot);
    if (el(`${key}-official-info`)) el(`${key}-official-info`).textContent = detail;
    return `<article class="official-source-card"><h4>${esc(title)}</h4><span class="official-badge ${available ? 'available' : ''}">${esc(status(slot))}</span><p>${esc(detail)}</p><small>${esc(slot.updated_at ? when(slot.updated_at) : slot.checked_at ? `Vérifié le ${when(slot.checked_at)}` : 'Pas de mesure datée')}</small>${slot.error ? `<p class="error">${esc(slot.error)}</p>` : ''}<div class="official-actions">${link(slot.source_url || slot.source, 'Consulter la source')}${key !== 'enedis' ? `<button class="ghost" type="button" data-official-refresh="${key}">Actualiser</button>` : ''}</div></article>`;
  }

  function update(snapshot = {}) {
    let changed = false;
    KEYS.forEach((key) => {
      if (!snapshot[key] || typeof snapshot[key] !== 'object') return;
      const signature = JSON.stringify(snapshot[key]);
      if (signature !== state.signatures[key]) { state.signatures[key] = signature; state.snapshot[key] = snapshot[key]; changed = true; }
    });
    if (!changed) return;
    put('official-source-cards', KEYS.map((key, i) => card(key, TITLES[i])).join(''));
    renderObservations(); renderForecasts(); renderIndustries(); renderEnedis(); renderRadarControls();
    syncMap();
  }

  function options(select, rows, valueOf, labelOf) {
    if (!select) return;
    const previous = select.value;
    select.innerHTML = rows.map((row) => `<option value="${esc(valueOf(row))}">${esc(labelOf(row))}</option>`).join('');
    if (rows.some((row) => String(valueOf(row)) === previous)) select.value = previous;
  }

  function renderObservations() {
    const data = state.snapshot.meteo_observations || {};
    const stations = Array.isArray(data.stations) ? data.stations : [];
    options(el('official-observation-station'), stations, (s) => s.id, (s) => `${s.name} · ${s.stale ? 'ancienne mesure' : when(s.observed_at)}`);
    const summaries = data.summary || {};
    put('official-observation-summary', stations.length ? `<div class="official-kpis"><span><strong>${fmt(summaries.fresh_stations ?? stations.filter((s) => !s.stale && s.observed_at).length)}</strong> stations récentes</span><span><strong>${fmt(summaries.max_rain_6m_mm, 'mm/6 min')}</strong> pluie maximale</span><span><strong>${fmt(summaries.max_gust_kmh, 'km/h')}</strong> rafale maximale</span></div>` : note(data.info_state || status(data)));
    const rows = stations.map((s) => `<tr><th scope="row">${esc(s.name || s.id)}</th><td>${esc(when(s.observed_at))}${s.stale ? ' · ancienne' : ''}</td><td>${esc(fmt(s.temperature_c, '°C'))}</td><td>${esc(fmt(s.rain_6m_mm, 'mm'))}</td><td>${esc(fmt(s.gust_kmh, 'km/h'))}</td></tr>`).join('');
    put('official-observation-table', stations.length ? `<table><caption>Mesures des stations — pluie sur six minutes, rafale maximale</caption><thead><tr><th>Station</th><th>Observation</th><th>Température</th><th>Pluie / 6 min</th><th>Rafale</th></tr></thead><tbody>${rows}</tbody></table>` : note('Les mesures apparaîtront après activation de l’accès Météo-France. Les prévisions météo habituelles restent disponibles.'));
    put('official-weather-inline', stations.length ? `<strong>Mesures officielles : ${stations.length} station(s)</strong><p>Pluie max. ${esc(fmt(summaries.max_rain_6m_mm, 'mm/6 min'))} · Rafale max. ${esc(fmt(summaries.max_gust_kmh, 'km/h'))}</p><button type="button" class="ghost" data-open-official>Voir les observations et le radar</button>` : `<strong>Observations et radar Météo-France</strong>${note(data.info_state || status(data))}<button type="button" class="ghost" data-open-official>Consulter les sources officielles</button>`);
    // History is read only when this panel is visible, never during bootstrap.
    if (activePanel() === 'official-sources-panel' && stations.length) loadHistory();
  }

  function activePanel() { return typeof localStorage !== 'undefined' ? localStorage.getItem('activePanel') : ''; }

  function chart(points, unit, label) {
    const rows = points.filter((p) => Number.isFinite(Date.parse(p.at)) && finite(p.central)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!rows.length) return note('Aucun point disponible.');
    const minTime = Date.parse(rows[0].at), maxTime = Date.parse(rows[rows.length - 1].at);
    const values = rows.flatMap((p) => [p.lower, p.central, p.upper].filter(finite).map(Number));
    const lo = Math.min(...values), hi = Math.max(...values), padding = Math.max((hi - lo) * 0.12, 0.1);
    const x = (p) => 54 + (Date.parse(p.at) - minTime) / Math.max(1, maxTime - minTime) * 640;
    const y = (v) => 176 - (Number(v) - lo + padding) / (hi - lo + 2 * padding) * 150;
    const line = rows.map((p) => `${x(p).toFixed(1)},${y(p.central).toFixed(1)}`).join(' ');
    const bandRows = rows.filter((p) => finite(p.lower) && finite(p.upper));
    const band = [...bandRows.map((p) => `${x(p)},${y(p.lower)}`), ...bandRows.slice().reverse().map((p) => `${x(p)},${y(p.upper)}`)].join(' ');
    return `<svg class="official-chart" viewBox="0 0 720 220" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><line x1="54" y1="26" x2="54" y2="176" stroke="#9aabc5"/><line x1="54" y1="176" x2="694" y2="176" stroke="#9aabc5"/>${band ? `<polygon points="${band}" fill="#c8defa" opacity=".65"/>` : ''}<polyline points="${line}" fill="none" stroke="#1453a0" stroke-width="2.5"/>${rows.filter((_, i) => i % Math.max(1, Math.ceil(rows.length / 30)) === 0).map((p) => `<circle cx="${x(p)}" cy="${y(p.central)}" r="3" fill="#1453a0"><title>${esc(when(p.at))} : ${esc(fmt(p.central, unit))}</title></circle>`).join('')}<text x="5" y="25">${esc(fmt(hi, unit))}</text><text x="5" y="181">${esc(fmt(lo, unit))}</text><text x="54" y="205">${esc(when(rows[0].at))}</text><text x="520" y="205">${esc(when(rows[rows.length - 1].at))}</text></svg>`;
  }

  async function loadHistory() {
    const id = el('official-observation-station')?.value;
    const metric = el('official-observation-metric')?.value || 'temperature_c';
    if (!id) { put('official-observation-chart', ''); return; }
    const version = ++state.historyVersion;
    try {
      const result = await api(`/api/meteo-france/observations/${encodeURIComponent(id)}/history`, { maxRetries: 0, timeoutMs: 8000 });
      if (version !== state.historyVersion || activePanel() !== 'official-sources-panel') return;
      const unit = ({ temperature_c: '°C', gust_kmh: 'km/h', rain_6m_mm: 'mm/6 min' })[metric];
      put('official-observation-chart', chart((result.history || []).map((p) => ({ at: p.observed_at, central: p[metric] })), unit, 'Évolution des mesures officielles') + note(result.history_note || 'Historique constitué par les mesures collectées par le serveur.'));
    } catch (_) { if (version === state.historyVersion && activePanel() === 'official-sources-panel') put('official-observation-chart', note('Historique momentanément indisponible.')); }
  }

  function renderForecasts() {
    const data = state.snapshot.vigicrues_forecasts || {};
    const stations = Array.isArray(data.stations) ? data.stations : [];
    const published = stations.filter((s) => (s.series || []).length);
    options(el('official-forecast-station'), published, (s) => s.code, (s) => `${s.station || s.code} · ${s.river || ''}`);
    const station = published.find((s) => s.code === el('official-forecast-station')?.value) || published[0];
    const requested = el('official-forecast-variable')?.value || 'H';
    const series = station?.series?.find((s) => s.variable === requested);
    const info = data.info_state || (published.length ? `${published.length} station(s) avec prévisions publiées.` : 'Aucune prévision publiée actuellement pour les stations suivies.');
    put('official-forecast-summary', `<p><strong>${esc(status(data))}</strong> · ${esc(info)}</p>${note('Prévisions officielles disponibles selon les stations et la situation hydrologique. Elles ne constituent pas une simulation d’inondation sur la carte.')}`);
    if (!series) { put('official-forecast-chart', note(station ? 'Aucune prévision publiée pour cette grandeur. Choisir hauteur ou débit.' : info)); return; }
    const points = series.points || [];
    put('official-forecast-chart', `<p><strong>${esc(station.station || station.code)}</strong> · ${esc(series.unit)} · émis le ${esc(when(series.issued_at))}${series.expired ? ' · prévision expirée' : ''}</p>${chart(points, series.unit, 'Prévisions Vigicrues : valeur centrale et enveloppe publiée')}<p class="muted">La zone bleue représente les bornes publiées lorsqu’elles sont disponibles.</p><div class="official-table-wrap"><table><caption>Points de prévision publiés</caption><thead><tr><th>Échéance</th><th>Borne basse</th><th>Valeur centrale</th><th>Borne haute</th></tr></thead><tbody>${points.slice(0, 48).map((p) => `<tr><td>${esc(when(p.at))}</td><td>${esc(fmt(p.lower, series.unit))}</td><td>${esc(fmt(p.central, series.unit))}</td><td>${esc(fmt(p.upper, series.unit))}</td></tr>`).join('')}</tbody></table></div>${link(station.source_link, 'Station officielle')}`);
  }

  function industryResources() {
    const slot = state.snapshot.industrial_sites || {};
    return (Array.isArray(slot.sites) ? slot.sites : []).map((s) => ({ id: `icpe-${s.id}`, name: s.nom, type: 'lieu_risque', active: true, lat: s.lat, lon: s.lon, city: s.commune, address: s.adresse, priority: s.seveso === 'haut' ? 'critical' : 'risk', info: s.seveso_label, source: s.source_url, officialIndustrial: true }));
  }

  function mergeIndustryResources(resources) {
    const official = industryResources();
    if (!official.length) return resources;
    const normalise = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const names = new Set(official.map((site) => normalise(site.name)));
    // Only replace an identified duplicate; retain custom sites and other risks.
    return [...resources.filter((site) => site.type !== 'lieu_risque' || !names.has(normalise(site.name))), ...official];
  }

  function renderIndustries() {
    const slot = state.snapshot.industrial_sites || {};
    const query = (el('official-industry-search')?.value || '').trim().toLocaleLowerCase('fr');
    const classification = el('official-industry-filter')?.value || 'all';
    const all = Array.isArray(slot.sites) ? slot.sites : [];
    const filtered = all.filter((s) => (classification === 'all' || s.seveso === classification) && `${s.nom} ${s.commune} ${s.code_insee}`.toLocaleLowerCase('fr').includes(query));
    put('official-industry-summary', `<p>${all.length ? `${fmt(all.length)} établissements · ${fmt(slot.seveso_haut_total || 0)} Seveso seuil haut · ${fmt(slot.seveso_bas_total || 0)} seuil bas` : esc(slot.info_state || status(slot))}</p>${note('Référentiel des établissements, sans indication d’incident en cours. Les sites officiels complètent aussi l’analyse de zone.')}`);
    put('official-industry-table', filtered.length ? `<table><caption>${filtered.length} établissement(s) correspondant aux filtres</caption><thead><tr><th>Établissement</th><th>Commune</th><th>Classement</th><th>Activité</th></tr></thead><tbody>${filtered.slice(0, 250).map((s) => `<tr><th scope="row">${link(s.source_url, s.nom) || esc(s.nom)}</th><td>${esc(s.commune)}</td><td>${esc(s.seveso_label || s.regime)}</td><td>${esc(s.activite || s.etat_activite || 'Non renseignée')}</td></tr>`).join('')}</tbody></table>${filtered.length > 250 ? note('Affichage limité aux 250 premiers résultats. Affiner la recherche.') : ''}` : note(all.length ? 'Aucun établissement correspondant aux filtres.' : 'Le référentiel sera disponible après sa collecte en arrière-plan.'));
  }

  function renderEnedis() {
    const slot = state.snapshot.enedis || {};
    const links = Array.isArray(slot.official_links) ? slot.official_links : [{ label: 'Vérifier une coupure à une adresse', url: 'https://www.enedis.fr/panne-et-interruption' }, { label: 'Portail Collectivités', url: 'https://mon-compte-collectivite.enedis.fr/' }];
    put('official-enedis-body', `<p><strong>Diagnostic officiel à l’adresse</strong></p><p>Ouvrez le service Enedis pour consulter une adresse ou une commune. Le flux de coupures locales nécessite un accès autorisé ; son absence ici ne signifie pas qu’il n’y a aucune coupure.</p><div class="official-actions">${links.map((l) => link(l.url, l.label)).join('')}</div>`);
    const pop = state.snapshot.insee_population || {};
    put('official-population-body', `<p><strong>${fmt(pop.cells_total || 0)} carreaux disponibles · ${pop.resolution_m || 200} m</strong></p><p>L’analyse d’une zone dessinée sur la carte utilise automatiquement le référentiel lorsqu’il est prêt. Le rapport conserve la méthode, le millésime et la couverture.</p>${note(`Référence ${pop.data_year || 2021} : estimation de population résidente, pas de personnes présentes en temps réel. ${pop.info_state || ''}`)}<button type="button" class="ghost" data-open-official-map>Analyser une zone sur la carte</button>`);
  }

  function renderRadarControls() {
    const slot = state.snapshot.meteo_radar || {};
    const frames = slot.frames || [];
    const slider = el('official-radar-frame');
    if (state.frameIndex < 0 || state.frameIndex >= frames.length || !state.timer) state.frameIndex = Math.max(0, frames.length - 1);
    if (slider) { slider.max = String(Math.max(0, frames.length - 1)); slider.value = String(state.frameIndex); slider.disabled = !frames.length; }
    if (el('official-radar-play')) el('official-radar-play').disabled = frames.length < 2;
    put('official-radar-state', note(frames.length ? `${frames.length} image(s) · ${when(frames[state.frameIndex]?.observed_at)} · ${slot.unit || 'mm/5 min'}` : (slot.info_state || status(slot))));
    put('official-radar-legend', (slot.legend || []).map((item) => `<span><i style="background:${/^#[0-9a-f]{6}$/i.test(item.color) ? item.color : '#ccc'}"></i>${esc(item.label)}</span>`).join(''));
    put('official-radar-note', note(slot.history_note || 'L’animation se construit à mesure que le serveur collecte les images officielles.'));
    const current = new Set(frames.map((f) => f.id));
    state.frameUrls.forEach((value, key) => { if (!current.has(key) && key !== state.radarId && typeof value === 'string') { URL.revokeObjectURL(value); state.frameUrls.delete(key); } });
  }

  function removeLayer(key) {
    if (state.layers[key] && state.map) state.map.removeLayer(state.layers[key]);
    state.layers[key] = null;
    if (key === 'radar') state.radarId = null;
  }

  async function showRadar() {
    const version = ++state.radarVersion;
    if (!el('filter-official-radar')?.checked || !state.map || activePanel() !== 'map-panel') { removeLayer('radar'); return; }
    const frames = state.snapshot.meteo_radar?.frames || [];
    const frame = frames[Math.max(0, Math.min(state.frameIndex, frames.length - 1))];
    if (!frame) { removeLayer('radar'); return; }
    if (state.radarId === frame.id && state.layers.radar) return;
    try {
      let url = state.frameUrls.get(frame.id);
      if (!url) {
        const path = `/api/meteo-france/radar/frames/${encodeURIComponent(frame.id)}.png`;
        const sessionVersion = state.sessionVersion;
        const pending = apiFile(path).then(({ blob, contentType }) => {
          if (!contentType.startsWith('image/png')) throw new Error('Image radar invalide');
          if (sessionVersion !== state.sessionVersion) throw new Error('Session terminée');
          const objectUrl = URL.createObjectURL(blob); state.frameUrls.set(frame.id, objectUrl); return objectUrl;
        }).catch((error) => { if (sessionVersion === state.sessionVersion) state.frameUrls.delete(frame.id); throw error; });
        state.frameUrls.set(frame.id, pending);
        url = pending;
      }
      url = await url;
      if (version !== state.radarVersion || !el('filter-official-radar')?.checked || activePanel() !== 'map-panel') return;
      const replacement = window.L.imageOverlay(url, frame.bounds || state.snapshot.meteo_radar.bounds, { opacity: 0.65, interactive: false, attribution: '© Météo-France · pluie mesurée sur 5 minutes' });
      replacement.addTo(state.map);
      removeLayer('radar'); state.layers.radar = replacement; state.radarId = frame.id;
      put('official-radar-state', note(`Image ${when(frame.observed_at)} · pluie mesurée sur 5 minutes`));
    } catch (_) { if (version === state.radarVersion && activePanel() === 'map-panel') put('official-radar-state', note('Image radar indisponible. La carte reste utilisable.')); }
  }

  function syncMap() {
    if (typeof leafletMap === 'undefined' || !leafletMap || !window.L) return;
    if (state.map !== leafletMap) { Object.keys(state.layers).forEach(removeLayer); state.map = leafletMap; state.layerSignatures = {}; }
    if (activePanel() !== 'map-panel') { stopAnimation(); ++state.radarVersion; return; }
    const obsEnabled = Boolean(el('filter-official-observations')?.checked);
    const industriesEnabled = Boolean(el('filter-official-industries')?.checked);
    const obsSignature = `${obsEnabled}:${state.signatures.meteo_observations || ''}`;
    const industrySignature = `${industriesEnabled}:${state.signatures.industrial_sites || ''}`;
    const observationsChanged = obsSignature !== state.layerSignatures.observations;
    const industriesChanged = industrySignature !== state.layerSignatures.industries;
    if (observationsChanged) removeLayer('observations');
    if (industriesChanged) removeLayer('industries');
    if (observationsChanged && obsEnabled) {
      const layer = window.L.layerGroup();
      (state.snapshot.meteo_observations?.stations || []).filter((s) => finite(s.lat) && finite(s.lon)).forEach((s) => {
        window.L.circleMarker([s.lat, s.lon], { radius: 6, color: '#fff', weight: 2, fillColor: s.stale ? '#888' : '#087f8c', fillOpacity: 0.95 })
          .bindPopup(`<strong>${esc(s.name)}</strong><p>${esc(when(s.observed_at))}${s.stale ? ' · ancienne mesure' : ''}</p><p>${esc(fmt(s.temperature_c, '°C'))} · Pluie ${esc(fmt(s.rain_6m_mm, 'mm/6 min'))} · Rafale ${esc(fmt(s.gust_kmh, 'km/h'))}</p>`).addTo(layer);
      });
      layer.addTo(state.map); state.layers.observations = layer;
    }
    if (industriesChanged && industriesEnabled) {
      const layer = window.L.layerGroup();
      (state.snapshot.industrial_sites?.sites || []).filter((s) => finite(s.lat) && finite(s.lon)).forEach((s) => {
        window.L.circleMarker([s.lat, s.lon], { radius: s.seveso === 'haut' ? 8 : 5, color: '#fff', weight: 1, fillColor: s.seveso === 'haut' ? '#a12636' : s.seveso === 'bas' ? '#d17b12' : '#655491', fillOpacity: 0.9 })
          .bindPopup(`<strong>${esc(s.nom)}</strong><p>${esc(s.commune)} · ${esc(s.seveso_label || s.regime)}</p><p>${esc(s.adresse || '')}</p>${note('Référentiel industriel, sans indication d’incident en cours.')}${link(s.source_url, 'Fiche officielle')}`).addTo(layer);
      });
      layer.addTo(state.map); state.layers.industries = layer;
    }
    state.layerSignatures.observations = obsSignature;
    state.layerSignatures.industries = industrySignature;
    showRadar();
  }

  function stopAnimation() { if (state.timer) clearInterval(state.timer); state.timer = null; if (el('official-radar-play')) el('official-radar-play').textContent = 'Lire l’animation'; }
  function toggleAnimation() {
    if (state.timer) { stopAnimation(); return; }
    if ((state.snapshot.meteo_radar?.frames || []).length < 2) return;
    if (el('filter-official-radar')) el('filter-official-radar').checked = true;
    if (typeof setActivePanel === 'function') setActivePanel('map-panel');
    if (el('official-radar-play')) el('official-radar-play').textContent = 'Pause';
    state.timer = setInterval(() => {
      if (document.hidden || activePanel() !== 'map-panel') { stopAnimation(); return; }
      state.frameIndex = (state.frameIndex + 1) % state.snapshot.meteo_radar.frames.length;
      if (el('official-radar-frame')) el('official-radar-frame').value = String(state.frameIndex);
      showRadar();
    }, 1200);
  }

  async function estimatePopulation(geometry) {
    try { return await api('/api/population/isere/estimate', { method: 'POST', body: JSON.stringify({ geometry }), maxRetries: 0, timeoutMs: 8000 }); }
    catch (_) { return { status: 'unavailable', info_state: 'Analyse INSEE indisponible ; méthode surfacique conservée.' }; }
  }

  function populationDecision(result, fallback, fallbackSource) {
    const coverage = Number(result?.scope_coverage_ratio ?? 0);
    const useGrid = ['online', 'stale'].includes(result?.status) && coverage >= 0.999 && finite(result?.population_estimated);
    const value = useGrid ? Math.round(Number(result.population_estimated)) : fallback;
    const source = useGrid ? `Estimation INSEE Filosofi ${result.data_year || 2021} · carreaux ${result.resolution_m || 200} m · pondération des surfaces intersectées${result.cache_stale || result.status === 'stale' ? ' · cache ancien' : ''}` : fallbackSource;
    return { useGrid, value, source, note: useGrid ? `Population résidente estimée ; ${Number(result.imputed_cells || 0)} carreau(x) imputé(s).` : (result?.status === 'partial' ? `Carroyage partiel : ${(coverage * 100).toFixed(1)} % de la zone couverte. Méthode surfacique conservée pour le total.` : (result?.info_state || 'Carroyage indisponible ou en cours d’import ; méthode surfacique conservée.')) };
  }

  function activate(panel) {
    if (panel !== 'map-panel') { stopAnimation(); ++state.radarVersion; }
    if (panel === 'official-sources-panel') { renderForecasts(); loadHistory(); }
    if (panel === 'map-panel') syncMap();
  }

  function reset() {
    stopAnimation(); ++state.radarVersion; ++state.historyVersion; ++state.sessionVersion;
    Object.keys(state.layers).forEach(removeLayer);
    state.frameUrls.forEach((url) => { if (typeof url === 'string') URL.revokeObjectURL(url); });
    state.frameUrls.clear(); state.snapshot = {}; state.signatures = {}; state.layerSignatures = {}; state.map = null;
  }

  function bind() {
    ['official-observation-station', 'official-observation-metric'].forEach((id) => el(id)?.addEventListener('change', loadHistory));
    ['official-forecast-station', 'official-forecast-variable'].forEach((id) => el(id)?.addEventListener('change', renderForecasts));
    ['official-industry-search', 'official-industry-filter'].forEach((id) => el(id)?.addEventListener('input', renderIndustries));
    ['filter-official-observations', 'filter-official-industries', 'filter-official-radar'].forEach((id) => el(id)?.addEventListener('change', () => {
      if (id === 'filter-official-radar' && !el(id).checked) stopAnimation();
      syncMap();
    }));
    el('official-radar-play')?.addEventListener('click', toggleAnimation);
    el('official-radar-frame')?.addEventListener('input', () => { stopAnimation(); state.frameIndex = Number(el('official-radar-frame').value); showRadar(); });
    document.addEventListener('click', async (event) => {
      if (event.target.closest('[data-open-official]')) setActivePanel('official-sources-panel');
      if (event.target.closest('[data-open-official-map]')) setActivePanel('map-panel');
      const button = event.target.closest('[data-official-refresh]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try { await api(`/external/isere/risks/${encodeURIComponent(button.dataset.officialRefresh)}/refresh`, { method: 'POST', maxRetries: 0 }); button.textContent = 'Collecte demandée'; }
      catch (_) { button.textContent = 'Réessayer'; }
      finally { button.disabled = false; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopAnimation(); });
  }

  window.OfficialSources = { update, activate, syncMap, reset, industryResources, mergeIndustryResources, estimatePopulation, populationDecision, status, chart };
  document.addEventListener('DOMContentLoaded', bind, { once: true });
})();
