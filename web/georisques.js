(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? escape(String(value).slice(0, 10)) : 'Non renseignée';
  const number = value => Number.isFinite(value) ? value.toLocaleString('fr-FR') : '—';
  const state = data => data?.status === 'online' ? 'À jour' : data?.status === 'fallback' ? 'Référentiel officiel de secours' : data?.status === 'stale' ? 'Dernières données connues · source indisponible' : 'Données indisponibles';
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const documentUrl = url => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : ''; } catch (_) { return ''; } };
  let snapshot = {}, selected = null, tab = 'natural', request = null, historyVersion = 0, renderedSignature = '', overviewSignature = '';
  const paths = {
    pin:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    mountain:'m2 20 8-15 5 9 3-5 5 11H2 M7 11l3 2 3-2',
    layers:'m3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5',
    wave:'M2 8c3-5 7 5 10 0s7 5 10 0M2 14c3-5 7 5 10 0s7 5 10 0M2 20c3-5 7 5 10 0s7 5 10 0',
    document:'M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h8',
    pulse:'M2 12h5l3-8 4 16 3-8h5',
    atom:'M12 10v4M10 12h4M20 12a8 3 45 1 1-16 0 8 3 45 1 1 16 0ZM20 12a8 3-45 1 1-16 0 8 3-45 1 1 16 0Z',
    grid:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.document}"/></svg>`;
  const titles = {'radon':'Potentiel radon','zonage_sismique':'Sismicité','mvt':'Mouvements de terrain','cavites':'Cavités souterraines','gaspar/risques':'Risques recensés','gaspar/azi':'Atlas des zones inondables','gaspar/pprn':'Plans de prévention naturels','gaspar/pprm':'Plans de prévention miniers','gaspar/pprt':'Plans de prévention technologiques','gaspar/tri':'Territoires à risque d’inondation','gaspar/papi':'Programmes de prévention des inondations','gaspar/dicrim':'DICRIM','gaspar/tim':'Transmission d’information au maire'};
  const fields = {
    'mvt': [['Type', 'type'], ['Lieu', 'lieu'], ['Début', 'dateDebut'], ['Fiabilité', 'fiabilite'], ['Commentaire', 'commentaireMvt'], ['Mise à jour de la fiche', 'dateMaj']],
    'cavites': [['Nom', 'nom'], ['Type', 'type'], ['Repérage', 'reperageGeographique'], ['Mise à jour de la fiche', 'dateMaj']],
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
    const available = Number.isFinite(data?.total_elements);
    const value = key === 'radon' ? rows[0]?.classePotentiel : key === 'zonage_sismique' ? rows[0]?.zoneSismicite : data?.total_elements;
    const isClass = key === 'radon' || key === 'zonage_sismique';
    const tone = !available || (isClass && !value) ? 'unknown' : key === 'radon' ? ({1:'green',2:'amber',3:'orange'}[value] || 'teal') : key === 'zonage_sismique' ? ({1:'green',2:'teal',3:'amber',4:'orange',5:'red'}[value] || 'teal') : key === 'cavites' ? 'teal' : 'blue';
    const unit = key === 'radon' ? 'catégorie sur 3' : key === 'zonage_sismique' ? 'zone sur 5' : key === 'mvt' ? 'mouvements recensés' : key === 'cavites' ? 'cavités recensées' : 'éléments recensés';
    return `<section class="geo-data-section geo-tone-${tone}"><header><span class="geo-card-icon">${icon(key === 'radon' ? 'atom' : key === 'zonage_sismique' ? 'pulse' : key === 'mvt' ? 'mountain' : key === 'cavites' ? 'layers' : key === 'gaspar/azi' ? 'wave' : 'document')}</span><h4>${escape(titles[key] || data?.label || key)}</h4><span class="geo-status-dot" title="${escape(state(data))}" aria-label="${escape(state(data))}"></span></header>
      <div class="geo-card-value"><strong>${isClass ? escape(value || '—') : number(value)}</strong><span>${unit}</span></div>
      <p class="geo-card-description">${escape(descriptions[key] || 'Consultez les informations et documents recensés pour ce territoire.')}</p>
      <details class="geo-card-details"><summary>${available ? `Voir les détails${!isClass ? ` · ${number(data.total_elements)}` : ''}` : 'Disponibilité de la source'}<span aria-hidden="true">↗</span></summary><div class="geo-card-details-body">
      <span class="geo-state ${data?.status === 'stale' ? 'geo-stale' : ''}">${escape(state(data))}</span>
      <p class="muted">${escape(descriptions[key] || '')} ${data?.status === 'fallback' ? `Millésime : ${data.data_date ? date(data.data_date) : 'date de publication non précisée'}. Collecté le ${date(data.updated_at)}.` : data?.updated_at ? `Données du ${date(data.updated_at)}.` : ''}</p>
      ${data?.coverage_note ? `<p class="muted">${escape(data.coverage_note)}</p>` : ''}
      ${data?.source && /^https:\/\//.test(data.source) ? `<a href="${escape(data.source)}" target="_blank" rel="noopener noreferrer">Source de ces données ↗</a>` : ''}
      ${!rows.length ? `<p class="muted">${data?.total_elements === 0 ? 'Aucun élément retourné par la source pour ce périmètre.' : 'Aucune donnée disponible pour ce périmètre.'}</p>` : `<div class="geo-records">${rows.map((row, i) => {
        const pairs = fields[key] || [['Libellé', 'libelle'], ['Plan', 'libPpr'], ['Bassin de risques', 'libBassinRisques'], ['Modification', 'dateModification'], ['Transmission', 'dateTransmission']];
        const values = pairs.filter(([,field]) => row[field] !== undefined && row[field] !== null && row[field] !== '');
        const code = String(selected?.code_insee || '');
        const local = (row.communes || []).filter(c => !code || String(c.codeInsee) === code);
        const aleas = local.flatMap(c => c.aleas || []);
        const planState = local.find(c => c.etat);
        const planStateLabel = typeof planState?.etat === 'object' ? planState.etat.libelle : planState?.etat;
        const planStateDate = planState?.dateEtat || (typeof planState?.etat === 'object' ? planState.etat.date : null);
        return `<article class="geo-record" ${i >= 20 ? 'hidden data-geo-extra' : ''}><dl>${values.map(([label,field]) => `<div><dt>${escape(label)}</dt><dd>${escape(row[field])}</dd></div>`).join('')}${row.identifiant || row.idGaspar ? `<div><dt>Référence</dt><dd>${escape(row.identifiant || row.idGaspar)}</dd></div>` : ''}${planStateLabel ? `<div><dt>État pour cette commune</dt><dd>${escape(planStateLabel)}${planStateDate ? ` · ${date(planStateDate)}` : ''}</dd></div>` : ''}</dl>${aleas.length ? `<p>${escape([...new Set(aleas.map(a => a.libelle).filter(Boolean))].join(' · '))}</p>` : ''}</article>`;
      }).join('')}</div>${rows.length > 20 ? `<button type="button" class="ghost" data-geo-more>Afficher les ${rows.length - 20} autres éléments</button>` : ''}`}</div></details></section>`;
  }
  function matching(row) {
    const code = String(row.code_insee || row.codeInsee || '');
    return code ? code === String(selected?.code_insee || '') : normalize(row.commune || row.nom_commune) === normalize(selected?.name);
  }
  function documents(commune) {
    const safe = documentUrl;
    const rows = (commune.documents || []).filter(row => (row.scope === 'department' || String(row.code_insee) === String(commune.code_insee)) && safe(row.url));
    const dicrim = rows.filter(row => row.kind === 'DICRIM');
    const recorded = (commune.datasets?.['gaspar/dicrim']?.content || []).length > 0;
    return `<section class="geo-documents"><div class="geo-documents-heading"><div><p class="geo-eyebrow">À CONSULTER & À CONSERVER</p><h4>Les documents utiles</h4></div><span>${rows.length} lien(s) officiel(s)</span></div>
      ${!dicrim.length ? `<p class="geo-document-note">DICRIM : ${recorded ? 'recensé dans GASPAR, mais aucun lien PDF public n’a été vérifié pour cette commune.' : 'aucun lien public vérifié dans les sources collectées. Cela ne signifie pas que la commune n’en possède pas.'} Contactez la mairie pour obtenir sa version à jour.</p>` : '<p class="geo-document-note">Les éditions disponibles sont indiquées ci-dessous. Elles ne sont pas nécessairement les dernières versions applicables.</p>'}
      <div class="geo-document-grid">${rows.map(row => `<a class="geo-document-link" href="${escape(safe(row.url))}" target="_blank" rel="noopener noreferrer"><span class="geo-document-symbol">${icon('document')}</span><span class="geo-document-copy"><span class="geo-document-kind">${escape(row.kind)} <small>${row.format === 'pdf' ? 'PDF' : 'FICHE OFFICIELLE'}</small></span><strong>${escape(row.title)}</strong><span>${escape(row.publisher || '')}${row.year ? ` · Édition ${escape(row.year)}` : ''}</span>${row.state ? `<span>${escape(row.state)}${row.state_date ? ` · ${date(row.state_date)}` : ''}</span>` : ''}<span>${row.scope === 'department' ? 'Document départemental · Isère' : `Commune · ${escape(commune.name)}`}${row.verified_at ? ` · Lien contrôlé le ${date(row.verified_at)}` : ''}</span></span><span aria-hidden="true">↗</span></a>`).join('')}</div></section>`;
  }
  function localServices() {
    const catnat = snapshot.catnat_isere || {};
    const industrial = snapshot.industrial_sites || {};
    const events = (catnat.events || []).filter(matching);
    const sites = (industrial.sites || []).filter(matching);
    const coverage = (catnat.communes || []).find(c => String(c.code) === String(selected?.code_insee));
    return `<section class="geo-data-section geo-tone-blue"><header><span class="geo-card-icon">${icon('wave')}</span><h4>Catastrophes naturelles</h4></header><div class="geo-card-value"><strong>${coverage?.checked ? number(coverage.events_total) : '—'}</strong><span>reconnaissances historiques</span></div><p class="geo-card-description">Les événements reconnus dans la commune. Un historique administratif, sans alerte actuelle.</p><details class="geo-card-details"><summary>Explorer l’historique <span aria-hidden="true">↗</span></summary><div class="geo-card-details-body"><p class="muted">${events.length} élément(s) présent(s) dans l’aperçu disponible.</p>
      ${events.map(r => `<article class="geo-record"><strong>${escape(r.risk)}</strong><p>Événement : ${date(r.event_start)} au ${date(r.event_end)} · Publication : ${date(r.published_at)}</p></article>`).join('')}
      <button type="button" class="ghost" data-geo-history>Afficher l’historique communal complet collecté</button><div id="geo-full-history" aria-live="polite"></div>
      <a href="https://www.georisques.gouv.fr/donnees/bases-de-donnees/procedures-administratives-relatives-aux-risques" target="_blank" rel="noopener noreferrer">Consulter la source officielle CatNat ↗</a></div></details></section>
      <section class="geo-data-section geo-tone-teal"><header><span class="geo-card-icon">${icon('layers')}</span><h4>Installations industrielles</h4></header><div class="geo-card-value"><strong>${['online','fallback','stale'].includes(industrial.status) ? number(sites.length) : '—'}</strong><span>sites dans les données disponibles</span></div><p class="geo-card-description">Les établissements ICPE et leur classement Seveso. Le référentiel ne signale pas des incidents en cours.</p><details class="geo-card-details"><summary>Consulter les établissements <span aria-hidden="true">↗</span></summary><div class="geo-card-details-body"><p class="muted">${escape(state(industrial))} · Périmètre communal.</p>
      ${sites.length ? sites.map(r => `<article class="geo-record"><strong>${escape(r.nom || r.name)}</strong><p>${escape(r.seveso_label || 'Classement Seveso non renseigné')}</p></article>`).join('') : '<p>Aucun site dans les données disponibles pour cette commune.</p>'}
      <a href="https://www.georisques.gouv.fr/risques/installations/donnees" target="_blank" rel="noopener noreferrer">Consulter les installations officielles ↗</a></div></details></section>`;
  }
  function renderCommune(commune) {
    const signature = JSON.stringify([commune, tab, tab === 'history' ? snapshot.catnat_isere : null, tab === 'history' ? snapshot.industrial_sites : null]);
    const root = document.getElementById('georisques-pcs-detail');
    if (!root) return;
    if (signature === renderedSignature && root.childElementCount) return;
    renderedSignature = signature;
    ++historyVersion;
    selected = commune;
    if (!commune) { root.innerHTML = '<p>Choisissez une commune pour explorer ses données officielles par thème.</p>'; return; }
    const datasets = commune.datasets || {};
    const url = window.GeorisquesLinks.report(commune);
    const dicrim = (commune.documents || []).find(row => row.kind === 'DICRIM' && String(row.code_insee) === String(commune.code_insee) && documentUrl(row.url));
    const keys = tab === 'natural' ? ['radon','zonage_sismique','mvt','cavites'] : ['gaspar/risques','gaspar/pprn','gaspar/pprm','gaspar/pprt','gaspar/azi','gaspar/tri','gaspar/papi','gaspar/dicrim','gaspar/tim'].filter(key => !key.startsWith('gaspar/ppr') || datasets[key]);
    root.innerHTML = `<div class="geo-commune-heading"><div class="geo-commune-title"><span class="geo-location-icon">${icon('pin')}</span><div><p class="geo-eyebrow">LE PROFIL DE VOTRE COMMUNE</p><h3>${escape(commune.name)}</h3><p class="geo-commune-code">Isère <span>·</span> Code INSEE ${escape(commune.code_insee || 'non renseigné')}</p></div></div><div class="geo-commune-actions"><a class="geo-report-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${icon('document')} Rapport officiel <span>↗</span></a>${dicrim ? `<a class="geo-report-link geo-dicrim-link" href="${escape(dicrim.url)}" target="_blank" rel="noopener noreferrer">DICRIM · PDF <span>↗</span></a>` : ''}</div></div>
      <div class="geo-tabs" role="group" aria-label="Thèmes Géorisques">${[['natural','Risques naturels'],['prevention','Prévention & documents'],['history','CatNat & industrie']].map(([key,label])=>`<button type="button" data-geo-tab="${key}" aria-pressed="${tab===key}">${label}</button>`).join('')}</div>
      <p class="geo-tab-description">${tab === 'natural' ? 'Les repères naturels de la commune. Les couleurs du radon et de la sismicité correspondent aux classes publiées ; les inventaires ne mesurent pas le danger actuel.' : tab === 'prevention' ? 'Les risques connus et les documents pour préparer votre territoire.' : 'Les reconnaissances passées et les installations présentes sur le territoire.'}</p>
      ${tab === 'prevention' ? documents(commune) : ''}
      <div class="geo-datasets">${tab === 'history' ? localServices() : keys.map(key => records(key, datasets[key] || {label:titles[key] || key})).join('')}</div>`;
  }
  function update(data, external, api) {
    snapshot = external || {};
    request = api;
    let root = document.getElementById('georisques-rich-overview');
    if (!root) return;
    const signature = JSON.stringify(data);
    if (signature === overviewSignature && root.childElementCount) return;
    overviewSignature = signature;
    const sets = data.datasets || {};
    const available = Object.values(sets).filter(d => ['online','fallback'].includes(d.status)).length;
    document.getElementById('georisques-page-source').textContent = `Géorisques · BRGM · ASNR · DDT ${data.updated_at ? ` / Collecte du ${String(data.updated_at).slice(0,10)}` : ''}`;
    root.innerHTML = `<div class="geo-overview-heading"><p class="geo-eyebrow">VUE D’ENSEMBLE</p><span>Périmètre des communes suivies</span></div><div class="geo-summary"><article class="tile">${icon('pin')}<div><p>Communes suivies</p><strong>${number(data.monitored_communes?.length)}</strong></div></article><article class="tile">${icon('grid')}<div><p>Thèmes disponibles</p><strong>${available} <small>/ ${Object.keys(sets).length || 12}</small></strong></div></article>${[['Mouvements recensés','ground_movements_total','mountain'],['Cavités recensées','cavities_total','layers'],['Plans de prévention','ppr_total','document'],['Atlas inondation','flood_documents_total','wave']].map(([label,key,symbol])=>`<article class="tile">${icon(symbol)}<div><p>${label}</p><strong>${number(data[key])}</strong></div></article>`).join('')}</div>`;
    const diagnostics = document.getElementById('geo-diagnostics');
    if (diagnostics) diagnostics.innerHTML = `<details class="geo-reliability"><summary><span>${icon('layers')} Sources & fiabilité des données</span><span>${available} / ${Object.keys(sets).length || 12} thèmes disponibles <span aria-hidden="true">⌄</span></span></summary><div class="geo-reliability-body">
      <p class="muted">Les chiffres portent sur les communes suivies, pas sur tout le département. Un inventaire historique ne constitue pas une alerte en temps réel. « — » signifie donnée indisponible.${Object.values(sets).some(d => d.status === 'stale') ? ' Certains chiffres proviennent des dernières données connues : consulter les dates dans les détails.' : ''}</p>
      ${data.recovered_sources?.length ? '<p class="geo-api-details">Mode secours actif : les données disponibles ci-dessous proviennent des référentiels officiels GASPAR, ASNR et DDT de l’Isère. Le millésime et la source figurent dans chaque fiche.</p>' : ''}
      ${data.errors?.length ? `<details class="geo-api-details"><summary>${data.errors.length} source(s) encore indisponible(s) · consulter le diagnostic</summary><ul>${data.errors.map(e=>`<li>${escape(e)}</li>`).join('')}</ul></details>` : ''}
      ${data.api_errors?.length ? `<details class="geo-api-details"><summary>Diagnostic des appels API Géorisques</summary><ul>${[...new Set(data.api_errors.map(e=>String(e).split(' : ').slice(1).join(' : ')))].map(e=>`<li>${escape(e)}</li>`).join('')}</ul></details>` : ''}
      <details class="geo-api-details"><summary>Plans de prévention · périmètre des communes suivies</summary><p class="muted">Liste commune aux communes suivies. Les communes sont précisées dans les fiches lorsque le référentiel les fournit.</p><div class="geo-datasets">${['pprn','pprm','pprt'].map(key=>records('gaspar/'+key, sets['gaspar/'+key] || {label:key.toUpperCase()})).join('')}</div></details></div></details><p class="geo-page-note">Données officielles · Inventaires et zonages réglementaires · Les historiques ne sont pas des alertes en cours.</p>`;
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
