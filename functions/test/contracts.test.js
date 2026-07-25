'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  licenceAccessDecision,
  normalizedEmail,
  resolveActivationTarget,
  safeDocumentId,
  tokenHash
} = require('../lib/contracts');

test('strict request contracts reject unknown and missing fields', () => {
  assert.doesNotThrow(() => assertKeys({ uid: 'u1' }, ['uid'], ['uid']));
  assert.throws(() => assertKeys({ uid: 'u1', role: 'admin' }, ['uid'], ['uid']), /Unknown field/);
  assert.throws(() => assertKeys({}, ['uid'], ['uid']), /Missing field/);
});

test('claim and patient content is rejected recursively', () => {
  assert.doesNotThrow(() => assertNoClaimContent({
    action: 'preview_created',
    result: 'success',
    extensionVersion: '1.6.0'
  }));
  assert.throws(() => assertNoClaimContent({ metadata: { transactionId: 'secret' } }), /forbidden/);
  assert.throws(() => assertNoClaimContent({ diagnosis: 'secret' }), /forbidden/);
  assert.throws(() => assertNoClaimContent({ portal_url: 'secret' }), /forbidden/);
});

test('identifiers, email and numeric bounds are normalized strictly', () => {
  assert.equal(normalizedEmail(' Admin@Example.COM '), 'admin@example.com');
  assert.equal(safeDocumentId('org_01'), 'org_01');
  assert.equal(boundedInteger(50, 'maximumUsers', 1, 500), 50);
  assert.throws(() => safeDocumentId('../org'), /invalid/);
  assert.throws(() => boundedInteger(0, 'maximumUsers', 1, 500), /invalid/);
});

test('invitation tokens are stored as deterministic hashes', () => {
  assert.equal(tokenHash('one-time-token'), tokenHash('one-time-token'));
  assert.notEqual(tokenHash('one-time-token'), tokenHash('another-token'));
  assert.equal(tokenHash('one-time-token').length, 64);
});

test('activateUser accepts exactly one of uid or email, never both or neither', () => {
  assert.deepEqual(resolveActivationTarget({ uid: 'u1' }), { by: 'uid', value: 'u1' });
  assert.deepEqual(resolveActivationTarget({ email: ' Processor@Example.COM ' }), { by: 'email', value: 'processor@example.com' });
  assert.throws(() => resolveActivationTarget({}), /exactly one/);
  assert.throws(() => resolveActivationTarget({ uid: 'u1', email: 'a@b.com' }), /exactly one/);
});

test('licence decisions preserve apply safety during grace and suspension', () => {
  const now = Date.parse('2026-07-25T00:00:00Z');
  const gracePeriodMs = 72 * 60 * 60 * 1000;
  assert.deepEqual(licenceAccessDecision({
    status: 'active',
    expiryMs: now + 1000,
    now,
    gracePeriodMs
  }), { status: 'active', previewAllowed: true, applyAllowed: true });
  assert.deepEqual(licenceAccessDecision({
    status: 'active',
    expiryMs: now - 1000,
    now,
    gracePeriodMs
  }), { status: 'grace', previewAllowed: true, applyAllowed: false });
  assert.deepEqual(licenceAccessDecision({
    status: 'suspended',
    expiryMs: now + 1000,
    now,
    gracePeriodMs
  }), { status: 'suspended', previewAllowed: false, applyAllowed: false });
  assert.deepEqual(licenceAccessDecision({
    status: 'expired',
    expiryMs: now - gracePeriodMs - 1,
    now,
    gracePeriodMs
  }), { status: 'expired', previewAllowed: false, applyAllowed: false });
});
