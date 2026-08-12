'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACCOUNT_STATUSES,
  DEFAULT_LICENSE,
  INDIVIDUAL_PLAN_PRICES,
  LICENSE_STATUSES,
  LICENSE_TYPES,
  PAYMENT_STATUSES,
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  compareSemanticVersions,
  computeLicenseExpiry,
  individualPlan,
  licenceAccessDecision,
  normalizedEmail,
  normalizedPaymentReference,
  rosterDocumentId,
  resolveActivationTarget,
  safeDocumentId,
  selectEmailInvitation,
  tokenHash
} = require('../lib/contracts');

test('rejected is a distinct non-active account status', () => {
  assert.ok(ACCOUNT_STATUSES.includes('rejected'));
  assert.ok(ACCOUNT_STATUSES.includes('invited'));
  assert.ok(ACCOUNT_STATUSES.includes('active'));
});

test('per-user license contracts include both commercial access models and safe defaults', () => {
  assert.deepEqual(LICENSE_TYPES, ['organisation', 'individual']);
  assert.deepEqual(LICENSE_STATUSES, ['inactive', 'active', 'expired']);
  assert.deepEqual(PAYMENT_STATUSES, ['not_required', 'pending_verification', 'verified']);
  assert.equal(DEFAULT_LICENSE.type, 'individual');
  assert.equal(DEFAULT_LICENSE.status, 'inactive');
  assert.equal(DEFAULT_LICENSE.paymentProvider, 'upi');
  assert.deepEqual(INDIVIDUAL_PLAN_PRICES, { 1: 99, 2: 198, 4: 300, 12: 500 });
});

test('individual plans map only approved terms to fixed rupee prices', () => {
  assert.deepEqual(individualPlan(1), { durationWeeks: 1, price: 99 });
  assert.deepEqual(individualPlan(12), { durationWeeks: 12, price: 500 });
  assert.throws(() => individualPlan(3), /not an available individual plan/);
});

test('computeLicenseExpiry converts whole weeks to an exact millisecond offset', () => {
  const from = 1_800_000_000_000;
  assert.equal(computeLicenseExpiry(1, from), from + 7 * 24 * 60 * 60 * 1000);
  assert.equal(computeLicenseExpiry(12, from), from + 84 * 24 * 60 * 60 * 1000);
});

test('roster document IDs normalize employee codes within an organization', () => {
  assert.equal(rosterDocumentId('org_01', 'emp-42'), 'org_01_EMP-42');
  assert.throws(() => rosterDocumentId('../org', 'EMP-42'), /invalid/);
  assert.throws(() => rosterDocumentId('org_01', '../EMP'), /invalid/);
});

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

test('verified-email onboarding prefers caller-owned recovery then newest live invitation', () => {
  const now = 1000;
  const records = [
    { id: 'expired', status: 'pending', expiresAtMs: 999, createdAtMs: 900 },
    { id: 'new-live', status: 'pending', expiresAtMs: 2000, createdAtMs: 800 },
    { id: 'old-live', status: 'pending', expiresAtMs: 2000, createdAtMs: 700 }
  ];
  assert.equal(selectEmailInvitation(records, 'uid-1', now).id, 'new-live');
  assert.equal(selectEmailInvitation([
    ...records,
    { id: 'accepted-other', status: 'accepted', acceptedBy: 'uid-2', createdAtMs: 950 },
    { id: 'accepted-self', status: 'accepted', acceptedBy: 'uid-1', createdAtMs: 600 }
  ], 'uid-1', now).id, 'accepted-self');
  assert.equal(selectEmailInvitation([
    { id: 'expired', status: 'pending', expiresAtMs: 999, createdAtMs: 900 },
    { id: 'revoked', status: 'revoked', expiresAtMs: 2000, createdAtMs: 950 }
  ], 'uid-1', now), null);
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

test('semantic version gates compare numeric components instead of lexicographic text', () => {
  assert.equal(compareSemanticVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemanticVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemanticVersions('1.9.9', '1.10.0'), -1);
  assert.throws(() => compareSemanticVersions('1.2', '1.2.0'), /invalid/);
});

test('payment references have one canonical representation for uniqueness checks', () => {
  assert.equal(normalizedPaymentReference('  abc 123_xyz '), 'ABC123_XYZ');
  assert.throws(() => normalizedPaymentReference('short'), /invalid/);
  assert.throws(() => normalizedPaymentReference('unsafe/reference'), /invalid/);
});
