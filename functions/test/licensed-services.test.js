'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const stamp = millis => ({ toMillis: () => millis });

function fixture() {
  const now = Date.now(), uid = 'synthetic-licensed-user';
  const profile = { accountStatus: 'active', role: 'processor', organizationId: 'synthetic-org',
    license: { type: 'individual', status: 'active', paymentStatus: 'verified', expiresAt: stamp(now + 3600000) } };
  const documents = new Map([
    [`users/${uid}`, profile],
    ['appConfig/production', { minimumSupportedVersion: '1.12.0', maintenanceMode: false }],
    ['organizations/synthetic-org', { status: 'active' }],
    ['licences/synthetic-org', { status: 'active', expiryDate: stamp(now + 3600000) }],
    ['processingRuleState/active', { versionId: 'synthetic-rules', schemaVersion: 2, checksum: 'synthetic-checksum' }],
    ['processingRuleSets/synthetic-rules', { schemaVersion: 2, checksum: 'synthetic-checksum', rules: [{ ruleId: 'SYN-ONLY' }] }]
  ]);
  const logs = [], tokenChecks = [], writes = [];
  const reference = key => ({ key, get: async () => ({ exists: documents.has(key), data: () => documents.get(key) }),
    create: async value => { writes.push({ key, value }); documents.set(key, value); } });
  const db = { doc: reference,
    collection: name => ({ doc: () => reference(`${name}/synthetic-entry`), add: async value => { writes.push({ key: name, value }); } }),
    runTransaction: async work => work({ get: ref => ref.get(),
      set: (ref, value) => documents.set(ref.key, value),
      update: (ref, value) => documents.set(ref.key, { ...documents.get(ref.key), ...value }) }) };
  const token = { uid, email_verified: true, role: 'processor', exp: Math.floor((now + 3600000) / 1000) };
  let tokenError = null;
  class HttpsError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }
  const auth = { verifyIdToken: async (value, checkRevoked) => {
    tokenChecks.push({ value, checkRevoked });
    if (tokenError) throw Object.assign(new Error('Synthetic token rejection'), { code: tokenError });
    if (value !== 'synthetic-private-token') throw Object.assign(new Error('Invalid synthetic token'), { code: 'auth/invalid-id-token' });
    return token;
  } };
  const exports = {};
  vm.runInNewContext(source, { exports, process: { env: { GCLOUD_PROJECT: 'demo-claimextension' } }, console,
    require(name) {
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/auth') return { getAuth: () => auth };
      if (name === 'firebase-admin/firestore') return { getFirestore: () => db,
        FieldValue: { serverTimestamp: () => stamp(now) }, Timestamp: { fromMillis: stamp } };
      if (name === 'firebase-functions/v2/https') return { HttpsError,
        onCall: (options, handler) => handler, onRequest: (options, handler) => handler };
      if (name === 'firebase-functions') return { logger: { warn: (...values) => logs.push(values) } };
      return require(name.startsWith('./') ? path.join(__dirname, '..', name) : name);
    }
  });
  return { now, uid, profile, documents, logs, tokenChecks, writes, token,
    rejectToken: code => { tokenError = code; },
    call(name, data, { signedIn = true, bearer = 'synthetic-private-token' } = {}) {
      return exports[name]({ auth: signedIn ? { uid, token: { ...token } } : null, data,
        rawRequest: { headers: signedIn ? { authorization: `Bearer ${bearer}` } : {} } });
    } };
}

const ruleRequest = { extensionVersion: '1.12.1', supportedRuleSchemaVersions: [2] };

test('licensed rule access checks the current server session and returns no client-derived authority', async () => {
  const f = fixture();
  assert.equal((await f.call('getActiveProcessingRules', ruleRequest)).rules[0].ruleId, 'SYN-ONLY');
  assert(f.tokenChecks.length > 0);
  assert(f.tokenChecks.every(check => check.checkRevoked === true));
  await assert.rejects(f.call('getActiveProcessingRules', ruleRequest, { signedIn: false }), { code: 'unauthenticated' });
  await assert.rejects(f.call('getActiveProcessingRules', { ...ruleRequest, applyAllowed: true }), { code: 'invalid-argument' });
});

const denials = {
  'missing licence': f => { delete f.profile.license; },
  'inactive licence': f => { f.profile.license.status = 'inactive'; },
  'expired licence': f => { f.profile.license.expiresAt = stamp(f.now - 1000); },
  'missing expiry': f => { delete f.profile.license.expiresAt; },
  'unpaid licence': f => { f.profile.license.paymentStatus = 'not_required'; },
  'suspended account': f => { f.profile.accountStatus = 'suspended'; },
  'missing profile': f => { f.documents.delete(`users/${f.uid}`); },
  'missing organization': f => { f.profile.license.type = 'organisation'; f.documents.delete('organizations/synthetic-org'); },
  'suspended organization': f => { f.profile.license.type = 'organisation'; f.documents.get('organizations/synthetic-org').status = 'suspended'; },
  'missing organization licence': f => { f.profile.license.type = 'organisation'; f.documents.delete('licences/synthetic-org'); },
  'suspended organization licence': f => { f.profile.license.type = 'organisation'; f.documents.get('licences/synthetic-org').status = 'suspended'; },
  'expired organization licence': f => { f.profile.license.type = 'organisation'; f.documents.get('licences/synthetic-org').expiryDate = stamp(f.now - 1000); }
};
for (const [name, revoke] of Object.entries(denials)) {
  test(`protected rules reject ${name}, including the unchanged-version path`, async () => {
    const f = fixture(); revoke(f);
    for (const request of [ruleRequest, { ...ruleRequest, knownVersionId: 'synthetic-rules' }]) {
      await assert.rejects(f.call('getActiveProcessingRules', request), { code: 'permission-denied' });
    }
  });
}

