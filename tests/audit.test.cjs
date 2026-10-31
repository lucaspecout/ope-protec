const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/script.js', 'utf8');
const start = source.indexOf('const auditState =');
const end = source.indexOf('(function initAuditPanel()', start);
function setup() {
  const elements = Object.fromEntries(['audit-list', 'audit-summary', 'audit-details'].map(id => [id, { innerHTML: '', classList: { add() {}, remove() {} } }]));
  const context = vm.createContext({ document: { getElementById: id => elements[id] },
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    roleLabel: role => role === 'ope' ? 'Opérateur' : role });
  vm.runInContext(source.slice(start, end), context);
  return { context, elements };
}
test('audit renders meaningful actions, actor snapshot and structured context safely', () => {
  new vm.Script(source);
  const { context, elements } = setup();
  const row = {id: 1, username: 'operator', user_role: 'ope', user_id: 12, user_municipality: 'Grenoble',
    identity_verified: true, auth_source: 'local', resource_type: 'events', action_label: 'Modification',
    method: 'PATCH', path: '/events/42', status_code: 200, outcome: 'Réussite', created_at: '2026-10-31T12:00:00Z',
    target: {event_id: '42'}, context: {title: '<script>bad()</script>'}, duration_ms: 23, user_agent: 'Test browser'};
  context.renderAuditLog([row], 1);
  context.renderAuditDetails(row);
  assert.match(elements['audit-list'].innerHTML, /Modification/);
  assert.match(elements['audit-list'].innerHTML, /Réussite \(200\)/);
  assert.match(elements['audit-details'].innerHTML, /Identité vérifiée/);
  assert.match(elements['audit-details'].innerHTML, /ID événement : 42/);
  assert.match(elements['audit-details'].innerHTML, /23 ms/);
  assert.match(elements['audit-details'].innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(elements['audit-details'].innerHTML, /<script>/);
});
test('anonymous is labelled clearly and excluded from user count', () => {
  const { context, elements } = setup();
  context.renderAuditLog([{id: 1, username: 'anonymous', status_code: 401}], 1);
  assert.match(elements['audit-list'].innerHTML, /Non authentifié/);
  assert.match(elements['audit-summary'].innerHTML, /0 utilisateur/);
});
test('failed login distinguishes claimed identity from verified identity', () => {
  const { context, elements } = setup();
  context.renderAuditDetails({ username: 'operator', path: '/auth/login', status_code: 401, reason: 'Mot de passe incorrect' });
  assert.match(elements['audit-details'].innerHTML, /Identifiant saisi, connexion refusée/);
  assert.match(elements['audit-details'].innerHTML, /Mot de passe incorrect/);
});
