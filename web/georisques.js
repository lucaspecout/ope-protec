(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? escape(String(value).slice(0, 10)) : 'Non renseignée';
  const number = value => Number.isFinite(value) ? value.toLocaleString('fr-FR') : '—';
  const state = data => data?.status === 'online' ? 'À jour' : data?.status === 'fallback' ? 'Référentiel officiel de secours' : data?.status === 'stale' ? 'Dernières données connues · source indisponible' : 'Données indisponibles';
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let snapshot = {}, selected = null, tab = 'natural', request = null, historyVersion = 0;
  const fields = {
    'mvt': [['Type', 'type'], ['Lieu', 'lieu'], ['Début', 'dateDebut'], ['Fiabilité', 'fiabilite'], ['Commentaire', 'commentaireMvt']],
    'cavites': [['Nom', 'nom'], ['Type', 'type'], ['Repérage', 'reperageGeographique']],
    'radon': [['Classe de potentiel', 'classePotentiel'], ['Commune', 'libelleCommune']],
    'zonage_sismique': [['Zone de sismicité', 'zoneSismicite'], ['Type de zone', 'typeZone']],
    'gaspar/dicrim': [['Année de publication', 'anneePublication']],
  };
  const descriptions = {
    mvt: 'Inventaire historique des mouvements connus ; ce nombre ne mesure pas le danger actuel.',
    cavites: 'Cavités recensées dans l’inventaire officiel.',
    radon: 'Potentiel géologique de la commune : classe 1, 2 ou 3. Il ne remplace pas une mesure dans un bâtiment.',
    zonage_sismique: 'Zonage réglementaire ; il ne prédit pas la survenue d’un séisme.',
    'gaspar/papi': 'Programmes d’actions de prévention contre les inondations.',
    'gaspar/tri': 'Territoires identifiés à risque important d’inondation.',
    'gaspar/tim': 'Dossiers de transmission d’information au maire.',
  };
  function records(key, data) {
    const rows = Array.isArray(data?.content) ? data.content : [];
    return `<section class="geo-data-section"><header><h4>${escape(data?.label || key)}</h4><span class="geo-state ${data?.status === 'stale' ? 'geo-stale' : ''}">${escape(state(data))}</span></header>
      <p class="muted">${escape(descriptions[key] || '')} ${data?.status === 'fallback' ? `Millésime : ${data.data_date ? date(data.data_date) : 'date de publication non précisée'}. Collecté le ${date(data.updated_at)}.` : data?.updated_at ? `Données du ${date(data.updated_at)}.` : ''}</p>
      ${data?.coverage_note ? `<p class="muted">${escape(data.coverage_note)}</p>` : ''}
      ${data?.source && /^https:\/\//.test(data.source) ? `<a href="${escape(data.source)}" target="_blank" rel="noopener noreferrer">Source de ces données ↗</a>` : ''}
      <p><strong>${number(data?.total_elements)}</strong> élément(s) recensé(s)</p>
      ${!rows.length ? `<p class="muted">${data?.total_elements === 0 ? 'Aucun élément retourné par la source pour ce périmètre.' : 'Aucune donnée disponible pour ce périmètre.'}</p>` : `<div class="geo-records">${rows.map((row, i) => {
        const pairs = fields[key] || [['Libellé', 'libelle'], ['Plan', 'libPpr'], ['Bassin de risques', 'libBassinRisques'], ['Modification', 'dateModification'], ['Transmission', 'dateTransmission']];
        const values = pairs.filter(([,field]) => row[field] !== undefined && row[field] !== null && row[field] !== '');
        const code = String(selected?.code_insee || '');
        const aleas = (row.communes || []).filter(c => !code || String(c.codeInsee) === code).flatMap(c => c.aleas || []);
        return `<article class="geo-record" ${i >= 20 ? 'hidden data-geo-extra' : ''}><dl>${values.map(([label,field]) => `<div><dt>${escape(label)}</dt><dd>${escape(row[field])}</dd></div>`).join('')}${row.identifiant || row.idGaspar ? `<div><dt>Référence</dt><dd>${escape(row.identifiant || row.idGaspar)}</dd></div>` : ''}</dl>${aleas.length ? `<p>${escape([...new Set(aleas.map(a => a.libelle).filter(Boolean))].join(' · '))}</p>` : ''}</article>`;
      }).join('')}</div>${rows.length > 20 ? `<button type="button" class="ghost" data-geo-more>Afficher les ${rows.length - 20} autres éléments</button>` : ''}`}</section>`;
  }
  function matching(row) {
    const code = String(row.code_insee || row.codeInsee || '');
    return code ? code === String(selected?.code_insee || '') : normalize(row.commune || row.nom_commune) === normalize(selected?.name);
  }
  function localServices() {
    const catnat = snapshot.catnat_isere || {};
    const industrial = snapshot.industrial_sites || {};
    const events = (catnat.events || []).filter(matching);
    const sites = (industrial.sites || []).filter(matching);
    const coverage = (catnat.communes || []).find(c => String(c.code) === String(selected?.code_insee));
    return `<section class="geo-data-section"><h4>Reconnaissances de catastrophe naturelle</h4><p>${coverage?.checked ? number(coverage.events_total) : '—'} reconnaissance(s) dans l’historique communal.</p><p class="muted">Historique administratif, sans alerte actuelle. ${events.length} élément(s) présent(s) dans l’aperçu disponible.</p>
      ${events.map(r => `<article class="geo-record"><strong>${escape(r.risk)}</strong><p>Événement : ${date(r.event_start)} au ${date(r.event_end)} · Publication : ${date(r.published_at)}</p></article>`).join('')}
      <button type="button" class="ghost" data-geo-history>Afficher l’historique communal complet collecté</button><div id="geo-full-history" aria-live="polite"></div>
      <a href="https://www.georisques.gouv.fr/donnees/bases-de-donnees/procedures-administratives-relatives-aux-risques" target="_blank" rel="noopener noreferrer">Consulter la source officielle CatNat ↗</a></section>
      <section class="geo-data-section"><h4>Installations industrielles recensées</h4><p class="muted">${escape(state(industrial))} · Périmètre communal. Le classement décrit une installation ; il ne signale pas un incident.</p>
      ${sites.length ? sites.map(r => `<article class="geo-record"><strong>${escape(r.nom || r.name)}</strong><p>${escape(r.seveso_label || 'Classement Seveso non renseigné')}</p></article>`).join('') : '<p>Aucun site dans les données disponibles pour cette commune.</p>'}
      <a href="https://www.georisques.gouv.fr/risques/installations/donnees" target="_blank" rel="noopener noreferrer">Consulter les installations officielles ↗</a></section>`;
  }
  function renderCommune(commune) {
    ++historyVersion;
    selected = commune;
    const root = document.getElementById('georisques-pcs-detail');
    if (!root) return;
    if (!commune) { root.innerHTML = '<p>Choisissez une commune pour explorer ses données officielles par thème.</p>'; return; }
    const datasets = commune.datasets || {};
    const url = `https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2?typeForm=commune&codeInsee=${encodeURIComponent(commune.code_insee || '')}`;
    const keys = tab === 'natural' ? ['radon','zonage_sismique','mvt','cavites'] : ['gaspar/risques','gaspar/pprn','gaspar/pprm','gaspar/pprt','gaspar/azi','gaspar/tri','gaspar/papi','gaspar/dicrim','gaspar/tim'].filter(key => !key.startsWith('gaspar/ppr') || datasets[key]);
    root.innerHTML = `<div class="geo-commune-heading"><div><h3>${escape(commune.name)}</h3><p>Code INSEE ${escape(commune.code_insee || 'non renseigné')}</p></div><a class="ghost" href="${escape(url)}" target="_blank" rel="noopener noreferrer">Rapport officiel ↗</a></div>
      <div class="geo-tabs" role="group" aria-label="Thèmes Géorisques">${[['natural','Risques naturels'],['prevention','Prévention & documents'],['history','CatNat & industrie']].map(([key,label])=>`<button type="button" data-geo-tab="${key}" aria-pressed="${tab===key}">${label}</button>`).join('')}</div>
      ${tab === 'history' ? localServices() : keys.map(key => records(key, datasets[key] || {label: ({'radon':'Potentiel radon','zonage_sismique':'Zonage sismique','mvt':'Mouvements de terrain','cavites':'Cavités souterraines'})[key] || key})).join('')}`;
  }
  function update(data, external, api) {
    snapshot = external || {};
    request = api;
    let root = document.getElementById('georisques-rich-overview');
    if (!root) return;
    const sets = data.datasets || {};
    const available = Object.values(sets).filter(d => ['online','fallback'].includes(d.status)).length;
    document.getElementById('georisques-page-source').textContent = `Source : Géorisques / BRGM · ${data.scope || 'Communes PCS suivies'} · ${data.updated_at ? `Collecte du ${String(data.updated_at).slice(0,10)}` : 'Collecte en attente'}`;
    root.innerHTML = `<div class="geo-summary"><article class="tile"><p>Communes suivies</p><strong>${number(data.monitored_communes?.length)}</strong></article><article class="tile"><p>Thèmes disponibles</p><strong>${available} / ${Object.keys(sets).length || 12}</strong></article>${[['Mouvements recensés','ground_movements_total'],['Cavités recensées','cavities_total'],['Plans de prévention','ppr_total'],['Atlas inondation','flood_documents_total']].map(([label,key])=>`<article class="tile"><p>${label}</p><strong>${number(data[key])}</strong></article>`).join('')}</div>
      <p class="muted">Les chiffres portent sur les communes suivies, pas sur tout le département. Un inventaire historique ne constitue pas une alerte en temps réel. « — » signifie donnée indisponible.${Object.values(sets).some(d => d.status === 'stale') ? ' Certains chiffres proviennent des dernières données connues : consulter les dates dans les détails.' : ''}</p>
      ${data.recovered_sources?.length ? '<p class="geo-api-details">Mode secours actif : les données disponibles ci-dessous proviennent des référentiels officiels GASPAR, ASNR et DDT de l’Isère. Le millésime et la source figurent dans chaque fiche.</p>' : ''}
      ${data.errors?.length ? `<details class="geo-api-details"><summary>${data.errors.length} source(s) encore indisponible(s) · consulter le diagnostic</summary><ul>${data.errors.map(e=>`<li>${escape(e)}</li>`).join('')}</ul></details>` : ''}
      ${data.api_errors?.length ? `<details class="geo-api-details"><summary>Diagnostic des appels API Géorisques</summary><ul>${[...new Set(data.api_errors.map(e=>String(e).split(' : ').slice(1).join(' : ')))].map(e=>`<li>${escape(e)}</li>`).join('')}</ul></details>` : ''}
      <details class="geo-api-details"><summary>Plans de prévention · périmètre des communes suivies</summary><p class="muted">Liste commune aux communes suivies. Les communes sont précisées dans les fiches lorsque le référentiel les fournit.</p>${['pprn','pprm','pprt'].map(key=>records('gaspar/'+key, sets['gaspar/'+key] || {label:key.toUpperCase()})).join('')}</details>`;
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-geo-tab], [data-geo-more], [data-geo-history]');
    if (!button) return;
    if (button.dataset.geoTab) { tab = button.dataset.geoTab; renderCommune(selected); }
    else if (button.hasAttribute('data-geo-history')) {
      const root = document.getElementById('geo-full-history'), code = String(selected?.code_insee || ''), version = ++historyVersion;
      if (!/^38\d{3}$/.test(code) || !request) { root.textContent = 'Code INSEE ou historique indisponible.'; return; }
      root.textContent = 'Lecture de l’historique collecté…';
      button.disabled = true;
      try {
        const result = await request(`/api/catnat/isere/history?code_insee=${encodeURIComponent(code)}`, { maxRetries: 0, timeoutMs: 8000 });
        if (version !== historyVersion || selected?.code_insee !== code || tab !== 'history') return;
        root.innerHTML = `<p class="muted">${escape(result.coverage_warning || result.note || 'Historique collecté localement.')}</p>` + (result.events || []).filter(matching).map(row => `<article class="geo-record"><strong>${escape(row.risk)}</strong><p>${date(row.event_start)} au ${date(row.event_end)} · JO ${date(row.published_at)}</p></article>`).join('');
      } catch (_) {
        if (version === historyVersion) root.textContent = 'Historique indisponible. Vous pouvez réessayer.';
      } finally { button.disabled = false; }
    }
    else { button.closest('.geo-data-section').querySelectorAll('[data-geo-extra]').forEach(row => row.hidden = false); button.remove(); }
  });
  window.GeorisquesPage = { update, renderCommune };
})();
