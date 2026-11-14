'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(overrides = {}) {
  const data = { authSession: { uid: 'SYN-A', idToken: 'SYN-A', refreshToken: 'SYN-REFRESH',
    expiresAt: Date.now() + 3600000 }, licenceState: { status: 'active', applyAllowed: true }, ruleOverridesMigratedToLocal: true };
  const storage = { get: (keys, cb) => cb(Object.fromEntries(keys.map(key => [key, data[key]]))),
    set: (value, cb) => { Object.assign(data, value); cb(); }, remove: (key, cb) => { delete data[key]; cb(); } };
  let listener;
  const AuthCore = {
    isTokenFresh: session => session.expiresAt > Date.now(),
    signInWithPassword: async () => ({ uid: 'SYN-B', idToken: 'SYN-B', refreshToken: 'SYN-B-REFRESH',
      email: 'synthetic@example.invalid', expiresAt: Date.now() + 3600000 }),
    callFunction: async ({ name, idToken }) => name === 'getCurrentUserProfile'
      ? { accountStatus: 'active', role: 'processor', organizationId: 'SYN-ORG' }
      : name === 'getActiveProcessingRules' ? { schemaVersion: 2, mode: 'bundled', versionId: '', unchanged: true }
        : { status: 'active', applyAllowed: true, previewAllowed: true, actor: idToken },
    ...overrides
  };
  const context = vm.createContext({ ClaimAuthCore: AuthCore, ClaimProcessingRules: require('../processing-rules'),
    chrome: { storage: { local: storage, sync: storage }, runtime: { onMessage: { addListener: fn => { listener = fn; } },
      getManifest: () => ({ version: '1.12.0' }) }, alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } } },
    fetch: () => {}, console });
  vm.runInContext(source, context);
  const dispatch = request => new Promise(resolve => listener(request, {}, resolve));
  return { data, dispatch, AuthCore };
}

test('a delayed licence verification cannot restore entitlement after sign-out', async () => {
  const started = deferred(), response = deferred();
  const f = setup({ callFunction: () => { started.resolve(); return response.promise; } });
  const checking = f.dispatch({ action: 'authRefreshLicence' });
  await started.promise;
  assert.equal((await f.dispatch({ action: 'authSignOut' })).success, true);
  response.resolve({ status: 'active', applyAllowed: true });
  await checking;
  assert.equal(f.data.authSession, null); assert.equal(f.data.licenceState, null); assert.equal(f.data.processingRuleSet, null);
});

test('outages and authorization failures never reuse cached licence authority', async () => {
  for (const code of ['NETWORK_ERROR', 'UNAVAILABLE', 'PERMISSION_DENIED', 'UNAUTHENTICATED']) {
    const f = setup({ callFunction: async () => { throw Object.assign(new Error('Synthetic failure'), { code }); } });
    f.data.licenceState = { status: 'active', previewAllowed: true, applyAllowed: true,
      checkedAt: Date.now(), authorizationExpiresAt: new Date(Date.now() + 3600000).toISOString() };
    f.data.processingRuleSet = { rules: [{ ruleId: 'SYN-PRIVATE' }] };
    const reply = await f.dispatch({ action: 'authRefreshLicence' });
    assert.equal(reply.licenceState.applyAllowed, false, code);
    assert.equal(reply.licenceState.previewAllowed, false, code);
    assert.equal(f.data.processingRuleSet, null, code);
    if (code === 'UNAUTHENTICATED') assert.equal(f.data.authSession, null);
    else assert.equal(f.data.authSession.uid, 'SYN-A');
  }
});

test('client licence authority is bounded and rejects expired server decisions', async () => {
  const now = Date.now();
  for (const until of [now + 60000, now + 3600000, now - 1000]) {
    const f = setup({ callFunction: async () => ({ status: 'active', previewAllowed: true, applyAllowed: true,
      authorizationExpiresAt: new Date(until).toISOString() }) });
    const reply = await f.dispatch({ action: 'authRefreshLicence' });
    assert(Date.parse(reply.licenceState.authorizationExpiresAt) <= Math.min(until, Date.now() + 300000));
    assert.equal(reply.licenceState.applyAllowed, until > now);
  }
});

test('a direct rule-service denial clears cached rules and local authority', async () => {
  const f = setup({ callFunction: async () => { throw Object.assign(new Error('Synthetic rule denial'), { code: 'PERMISSION_DENIED' }); } });
  f.data.processingRuleSet = { rules: [{ ruleId: 'SYN-PRIVATE' }] };
  assert.equal((await f.dispatch({ action: 'refreshProcessingRules' })).success, false);
  assert.equal(f.data.processingRuleSet, null);
  assert.equal(f.data.licenceState.applyAllowed, false);
});

test('token refresh and delayed sign-in cannot recreate credentials after sign-out', async () => {
  for (const operation of ['refresh', 'sign-in']) {
    const started = deferred(), response = deferred();
    const deferredCall = () => { started.resolve(); return response.promise; };
    const f = setup(operation === 'refresh' ? { refreshIdToken: deferredCall } : { signInWithPassword: deferredCall });
    if (operation === 'refresh') f.data.authSession.expiresAt = 0;
    const pending = f.dispatch(operation === 'refresh' ? { action: 'authRefreshLicence' }
      : { action: 'authSignIn', email: 'synthetic@example.invalid', password: 'synthetic' });
    await started.promise;
    await f.dispatch({ action: 'authSignOut' });
    response.resolve({ uid: 'SYN-A', idToken: 'LATE', refreshToken: 'LATE', expiresAt: Date.now() + 3600000 });
    await pending;
    assert.equal(f.data.authSession, null); assert.equal(f.data.licenceState, null);
  }
});

