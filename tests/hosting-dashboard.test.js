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
  for (const panel of ['users', 'invitations', 'organizations', 'roster', 'licences', 'audit']) {
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
    'listRoster',
    'addRosterEntry',
    'bulkAddRosterEntries',
    'removeRosterEntry',
    'activateLicence',
    'suspendLicence',
    'setUserLicense',
    'verifyUserPayment',
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
  assert.match(source, /license-activate/);
  assert.match(source, /license-extend/);
  assert.match(source, /license-deactivate/);
  assert.match(source, /\[1, 2, 4, 12\]/);
  assert.match(html, /id="pendingPaymentsList"/);
  assert.match(source, /payment-verify/);
  assert.match(source, /payment-decline/);
  assert.match(html, /id="bulkRosterForm"/);
  assert.match(html, /id="expiringUsersList"/);
  assert.match(source, /Expiring|expiry warnings|warningEnd/i);
});

test('paid access disclosures cover UPI references without collecting credentials', () => {
  const privacy = read('hosting/privacy.html');
  const terms = read('hosting/terms.html');
  const store = read('STORE_LISTING.md');
  assert.match(privacy, /UPI transaction ID \(UTR\)/);
  assert.match(privacy, /does not request or store UPI PINs, OTPs, card numbers, passwords or bank-account credentials/);
  assert.match(terms, /exact plan amount/);
  assert.match(terms, /₹99 for 1 week/);
  assert.match(terms, /within 3 calendar days/);
  assert.match(terms, /7073684173/);
  assert.match(terms, /refund, reversal or payment dispute/i);
  assert.match(store, /paid features|in-app purchases/);
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
  assert.match(client, /__AUTH_BASE_URL__/);
  assert.match(client, /__TOKEN_BASE_URL__/);
  assert.match(client, /__FUNCTIONS_BASE_URL__/);
  assert.doesNotMatch(client, /AIza[0-9A-Za-z_-]{30,}/);
});

test('local emulator config binds services to loopback and permits only local backend connections', () => {
  const config = JSON.parse(read('firebase.emulator.json'));
  for (const service of ['auth', 'functions', 'firestore', 'hosting']) {
    assert.equal(config.emulators[service].host, '127.0.0.1');
  }
  const policy = config.hosting.headers[0].headers
    .find(header => header.key === 'Content-Security-Policy').value;
  assert.match(policy, /http:\/\/127\.0\.0\.1:5001/);
  assert.match(policy, /http:\/\/127\.0\.0\.1:9099/);
  assert.doesNotMatch(policy, /cloudfunctions\.net|identitytoolkit\.googleapis\.com/);
});

test('automated licence lifecycle acceptance stays on isolated emulators', () => {
  const packageJson = JSON.parse(read('package.json'));
  const source = read('scripts/license-lifecycle-acceptance.js');
  const runner = read('scripts/run-lifecycle-emulators.js');
  assert.match(packageJson.scripts['test:lifecycle'], /run-lifecycle-emulators/);
  assert.match(runner, /'auth,functions,firestore'/);
  assert.match(runner, /demo-claimextension/);
  assert.match(runner, /nodeMajor\(candidate\) === 22/);
  assert.match(source, /FIREBASE_AUTH_EMULATOR_HOST = '127\.0\.0\.1:9099'/);
  assert.match(source, /FIRESTORE_EMULATOR_HOST = '127\.0\.0\.1:8080'/);
  assert.match(source, /testSponsoredLifecycle/);
  assert.match(source, /testIndividualLifecycle/);
  assert.match(source, /ACCEPTANCE-UPI-UTR-0001/);
});