test('minimum version and maintenance are enforced at the rule service itself', async () => {
  const f = fixture();
  await assert.rejects(f.call('getActiveProcessingRules', { ...ruleRequest, extensionVersion: '1.0.0' }), { code: 'failed-precondition' });
  f.documents.get('appConfig/production').maintenanceMode = true;
  await assert.rejects(f.call('getActiveProcessingRules', { ...ruleRequest, knownVersionId: 'synthetic-rules' }), { code: 'failed-precondition' });
});

test('a revoked licence denies an existing token even if the client claims a newer version', async () => {
  const f = fixture();
  await f.call('getActiveProcessingRules', ruleRequest);
  f.profile.license.status = 'inactive';
  await assert.rejects(f.call('getActiveProcessingRules', { ...ruleRequest, extensionVersion: '999.0.0' }), { code: 'permission-denied' });
});

for (const code of ['auth/id-token-revoked', 'auth/id-token-expired', 'auth/user-disabled', 'auth/user-not-found']) {
  test(`authenticated services reject ${code} before returning config or rules`, async () => {
    const f = fixture(); f.rejectToken(code);
    await assert.rejects(f.call('getExtensionConfig', {}), { code: 'unauthenticated' });
    await assert.rejects(f.call('verifyLicence', { extensionVersion: '1.12.1' }), { code: 'unauthenticated' });
    await assert.rejects(f.call('getActiveProcessingRules', ruleRequest), { code: 'unauthenticated' });
  });
}

test('forged bearer tokens and Auth outages fail closed without logging tokens', async () => {
  const f = fixture();
  await assert.rejects(f.call('getActiveProcessingRules', ruleRequest, { bearer: 'synthetic-forged-secret' }), { code: 'unauthenticated' });
  f.rejectToken('auth/internal-error');
  await assert.rejects(f.call('getActiveProcessingRules', ruleRequest), { code: 'unavailable' });
  assert(f.logs.length > 0);
  assert(!JSON.stringify(f.logs).includes('synthetic-forged-secret'));
  assert(!JSON.stringify(f.logs).includes('synthetic-private-token'));
});

test('organization renewal stays authoritative over an old member expiry', async () => {
  const f = fixture(); f.profile.license.type = 'organisation'; f.profile.license.expiresAt = stamp(f.now - 1000);
  assert.equal((await f.call('getActiveProcessingRules', ruleRequest)).rules.length, 1);
});

test('licence display authority expires within five minutes, the paid term and the ID token', async () => {
  const f = fixture();
  const decision = await f.call('verifyLicence', { extensionVersion: '1.12.1' });
  assert(Date.parse(decision.authorizationExpiresAt) <= Date.parse(decision.serverTime) + 300000);
  f.token.exp = Math.floor((Date.now() + 20000) / 1000);
  assert(Date.parse((await f.call('verifyLicence', { extensionVersion: '1.12.1' })).authorizationExpiresAt) <= f.token.exp * 1000);
  f.profile.license.expiresAt = stamp(Date.now() + 10000);
  assert(Date.parse((await f.call('verifyLicence', { extensionVersion: '1.12.1' })).authorizationExpiresAt) <= f.profile.license.expiresAt.toMillis());
});

test('feedback uses the same current entitlement and minimum-version gate before any write', async () => {
  const f = fixture();
  const data = { extensionVersion: '1.12.1', ruleId: 'SYN-ONLY', ruleSetVersion: 'synthetic-rules',
    category: 'incorrect_deduction', processingArea: 'IPD', packageCodes: ['SYN-PACKAGE'] };
  await f.call('submitProcessingRuleFeedback', data);
  const written = f.writes.length;
  await assert.rejects(f.call('submitProcessingRuleFeedback', { ...data, extensionVersion: '1.0.0' }), { code: 'failed-precondition' });
  f.profile.license.status = 'inactive';
  await assert.rejects(f.call('submitProcessingRuleFeedback', data), { code: 'permission-denied' });
  assert.equal(f.writes.length, written);
});

test('an Auth identity mismatch cannot use another profile entitlement', async () => {
  const f = fixture(); f.token.uid = 'another-synthetic-user';
  await assert.rejects(f.call('getActiveProcessingRules', ruleRequest), { code: 'unauthenticated' });
});

test('server request quotas remain enforced before protected rule delivery', async () => {
  const f = fixture();
  f.documents.set(`rateLimits/${f.uid}_processingRules`, { count: 240, windowStartedAt: stamp(Date.now()) });
  await assert.rejects(f.call('getActiveProcessingRules', ruleRequest), { code: 'resource-exhausted' });
});