test('an older account response cannot replace the current account entitlement', async () => {
  const started = deferred(), response = deferred();
  const f = setup(); const ordinary = f.AuthCore.callFunction;
  f.AuthCore.callFunction = args => args.name === 'verifyLicence' && args.idToken === 'SYN-A'
    ? (started.resolve(), response.promise) : ordinary(args);
  const oldCheck = f.dispatch({ action: 'authRefreshLicence' });
  await started.promise;
  assert.equal((await f.dispatch({ action: 'authSignIn', email: 'synthetic@example.invalid', password: 'synthetic' })).success, true);
  response.resolve({ status: 'active', applyAllowed: true, actor: 'SYN-A' });
  await oldCheck;
  assert.equal(f.data.authSession.uid, 'SYN-B'); assert.equal(f.data.licenceState.actor, 'SYN-B');
});

test('rule refreshes coalesce while in flight but every later Apply can request fresh authority', async () => {
  const started = deferred(), response = deferred(); let calls = 0;
  const f = setup({ callFunction: () => { calls++; started.resolve(); return response.promise; } });
  const a = f.dispatch({ action: 'refreshProcessingRules' }), b = f.dispatch({ action: 'refreshProcessingRules' });
  await started.promise;
  assert.equal(calls, 1);
  response.resolve({ schemaVersion: 2, mode: 'bundled', versionId: '', unchanged: true });
  assert.equal((await a).success, true); assert.equal((await b).success, true);
  await f.dispatch({ action: 'refreshProcessingRules' });
  assert.equal(calls, 2);
});

test('late rule responses cannot repopulate a signed-out profile', async () => {
  const started = deferred(), response = deferred();
  const f = setup({ callFunction: () => { started.resolve(); return response.promise; } });
  const pending = f.dispatch({ action: 'refreshProcessingRules' });
  await started.promise; await f.dispatch({ action: 'authSignOut' });
  response.resolve({ schemaVersion: 2, mode: 'bundled', versionId: '', unchanged: true });
  assert.equal((await pending).success, false);
  assert.equal(f.data.authSession, null); assert.equal(f.data.processingRuleSet, null);
});

test('overlapping signups cannot discard the newly created identity before it becomes resumable', async () => {
  const started = deferred(), response = deferred();
  const f = setup({ signUp: () => { started.resolve(); return response.promise; },
    updateProfile: async () => {}, sendEmailVerification: async () => {} });
  const request = { action: 'authSignUp', email: 'new@example.invalid', password: 'synthetic', displayName: 'Synthetic' };
  const first = f.dispatch(request);
  await started.promise;
  assert.equal((await f.dispatch(request)).error, 'AUTH_IN_PROGRESS');
  response.resolve({ uid: 'NEW', email: request.email, idToken: 'NEW', refreshToken: 'NEW-REFRESH', expiresAt: Date.now() + 3600000 });
  assert.equal((await first).success, true);
  assert.equal(f.data.pendingAuth.uid, 'NEW');
  assert.equal(f.data.pendingAuth.stage, 'verify-email');
  assert.equal(f.data.authSession, null);
  assert.equal(f.data.licenceState, null);
  assert.equal((await f.dispatch(request)).error, 'EMAIL_EXISTS');
  assert.equal(f.data.pendingAuth.uid, 'NEW');
});

test('profile and verification-email failures retain the created identity for recovery', async () => {
  const f = setup({
    signUp: async () => ({ uid: 'NEW', email: 'new@example.invalid', idToken: 'NEW', refreshToken: 'NEW-REFRESH', expiresAt: Date.now() + 3600000 }),
    updateProfile: async () => { throw new Error('Synthetic profile outage'); },
    sendEmailVerification: async () => { throw Object.assign(new Error('Synthetic email outage'), { code: 'NETWORK_ERROR' }); }
  });
  const reply = await f.dispatch({ action: 'authSignUp', email: 'new@example.invalid', password: 'synthetic', displayName: 'Synthetic' });
  assert.equal(reply.success, true);
  assert.equal(reply.verificationEmailSent, false);
  assert.equal(f.data.pendingAuth.uid, 'NEW');
  assert.equal(f.data.pendingAuth.displayName, 'Synthetic');
  assert.equal(f.data.pendingAuth.stage, 'verify-email');
  assert.equal(f.data.pendingAuth.lastError, 'NETWORK_ERROR');
  assert.equal(f.data.authSession, null);
  assert.equal(f.data.licenceState, null);
});

test('cancelling a delayed signup prevents its response from restoring pending credentials', async () => {
  const started = deferred(), response = deferred();
  const f = setup({ signUp: () => { started.resolve(); return response.promise; } });
  const pending = f.dispatch({ action: 'authSignUp', email: 'new@example.invalid', password: 'synthetic', displayName: 'Synthetic' });
  await started.promise;
  assert.equal((await f.dispatch({ action: 'authCancelSignUp' })).success, true);
  response.resolve({ uid: 'CANCELLED', idToken: 'CANCELLED', refreshToken: 'CANCELLED-REFRESH' });
  assert.equal((await pending).success, false);
  assert.equal(f.data.pendingAuth, null);
  assert.equal(f.data.authSession, null);
  assert.equal(f.data.licenceState, null);
});
