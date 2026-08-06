const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Firebase Hosting serves the public site and authenticated administrator dashboard', () => {
  const firebase = JSON.parse(read('firebase.json'));
  assert.equal(firebase.hosting.public, 'hosting-build');
  for (const file of [
    'hosting/index.html',
    'hosting/admin.html',
    'hosting/privacy.html',
    'hosting/support.html',
    'hosting/terms.html',
    'hosting/deletion.html',
    'hosting/styles.css',
    'hosting/firebase-client.js',
    'hosting/admin.js'
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must exist`);
  }
});

test('hosted dashboard exposes the complete Phase 4 administration lifecycle', () => {
  const html = read('hosting/admin.html');
  const source = read('hosting/admin.js');
  for (const panel of ['users', 'invitations', 'organizations', 'licences', 'audit']) {
    assert.match(html, new RegExp(`data-panel="${panel}"`));
  }
  for (const callable of [
    'getCurrentUserProfile',
    'listUsers',
    'activateUser',
    'rejectUserRegistration',
    'suspendUser',
    'changeUserRole',
    'deleteUserAccount',
    'listInvitations',
    'inviteUser',
    'revokeInvitation',
    'replaceInvitation',
    'listOrganizations',
    'createOrganization',
    'updateOrganization',
    'activateLicence',
    'suspendLicence',
    'listAuditEvents'
  ]) {
    assert.match(source, new RegExp(`['"]${callable}['"]`));
  }
  assert.match(source, /result\.role !== 'platformAdmin'/);
  assert.match(source, /result\.accountStatus !== 'active'/);
  assert.match(html, /id="pendingUsersList"/);
  assert.match(html, /id="pendingCount"/);
  assert.match(source, /Registration approved\./);
  assert.match(source, /Registration rejected\./);
});

test('hosted dashboard keeps authentication session-only and renders untrusted data without HTML injection', () => {
  const client = read('hosting/firebase-client.js');
  const dashboard = read('hosting/admin.js');
  assert.match(client, /sessionStorage\.setItem/);
  assert.match(client, /sessionStorage\.removeItem/);
  assert.doesNotMatch(client, /localStorage/);
  assert.doesNotMatch(client, /password.*setItem|setItem.*password/i);
  assert.doesNotMatch(dashboard, /\.innerHTML\s*=/);
  assert.match(dashboard, /node\.textContent = text/);
  assert.match(dashboard, /finally\s*{[\s\S]*byId\('password'\)\.value = ''/);
  assert.match(dashboard, /control\.dataset\.armed !== 'true'/);
});

test('hosting security headers deny framing, remote scripts, sensitive browser capabilities and caching', () => {
  const firebase = JSON.parse(read('firebase.json'));
  const globalRule = firebase.hosting.headers.find(rule => rule.source === '**');
  assert.ok(globalRule, 'all hosted routes must receive the security headers');
  assert.equal(firebase.hosting.headers.length, 1, 'clean URLs must not bypass a file-extension-specific cache rule');
  const headers = globalRule.headers;
  const values = Object.fromEntries(headers.map(header => [header.key, header.value]));
  assert.match(values['Content-Security-Policy'], /script-src 'self'/);
  assert.doesNotMatch(values['Content-Security-Policy'], /'unsafe-inline'|'unsafe-eval'/);
  assert.match(values['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(values['X-Frame-Options'], 'DENY');
  assert.equal(values['X-Content-Type-Options'], 'nosniff');
  assert.match(values['Permissions-Policy'], /camera=\(\)/);
  assert.equal(values['Cache-Control'], 'no-store');
});

test('hosted Firebase client is pinned to the isolated production project', () => {
  const client = read('hosting/firebase-client.js');
  assert.match(client, /__FIREBASE_API_KEY__/);
  assert.match(client, /__FUNCTIONS_BASE_URL__/);
  assert.doesNotMatch(client, /AIza[0-9A-Za-z_-]{30,}/);
});
