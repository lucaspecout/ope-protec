/* Commune-scoped views. Network reads start only when their tab is opened. */
(function () {
  'use strict';
  const TABS = [['risks', 'Risques'], ['water', 'Eau'], ['resources', 'Ressources locales'], ['catnat', 'CatNat']];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normal = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const code = value => /^38\d{3}$/.test(String(value ?? '').trim()) ? String(value).trim() : '';
  const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : 'Non renseignée';
  const fmt = (value, unit = '') => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}` : 'Non renseigné';
  const note = text => `<p class="muted muni-service-note">${esc(text)}</p>`;
  const link = (url, label = 'Site officiel ↗') => { try { const parsed = new URL(url); return parsed.protocol === 'https:' ? `<a class="muni-source-link" href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : ''; } catch (_) { return ''; } };
  const status = slot => ({ online: 'Données collectées', partial: 'Couverture partielle', stale: 'Données anciennes', degraded: 'Données incomplètes', error: 'Indisponible', offline: 'Indisponible', unavailable: 'Indisponible', pending: 'Collecte en cours' }[slot?.status] || 'Disponibilité à confirmer');
  const stamp = slot => note(`${status(slot)} · Collecte : ${date(slot?.updated_at || slot?.checked_at)}`);
  const card = (title, body, url) => `<section class="muni-service-card"><div class="muni-service-card-head"><h5>${esc(title)}</h5>${url ? link(url) : ''}</div>${body}</section>`;
  const table = (headers, data, empty = 'Aucun élément rattaché à cette commune dans les données collectées.') => data.length ? `<div class="muni-service-table"><table><thead><tr>${headers.map(header => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead><tbody>${data.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : note(empty);
  let current = null, generation = 0;

  function matchesMunicipality(row, municipality) {
    if (!row || typeof row !== 'object') return false;
    const details = row.details || {}, commune = row.commune && typeof row.commune === 'object' ? row.commune : {};
    const codes = [row.code_insee, row.insee_code, row.code_commune, row.commune_code, row.insee, details.code_commune, details.code_insee, `${details.code_departement || ''}${details.code_commune || ''}`, commune.code].map(code).filter(Boolean);
    const insee = code(municipality.insee_code || municipality.code_insee);
    if (codes.length && insee) return codes[0] === insee;
    // A postal code alone or a substring never identifies a commune.
    const name = row.commune_name || row.nom_commune || row.municipality || row.city || row.ville || (typeof row.commune === 'string' ? row.commune : commune.name || commune.nom) || details.commune;
    if (!name || !municipality.name || normal(name) !== normal(municipality.name)) return false;
    if (row.postal_code && municipality.postal_code && String(row.postal_code).slice(0, 2) !== String(municipality.postal_code).slice(0, 2)) return false;
    return true;
  }
  const local = (items, municipality) => rows(items).filter(row => matchesMunicipality(row, municipality));
  function markup() {
    return {
      tabs: TABS.map(([key, title]) => `<button type="button" class="muni-tab-btn" data-muni-tab="${key}">${title}</button>`).join(''),
      sections: TABS.map(([key, title]) => `<div class="muni-detail-section" data-muni-section="${key}"><div class="muni-service-intro"><div><span class="muni-detail-eyebrow">DONNÉES DE LA COMMUNE</span><h5>${title}</h5><p>Sources et dates propres à la commune sélectionnée.</p></div><button type="button" class="ghost" data-muni-service-refresh="${key}">Actualiser</button></div><div data-muni-service-body="${key}">${note('Ouvrez cet onglet pour consulter les données de la commune.')}</div></div>`).join(''),
    };
  }
  function snapshot(context) { return typeof context.getSnapshot === 'function' ? context.getSnapshot() || {} : {}; }
  function active(context, target) {
    const modal = document.getElementById('municipality-details-modal');
    return current === context && context.generation === generation && context.root.isConnected !== false && context.root.querySelector(`[data-muni-service-body="${target.dataset.muniServiceBody}"]`) === target && (!modal || modal.open);
  }
  function mount(root, municipality, getSnapshot) {
    reset();
    current = { root, municipality: { ...municipality }, getSnapshot, generation, loaded: new Set(), pending: new Map() };
  }
  function reset() { ++generation; current = null; }
  function renderIndustrial(context, data) {
    const slot = data.industrial_sites || {}, sites = local(slot.sites, context.municipality);
    return card('ICPE / Seveso dans la commune', stamp(slot) + table(['Établissement', 'Classement', 'Adresse'], sites.map(site => [esc(site.nom || site.name), esc(site.seveso_label || site.regime || 'Non renseigné'), esc(site.adresse || 'Non renseignée')])) + note('Référentiel réglementaire : il ne signale pas des incidents en cours.'), 'https://www.georisques.gouv.fr/');
  }
  function georisquesMarkup(payload, context, slot = payload) {
    const source = payload || {}, values = [
      ['Zone sismique', source.seismic_zone || source.zone_sismicite], ['Potentiel radon', source.radon_potential || source.radon],
      ['Mouvements de terrain recensés', source.landslides_total], ['Cavités recensées', source.cavities_total],
      ['PPR naturels', source.ppr_by_risk?.pprn], ['PPR miniers', source.ppr_by_risk?.pprm], ['PPR technologiques', source.ppr_by_risk?.pprt],
      ['Publication du DICRIM', source.dicrim_publication_year],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '');
    const risks = (Array.isArray(source.gaspar_risks) ? source.gaspar_risks : Array.isArray(source.risks) ? source.risks : []).map(risk => typeof risk === 'string' ? risk : risk.libelle_risque || risk.libelle || risk.label || risk.name || risk.risk || '').filter(Boolean);
    const documents = rows(source.flood_documents_details);
    const reportUrl = typeof buildGeorisquesMunicipalityUrl === 'function' ? buildGeorisquesMunicipalityUrl({ communeName: context.municipality.name, insee: context.municipality.insee_code, postalCode: context.municipality.postal_code }) : `https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2?codeInsee=${encodeURIComponent(context.municipality.insee_code || '')}`;
    return card('Géorisques · risques et documents communaux', stamp(slot) + table(['Indicateur', 'Valeur publiée'], values.map(([label, value]) => [esc(label), esc(value)]), 'Indicateurs communaux non renseignés dans les données reçues.') + (risks.length ? `<ul class="muni-service-list">${risks.map(risk => `<li>${esc(risk)}</li>`).join('')}</ul>` : note('Aucun risque détaillé reçu ; cela ne permet pas de conclure à une absence de risque.')) + table(['Document inondation', 'Date'], documents.map(doc => [esc(doc.title || doc.libelle_azi || 'Document'), esc(date(doc.published_at))])) , code(context.municipality.insee_code) ? reportUrl : 'https://www.georisques.gouv.fr/');
  }
  async function risks(context, target) {
    const data = snapshot(context), slot = data.georisques || {}, georisques = { ...(slot.data || {}), ...slot };
    const communes = rows(georisques.monitored_communes || georisques.monitored_municipalities || georisques.communes);
    let entry = communes.find(row => matchesMunicipality({ ...row, commune: row.commune || row.name }, context.municipality));
    if (!entry) {
      try {
        const result = await api(`/municipalities/${encodeURIComponent(context.municipality.id)}/georisques-risks`, { maxRetries: 0, timeoutMs: 20000 });
        if (!active(context, target)) return;
        const resultCode = code(result.code_insee);
        if (code(context.municipality.insee_code) && resultCode !== code(context.municipality.insee_code)) throw new Error('Commune mismatch');
        entry = resultCode ? result : {};
      } catch (_) { entry = {}; }
    }
    if (active(context, target)) target.innerHTML = georisquesMarkup(entry, context, entry.updated_at ? entry : slot) + renderIndustrial(context, data);
  }
  function waterSnapshot(context, data) {
    const municipality = context.municipality, vigieau = data.vigieau || {};
    const zones = rows(vigieau.alerts).filter(zone => rows(zone.communes).some(commune => matchesMunicipality({ code_insee: commune.code, commune: commune.name }, municipality)));
    const restrictions = card('Restrictions d’eau · VigiEau', stamp(vigieau) + table(['Zone', 'Niveau publié', 'Ressource', 'Validité'], zones.map(zone => [esc(zone.zone || zone.code), esc(zone.level || 'Non renseigné'), esc(zone.water_type_label || zone.water_type || 'Non renseignée'), `${esc(date(zone.start_date))} – ${esc(date(zone.end_date))}${zone.arrete?.url ? `<br>${link(zone.arrete.url, 'Arrêté officiel ↗')}` : ''}`]), 'Aucune zone rattachée à cette commune dans les données collectées. Vérifiez les restrictions sur VigiEau.') + note('Les mesures dépendent de la ressource et du public concerné ; consultez l’arrêté applicable.'), 'https://www.vigieau.gouv.fr/');
    const onde = data.onde_isere || {}, groundwater = data.groundwater_isere || {};
    return restrictions + card('Écoulement des petits cours d’eau · ONDE', stamp(onde) + table(['Cours d’eau / station', 'Observation', 'Date'], local(onde.stations, municipality).map(row => [esc(row.river || row.name), esc(row.flow_label), esc(date(row.observed_at))])) + note('Observations de campagne ; elles ne décrivent pas un débit instantané.'), 'https://onde.eaufrance.fr/') + card('Nappes phréatiques · Hub’Eau', stamp(groundwater) + table(['Station', 'Niveau', 'Tendance', 'Date'], local(groundwater.stations, municipality).map(row => [esc(row.name || row.code_bss), esc(fmt(row.groundwater_level_m_ngf, 'm NGF')), esc(row.trend || 'Non renseignée'), esc(date(row.date_measure))])), 'https://hubeau.eaufrance.fr/');
  }
  function qualityMarkup(payload, municipality) {
    if ((payload.code_commune || rows(payload.items).length) && code(payload.code_commune) !== code(municipality.insee_code)) return note('Les données reçues ne correspondent pas à la commune.');
    return stamp(payload) + (payload.warning ? note(payload.warning) : '') + table(['Prélèvement', 'Paramètre', 'Résultat', 'Conclusion publiée'], rows(payload.items).map(row => [esc(date(row.date_prelevement)), esc(row.libelle_parametre), esc(row.resultat_alphanumerique || fmt(row.resultat_numerique, row.libelle_unite)), esc(row.conclusion_conformite_prelevement || 'Non renseignée')]), 'Aucun résultat d’analyse disponible pour cette commune.') + note('Les résultats décrivent les prélèvements datés publiés par le producteur.');
  }
  function waterServicesMarkup(payload, municipality) {
    if ((payload.code_commune || rows(payload.items).length) && code(payload.code_commune) !== code(municipality.insee_code)) return note('Les données reçues ne correspondent pas à la commune.');
    return stamp(payload) + table(['Service', 'Année', 'Prix', 'Rendement', 'Population desservie'], rows(payload.items).map(row => [esc(row.nom_service || row.type_service || 'Service'), esc(row.annee || 'Non renseignée'), esc(fmt(row.prix_ttc_m3, '€/m³')), esc(fmt(row.rendement_reseau, '%')), esc(fmt(row.population_desservie))]), 'Aucun indicateur de service d’eau disponible pour cette commune.') + note('Indicateurs annuels de services d’eau et d’assainissement, selon les millésimes publiés.');
  }
  async function water(context, target) {
    target.innerHTML = waterSnapshot(context, snapshot(context)) + card('Qualité de l’eau potable', '<div data-muni-water-quality>Chargement des analyses communales…</div>', 'https://hubeau.eaufrance.fr/page/api-qualite-eau-potable') + card('Eau et assainissement · indicateurs de service', '<div data-muni-water-services>Chargement des indicateurs communaux…</div>', 'https://www.services.eaufrance.fr/');
    if (!code(context.municipality.insee_code)) {
      target.querySelector('[data-muni-water-quality]').innerHTML = note('Renseignez le code INSEE de la commune pour consulter ses analyses.');
      target.querySelector('[data-muni-water-services]').innerHTML = note('Renseignez le code INSEE de la commune pour consulter ses indicateurs.');
      return;
    }
    await Promise.all([['water-quality', '[data-muni-water-quality]', qualityMarkup], ['water-services', '[data-muni-water-services]', waterServicesMarkup]].map(async ([endpoint, selector, renderer]) => {
      try {
        const result = await api(`/municipalities/${encodeURIComponent(context.municipality.id)}/${endpoint}`, { maxRetries: 0, timeoutMs: 20000 });
        if (active(context, target)) target.querySelector(selector).innerHTML = renderer(result, context.municipality);
      } catch (_) { if (active(context, target)) target.querySelector(selector).innerHTML = note('Données temporairement indisponibles. Réessayez avec Actualiser.'); }
    }));
  }
  function resources(context, target) {
    const data = snapshot(context), municipality = context.municipality, fuel = data.fuel_isere || {};
    let html = card('Stations-service et carburants', stamp(fuel) + table(['Station / adresse', 'Carburants et prix déclarés', 'Ruptures temporaires'], local(fuel.stations, municipality).map(station => [esc(station.address || station.commune), rows(station.fuels).map(item => `${esc(item.fuel)} : ${esc(fmt(item.price_eur, '€/L'))} · ${esc(date(item.updated_at))}`).join('<br>'), esc(rows(station.fuels).filter(item => item.shortage === 'temporary').map(item => item.fuel).join(', ') || 'Aucune rupture temporaire déclarée')])) + note('Les prix et ruptures sont déclaratifs ; ils ne garantissent ni le stock ni l’ouverture.'), 'https://www.prix-carburants.gouv.fr/');
    for (const [key, title, url] of [['finess_isere', 'Établissements de santé · FINESS', 'https://finess.esante.gouv.fr/'], ['geodae_isere', 'Défibrillateurs · Geo’DAE', 'https://www.data.gouv.fr/fr/datasets/geodae-base-nationale-des-defibrillateurs/']]) {
      const slot = data[key] || {};
      html += card(title, stamp(slot) + table(['Équipement / établissement', 'Adresse', 'Type'], local(slot.resources, municipality).map(row => [esc(row.name || row.nom || 'Non renseigné'), esc(row.address || row.adresse || 'Non renseignée'), esc(row.type || row.category || 'Non renseigné')])), url);
    }
    target.innerHTML = html;
  }
  async function catnat(context, target) {
    const insee = code(context.municipality.insee_code);
    if (!insee) { target.innerHTML = note('Renseignez le code INSEE pour consulter l’historique CatNat de cette commune.'); return; }
    try {
      const result = await api(`/api/catnat/isere/history?code_insee=${encodeURIComponent(insee)}`, { maxRetries: 0, timeoutMs: 10000 });
      if (!active(context, target)) return;
      target.innerHTML = card('Reconnaissances de catastrophe naturelle', stamp(result) + (result.coverage_warning ? note(result.coverage_warning) : '') + table(['Nature', 'Événement', 'Publication au JO', 'Référence'], local(result.events, context.municipality).map(row => [esc(row.risk), `${esc(date(row.event_start))} – ${esc(date(row.event_end))}`, esc(date(row.published_at)), esc(row.id)]), 'Aucune reconnaissance reçue pour cette commune dans l’historique disponible.') + note('Historique des reconnaissances par commune et arrêté ; il ne décrit pas un danger en cours.'), 'https://www.georisques.gouv.fr/');
    } catch (_) { if (active(context, target)) target.innerHTML = note('Historique CatNat temporairement indisponible. Réessayez avec Actualiser.'); }
  }
  async function activate(tab, force = false) {
    const context = current;
    if (!context || !TABS.some(([key]) => key === tab)) return;
    if (context.pending.has(tab)) return context.pending.get(tab);
    if (context.loaded.has(tab) && !force) return;
    const target = context.root.querySelector(`[data-muni-service-body="${tab}"]`);
    if (!target) return;
    target.innerHTML = note('Lecture des données de la commune…');
    const button = context.root.querySelector(`[data-muni-service-refresh="${tab}"]`);
    if (button) button.disabled = true;
    const task = Promise.resolve().then(() => ({ risks, water, resources, catnat })[tab](context, target));
    context.pending.set(tab, task);
    try { await task; if (active(context, target)) context.loaded.add(tab); }
    catch (_) { if (active(context, target)) target.innerHTML = note('Données indisponibles. Réessayez avec Actualiser.'); }
    finally { context.pending.delete(tab); if (active(context, target) && button) button.disabled = false; }
  }
  document.addEventListener('click', event => { const button = event.target.closest?.('[data-muni-service-refresh]'); if (button) activate(button.dataset.muniServiceRefresh, true); });
  window.MunicipalityServices = { markup, mount, activate, reset, matchesMunicipality };
})();
