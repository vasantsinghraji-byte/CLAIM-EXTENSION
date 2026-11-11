'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inactiveUserLicenceDecision } = require('../lib/contracts');

test('explicit organization-user deactivation blocks access independently of account and organization status', () => {
  const user = { id: 'disabled-user', organizationId: 'active-org', role: 'processor', accountStatus: 'active',
    license: { type: 'organisation', status: 'inactive', paymentStatus: 'not_required' } };
  assert.deepEqual(inactiveUserLicenceDecision(user), { status: 'inactive', licenseType: 'organisation',
    paymentStatus: 'not_required', previewAllowed: false, applyAllowed: false });
});

test('individual deactivation and payment-pending access remain blocked, while legacy administrators retain their organization path', () => {
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: { type: 'individual', status: 'inactive' } }).applyAllowed, false);
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: { type: 'individual', status: 'inactive', paymentStatus: 'pending_verification' } }).status, 'payment-pending');
  assert.equal(inactiveUserLicenceDecision({ role: 'platformAdmin', organizationId: 'platform' }), null);
  assert.equal(inactiveUserLicenceDecision({ role: 'platformAdmin', organizationId: 'platform', license: { type: 'individual', status: 'inactive' } }), null);
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: { type: 'organisation', status: 'active' } }), null);
  assert.equal(inactiveUserLicenceDecision({ role: 'platformAdmin', organizationId: 'platform', license: { type: 'organisation', status: 'inactive' } }).applyAllowed, false);
});

test('an active flag cannot grant an unpaid initial individual term, while a previously verified renewal retains its term', () => {
  for (const paymentStatus of ['not_required', 'pending_verification']) {
    const user = { role: 'processor', organizationId: 'platform',
      license: { type: 'individual', status: 'active', paymentStatus } };
    assert.equal(inactiveUserLicenceDecision(user).applyAllowed, false);
  }
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: {
    type: 'individual', status: 'active', paymentStatus: 'verified'
  } }), null);
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: {
    type: 'individual', status: 'active', paymentStatus: 'pending_verification',
    verifiedAt: '2026-11-01T00:00:00Z', activatedAt: '2026-11-01T00:00:00Z'
  } }), null);
  assert.equal(inactiveUserLicenceDecision({ role: 'processor', license: {
    type: 'individual', status: 'active', paymentStatus: 'pending_verification', verifiedAt: null,
    activatedAt: '2026-11-01T00:00:00Z', activatedPaymentReference: 'SYN-PAID-TERM',
    activatedPaymentVerifiedAt: '2026-11-01T00:00:00Z'
  } }), null, 'declined renewal cannot erase the proof of the already-paid current term');
});

test('legacy self-registration cannot inherit an organization licence without explicit activation', () => {
  const user = { role: 'processor', organizationId: 'platform', onboardingSource: 'self-registration',
    license: { type: 'organisation', status: 'active', paymentStatus: 'not_required', activatedAt: null } };
  assert.equal(inactiveUserLicenceDecision(user).applyAllowed, false);
  assert.equal(inactiveUserLicenceDecision({ ...user, license: { ...user.license, activatedAt: '2026-11-10T00:00:00Z' } }), null);
  assert.equal(inactiveUserLicenceDecision({ ...user, role: 'platformAdmin' }), null);
});
