const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerializedStorageWriter, migrateRuleOverridesToLocal } = require('../background');

function delayedStorage(initial = {}) {
  const data = globalThis.structuredClone(initial);
  return {
    data,
    get(keys, callback) {
      setTimeout(() => {
        const result = {};
        for (const key of keys) result[key] = globalThis.structuredClone(data[key]);
        callback(result);
      }, 1);
    },
    set(values, callback) {
      setTimeout(() => {
        Object.assign(data, globalThis.structuredClone(values));
        callback();
      }, 1);
    },
    remove(key, callback) {
      setTimeout(() => {
        delete data[key];
        callback();
      }, 1);
    }
  };
}

test('serialized writer preserves concurrent activity and feedback appends from multiple tabs', async () => {
  const storage = delayedStorage();
  const now = Date.parse('2026-07-19T12:00:00Z');
  const writer = createSerializedStorageWriter(storage, () => now);
  await Promise.all(Array.from({ length: 40 }, (_, index) => Promise.all([
    writer.append('claimActivityLog', [{ timestamp: new Date(now + index).toISOString(), event: `tab-a-${index}` }]),
    writer.append('rghsAuditFeedback', [{ ts: new Date(now + index).toISOString(), verdict: 'confirmed', rowNumber: index }])
  ])));
  assert.equal(storage.data.claimActivityLog.length, 40);
  assert.equal(storage.data.rghsAuditFeedback.length, 40);
  assert.equal(new Set(storage.data.claimActivityLog.map(entry => entry.event)).size, 40);
});

test('serialized audit log deduplicates without dropping distinct concurrent entries', async () => {
  const storage = delayedStorage();
  const writer = createSerializedStorageWriter(storage);
  const entry = index => ({
    url: 'claim', tid: 'T1', ruleId: 'BI-01', rowNumber: index,
    findingType: 'UNBUNDLING', action: 'flagged'
  });
  await Promise.all([
    writer.append('rghsAuditLog', [entry(1), entry(2)]),
    writer.append('rghsAuditLog', [entry(1), entry(3)])
  ]);
  assert.deepEqual(storage.data.rghsAuditLog.map(item => item.rowNumber), [1, 2, 3]);
});

test('recovery append and removal share one queue and retain unrelated snapshots', async () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  const storage = delayedStorage({ claimRecoverySnapshots: [{ id: 'old', createdAt: now }] });
  const writer = createSerializedStorageWriter(storage, () => now);
  await Promise.all([
    writer.append('claimRecoverySnapshots', [{ id: 'tab-a', createdAt: now }]),
    writer.append('claimRecoverySnapshots', [{ id: 'tab-b', createdAt: now }]),
    writer.removeRecoverySnapshot('old')
  ]);
  assert.deepEqual(storage.data.claimRecoverySnapshots.map(item => item.id), ['tab-a', 'tab-b']);
});

test('serialized local override updates merge concurrent options-page changes', async () => {
  const storage = delayedStorage({
    ruleOverrides: { 'EXISTING-01': { autoDeductEligible: true } }
  });
  const writer = createSerializedStorageWriter(storage);
  await Promise.all([
    writer.setRuleOverride('CA-01', true),
    writer.setRuleOverride('BI-01', false)
  ]);
  assert.deepEqual(storage.data.ruleOverrides, {
    'EXISTING-01': { autoDeductEligible: true },
    'CA-01': { autoDeductEligible: true },
    'BI-01': { autoDeductEligible: false }
  });
});

test('legacy synced overrides migrate once to profile-local storage', async () => {
  const local = delayedStorage();
  const sync = delayedStorage({ ruleOverrides: { 'CA-01': { autoDeductEligible: true } } });
  assert.equal(await migrateRuleOverridesToLocal(local, sync), true);
  assert.deepEqual(local.data.ruleOverrides, { 'CA-01': { autoDeductEligible: true } });
  assert.equal(local.data.ruleOverridesMigratedToLocal, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sync.data, 'ruleOverrides'), false);

  sync.data.ruleOverrides = { 'BI-01': { autoDeductEligible: true } };
  assert.equal(await migrateRuleOverridesToLocal(local, sync), false);
  assert.deepEqual(local.data.ruleOverrides, { 'CA-01': { autoDeductEligible: true } });
});

test('custom rule configuration is serialized through the service worker', async () => {
  const storage = delayedStorage();
  const writer = createSerializedStorageWriter(storage);
  const config = { schemaVersion: 1, rules: [{ ruleId: 'CUSTOM-001' }], remarkTemplates: {} };
  assert.equal(await writer.setCustomRuleConfig(config), 1);
  assert.deepEqual(storage.data.customRuleConfig, config);
});

test('auth session and licence state are written and cleared through the service worker', async () => {
  const storage = delayedStorage();
  const writer = createSerializedStorageWriter(storage);
  const session = { uid: 'uid-1', email: 'user@example.com', idToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3600000 };
  assert.deepEqual(await writer.setAuthSession(session), session);
  assert.deepEqual(storage.data.authSession, session);

  const licenceState = { status: 'active', previewAllowed: true, applyAllowed: true, checkedAt: Date.now(), source: 'server' };
  assert.deepEqual(await writer.setLicenceState(licenceState), licenceState);
  assert.deepEqual(storage.data.licenceState, licenceState);

  assert.equal(await writer.clearAuthSession(), null);
  assert.equal(storage.data.authSession, null);
});

test('pending sign-up state is written and cleared independently of a full auth session', async () => {
  const storage = delayedStorage();
  const writer = createSerializedStorageWriter(storage);
  const pending = {
    uid: 'uid-2', email: 'new@example.com', idToken: 'a', refreshToken: 'b', expiresAt: Date.now() + 3600000,
    displayName: 'New Processor', invitationToken: 'tok', stage: 'verify-email', lastError: null
  };
  assert.deepEqual(await writer.setPendingAuth(pending), pending);
  assert.deepEqual(storage.data.pendingAuth, pending);

  const advanced = { ...pending, stage: 'accept-invitation' };
  assert.deepEqual(await writer.setPendingAuth(advanced), advanced);
  assert.deepEqual(storage.data.pendingAuth, advanced);

  assert.equal(await writer.clearPendingAuth(), null);
  assert.equal(storage.data.pendingAuth, null);
});

test('concurrent sign-in and licence-recheck writes never race on the same key', async () => {
  const storage = delayedStorage();
  const writer = createSerializedStorageWriter(storage);
  await Promise.all([
    writer.setLicenceState({ status: 'active', checkedAt: 1 }),
    writer.setLicenceState({ status: 'grace', checkedAt: 2 }),
    writer.setLicenceState({ status: 'expired', checkedAt: 3 })
  ]);
  assert.ok(['active', 'grace', 'expired'].includes(storage.data.licenceState.status));
});
