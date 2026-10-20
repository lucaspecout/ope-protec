/* Administrator credentials: secrets are submitted once and never stored in browser storage. */
(function () {
  'use strict';
  const state = { api: null, isAdmin: () => false, generation: 0, services: [], loading: false, loaded: false, pending: 0 };
  const el = (id) => document.getElementById(id);
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const allowed = () => Boolean(state.api && state.isAdmin());
  const active = (generation) => generation === state.generation && allowed();
  const visible = (node, show) => {
    if (!node) return;
    node.hidden = !show;
    node.classList.toggle('hidden', !show);
  };
  const genericError = (error) => {
    if ([401, 403].includes(error?.status)) return 'Vous devez être administrateur pour gérer ces accès.';
    if (error?.status === 429) return 'Trop de tests rapprochés. Réessayez dans un instant.';
    if (error?.status === 422) return 'Vérifiez les champs saisis et réessayez.';
    if (error?.status === 503) return 'La configuration des accès est indisponible. Vérifiez le serveur, la base et la clé de chiffrement persistante.';
    return 'La demande n’a pas abouti. Vérifiez la connexion au serveur puis réessayez.';
  };
  const publicMessage = (message, values) => {
    let text = String(message || '');
    Object.values(values).filter(Boolean).forEach((value) => { text = text.split(value).join('[masqué]'); });
    return text;
  };
  const sourceLabel = (field) => {
    if (!field.configured) return 'Non renseigné';
    return field.source === 'application' ? 'Enregistré dans l’application' : 'Fourni par la configuration serveur';
  };

  function configure({ api, isAdmin }) {
    reset();
    state.api = api;
    state.isAdmin = isAdmin;
    el('api-credentials-reload')?.addEventListener('click', () => load(true));
  }

  function reset() {
    state.generation += 1;
    state.services = [];
    state.loading = false;
    state.loaded = false;
    state.pending = 0;
    el('api-credentials-list')?.querySelectorAll('input').forEach((input) => { input.value = ''; });
    el('api-credentials-list')?.replaceChildren();
    if (el('api-credentials-status')) el('api-credentials-status').textContent = '';
    if (el('api-credentials-reload')) el('api-credentials-reload').disabled = false;
    visible(el('api-credentials'), false);
  }

  function activate(panelId) {
    if (!allowed()) { reset(); return; }
    if (panelId !== 'api-panel') return;
    visible(el('api-credentials'), true);
    if (!state.loaded) load();
  }

  async function load(force = false) {
    if (!allowed() || state.loading || state.pending || (state.loaded && !force)) return;
    const generation = state.generation;
    state.loading = true;
    const status = el('api-credentials-status');
    const reload = el('api-credentials-reload');
    if (status) status.textContent = 'Chargement de la configuration des accès…';
    if (reload) reload.disabled = true;
    try {
      const payload = await state.api('/api/admin/integrations', { bypassCache: true, maxRetries: 0 });
      if (!active(generation)) return;
      state.services = Array.isArray(payload.services) ? payload.services : [];
      state.loaded = true;
      el('api-credentials-list')?.replaceChildren(...state.services.map(renderService));
      if (status) status.textContent = 'Les valeurs déjà enregistrées ne sont jamais affichées. Un champ vide conserve l’accès actuel.';
    } catch (error) {
      if (active(generation) && status) status.textContent = genericError(error);
    } finally {
      if (active(generation)) {
        state.loading = false;
        if (reload) reload.disabled = state.pending > 0;
      }
    }
  }

  function renderService(service) {
    const card = create('article', 'api-credential-card');
    card.dataset.integration = service.id;
    const head = create('div', 'api-credential-head');
    head.append(create('h5', '', service.label), create('span', `api-credential-badge${service.configured ? ' configured' : ''}`, service.configured ? 'Accès renseigné' : 'À configurer'));
    card.append(head, create('p', 'muted', service.description || ''));
    try {
      const url = new URL(service.help_url);
      if (url.protocol === 'https:') {
        const help = create('a', 'api-credential-help', 'Obtenir un accès auprès du fournisseur ↗');
        help.href = url.href;
        help.target = '_blank';
        help.rel = 'noopener noreferrer';
        card.append(help);
      }
    } catch (_) { /* Providers without public registration have no link. */ }
    const form = create('form', 'api-credential-form');
    form.autocomplete = 'off';
    const inputs = [];
    const clears = [];
    (Array.isArray(service.fields) ? service.fields : []).forEach((field) => {
      const row = create('div', 'api-credential-field');
      const inputId = `api-access-${service.id}-${field.id}`;
      const label = create('label', '', field.label);
      label.htmlFor = inputId;
      const input = create('input');
      input.id = inputId;
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'none');
      input.maxLength = 8192;
      input.placeholder = field.configured ? 'Laisser vide pour conserver la valeur actuelle' : 'Saisir une clé ou un jeton';
      const hint = create('small', 'muted', sourceLabel(field));
      hint.id = `${inputId}-status`;
      input.setAttribute('aria-describedby', hint.id);
      row.append(label, input, hint);
      inputs.push({ id: field.id, input });
      if (field.source === 'application') {
        const clearLabel = create('label', 'api-credential-clear');
        const checkbox = create('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
          input.disabled = checkbox.checked;
          if (checkbox.checked) input.value = '';
        });
        clearLabel.append(checkbox, create('span', '', 'Effacer la valeur enregistrée et reprendre la configuration serveur'));
        row.append(clearLabel);
        clears.push({ id: field.id, checkbox, input });
      }
      form.append(row);
    });
    const actions = create('div', 'api-credential-actions');
    const save = create('button', '', 'Enregistrer les accès');
    save.type = 'submit';
    const test = create('button', 'ghost', 'Tester la connexion');
    test.type = 'button';
    actions.append(save, test);
    const feedback = create('div', 'api-credential-feedback');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    form.append(actions, create('p', 'api-credential-note muted', 'Le test utilise la saisie sans l’enregistrer. Les champs vides utilisent les accès actuels.'), feedback);
    card.append(form);
    let busy = false;
    const body = () => ({ values: Object.fromEntries(inputs.filter(({ input }) => !input.disabled && input.value.trim()).map(({ id, input }) => [id, input.value.trim()])), clear_fields: clears.filter(({ checkbox }) => checkbox.checked).map(({ id }) => id) });
    const setBusy = (value) => {
      if (busy !== value) state.pending += value ? 1 : -1;
      busy = value;
      if (el('api-credentials-reload')) el('api-credentials-reload').disabled = state.loading || state.pending > 0;
      save.disabled = value;
      test.disabled = value;
      inputs.forEach(({ input }) => { input.disabled = value; });
      clears.forEach(({ checkbox, input }) => { checkbox.disabled = value; if (!value) input.disabled = checkbox.checked; });
      form.setAttribute('aria-busy', String(value));
    };
    async function run(operation) {
      if (!allowed() || busy || state.loading) return;
      const draft = body();
      const generation = state.generation;
      if (operation === 'save' && !Object.keys(draft.values).length && !draft.clear_fields.length) {
        feedback.replaceChildren(create('p', '', 'Renseignez une nouvelle valeur ou cochez un accès à effacer.'));
        return;
      }
      setBusy(true);
      feedback.className = 'api-credential-feedback';
      feedback.replaceChildren(create('p', '', operation === 'test' ? 'Test de connexion auprès du fournisseur…' : 'Enregistrement en cours…'));
      try {
        const result = await state.api(`/api/admin/integrations/${encodeURIComponent(service.id)}${operation === 'test' ? '/test' : ''}`, {
          method: operation === 'test' ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
          maxRetries: 0,
          timeoutMs: 30000,
        });
        if (!active(generation)) return;
        if (operation === 'save') {
          inputs.forEach(({ input }) => { input.value = ''; });
          const updated = result?.service || result;
          if (updated?.id === service.id && Array.isArray(updated.fields)) {
            const replacement = renderService(updated);
            const resultMessage = replacement.querySelector('.api-credential-feedback');
            const savedMessage = service.id === 'tomtom'
              ? 'Accès enregistrés. Ils seront utilisés pour les prochains calculs d’itinéraire. Utilisez le test pour vérifier la connexion.'
              : 'Accès enregistrés. Les collectes concernées sont relancées en arrière-plan. Utilisez le test pour vérifier la connexion.';
            resultMessage?.append(create('p', 'api-credential-success', savedMessage));
            card.replaceWith(replacement);
            state.services = state.services.map((item) => item.id === service.id ? updated : item);
          } else {
            feedback.replaceChildren(create('p', 'api-credential-success', 'Accès enregistrés. Actualisez la configuration pour voir leur état.'));
          }
        } else {
          feedback.className = `api-credential-feedback ${result.ok ? 'api-credential-success' : 'api-credential-error'}`;
          feedback.replaceChildren(create('p', '', publicMessage(result.message || (result.ok ? 'Connexion réussie.' : 'Connexion impossible.'), draft.values)));
          if (Array.isArray(result.checks)) {
            const checks = create('ul', 'api-credential-checks');
            result.checks.forEach((check) => checks.append(create('li', check.ok ? 'api-credential-success' : 'api-credential-error', publicMessage(`${check.label || check.id} : ${check.message || (check.ok ? 'connexion réussie' : 'connexion impossible')}`, draft.values))));
            feedback.append(checks);
          }
          if (Number.isFinite(result.duration_ms)) feedback.append(create('small', '', `Test effectué en ${(result.duration_ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s. La saisie reste à enregistrer si elle a été modifiée.`));
        }
      } catch (error) {
        if (active(generation)) {
          feedback.className = 'api-credential-feedback api-credential-error';
          feedback.replaceChildren(create('p', '', genericError(error)));
        }
      } finally {
        if (active(generation)) setBusy(false);
      }
    }
    form.addEventListener('submit', (event) => { event.preventDefault(); run('save'); });
    test.addEventListener('click', () => run('test'));
    return card;
  }

  window.ApiCredentials = { configure, activate, reset };
})();
