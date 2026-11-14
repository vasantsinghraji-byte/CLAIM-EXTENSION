#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const PROJECT_ID = 'demo-claimextension';
const AUTH_BASE_URL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const FUNCTIONS_BASE_URL = `http://127.0.0.1:5001/${PROJECT_ID}/asia-south1`;
const TEST_PASSWORD = 'Acceptance!2026';
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp, deleteApp } = functionsRequire('firebase-admin/app');
const { getAuth } = functionsRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore');

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = PROJECT_ID;

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { response, body };
}

async function signIn(email) {
  const { response, body } = await jsonRequest(
    `${AUTH_BASE_URL}/accounts:signInWithPassword?key=acceptance-emulator-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true })
    }
  );
  assert.equal(response.ok, true, `Unable to sign in ${email}: ${JSON.stringify(body)}`);
  return body.idToken;
}

async function callFunction(name, idToken, data = {}, expectedError = null) {
  const { response, body } = await jsonRequest(`${FUNCTIONS_BASE_URL}/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ data })
  });
  if (expectedError) {
    assert.equal(response.ok, false, `${name} unexpectedly succeeded`);
    assert.equal(body.error?.status, expectedError, `${name} returned ${JSON.stringify(body)}`);
    return body.error;
  }
  assert.equal(response.ok, true, `${name} failed: ${JSON.stringify(body)}`);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'result'), `${name} returned no callable result`);
  return body.result;
}

async function createVerifiedUser(auth, email, displayName) {
  return auth.createUser({ email, password: TEST_PASSWORD, displayName, emailVerified: true });
}

function defaultLicense() {
  return {
    type: 'individual', status: 'inactive', durationWeeks: 0,
    activatedAt: null, expiresAt: null, organizationId: null,
    paymentStatus: 'not_required', paymentReference: null,
    paymentProvider: 'upi', requestedDurationWeeks: null, paymentAmount: null,
    verifiedBy: null, verifiedAt: null
  };
}

async function seedFoundation(auth, db) {
  const now = Date.now();
  const platformExpiry = Timestamp.fromMillis(now + 90 * 24 * 60 * 60 * 1000);
  const sponsoredExpiry = Timestamp.fromMillis(now + 28 * 24 * 60 * 60 * 1000);
  const admin = await createVerifiedUser(auth, 'acceptance-admin@claim-spark.local', 'Acceptance Admin');
  await auth.setCustomUserClaims(admin.uid, {
    organizationId: 'platform', role: 'platformAdmin', accountStatus: 'active'
  });
  await Promise.all([
    db.doc('organizations/platform').set({
      name: 'Acceptance Platform', status: 'active', maximumUsers: 10,
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
    }),
    db.doc('licences/platform').set({
      organizationId: 'platform', status: 'active', maximumUsers: 10,
      startDate: Timestamp.fromMillis(now), expiryDate: platformExpiry, termDays: 90
    }),
    db.doc('organizations/acceptance-org').set({
      name: 'Acceptance Organisation', status: 'active', maximumUsers: 1,
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
    }),
    db.doc('licences/acceptance-org').set({
      organizationId: 'acceptance-org', status: 'active', maximumUsers: 1,
      startDate: Timestamp.fromMillis(now), expiryDate: sponsoredExpiry, termDays: 28
    }),
    db.doc(`users/${admin.uid}`).set({
      email: admin.email, displayName: admin.displayName, organizationId: 'platform',
      role: 'platformAdmin', accountStatus: 'active', onboardingSource: 'acceptance-test',
      license: {
        ...defaultLicense(), type: 'organisation', status: 'active', durationWeeks: 12,
        organizationId: 'platform', activatedAt: Timestamp.fromMillis(now), expiresAt: platformExpiry
      },
      createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
    }),
    db.doc('appConfig/production').set({
      minimumSupportedVersion: '0.0.0', maintenanceMode: false, aiEnabled: false
    })
  ]);
  return { admin, sponsoredExpiry };
}

async function testSponsoredLifecycle(auth, db, adminToken, sponsoredExpiry) {
  const sponsored = await createVerifiedUser(auth, 'acceptance-sponsored@claim-spark.local', 'Sponsored Processor');
  const rosterImport = await callFunction('bulkAddRosterEntries', adminToken, {
    organizationId: 'acceptance-org',
    entries: [
      { employeeCode: 'EMP-ACCEPT-01', email: sponsored.email, role: 'processor' },
      { employeeCode: 'EMP-ACCEPT-02', email: 'unused-sponsored@claim-spark.local', role: 'processor' }
    ]
  });
  assert.deepEqual(rosterImport, { organizationId: 'acceptance-org', submitted: 2, created: 2, updated: 0 });
  let sponsoredToken = await signIn(sponsored.email);
  await callFunction('completeInvitationOnboarding', sponsoredToken, { displayName: 'Sponsored Processor' });
  const onboarding = await callFunction('completeOrganizationSponsoredOnboarding', sponsoredToken, {
    organizationId: 'acceptance-org', employeeCode: 'EMP-ACCEPT-01', displayName: 'Sponsored Processor'
  });
  assert.equal(onboarding.activationRequired, true);
  const roster = (await db.doc('orgRoster/acceptance-org_EMP-ACCEPT-01').get()).data();
  const pending = (await db.doc(`users/${sponsored.uid}`).get()).data();
  assert.equal(roster.status, 'claimed');
  assert.equal(roster.claimedByUid, sponsored.uid);
  assert.equal((await db.doc('orgRoster/acceptance-org_EMP-ACCEPT-02').get()).data().status, 'available');
  assert.equal(pending.accountStatus, 'invited');
  assert.equal(pending.license.type, 'organisation');
  assert.equal(pending.license.status, 'inactive');

  await callFunction('activateUser', adminToken, { uid: sponsored.uid });
  const active = (await db.doc(`users/${sponsored.uid}`).get()).data();
  assert.equal(active.accountStatus, 'active');
  assert.equal(active.license.status, 'active');
  assert.equal(active.license.expiresAt.toMillis(), sponsoredExpiry.toMillis());
  const access = await callFunction('verifyLicence', sponsoredToken, { extensionVersion: '1.11.1' });
  assert.equal(access.status, 'active');
  assert.equal(access.applyAllowed, true);

  await callFunction('setUserLicense', adminToken, { uid: sponsored.uid, action: 'deactivate' });
  const deactivatedAccess = await callFunction('verifyLicence', sponsoredToken, { extensionVersion: '1.12.0' });
  assert.equal(deactivatedAccess.status, 'inactive');
  assert.equal(deactivatedAccess.applyAllowed, false);
  await callFunction('getActiveProcessingRules', sponsoredToken, { extensionVersion: '1.12.0' }, 'PERMISSION_DENIED');
  await callFunction('suspendUser', adminToken, { uid: sponsored.uid });
  await callFunction('activateUser', adminToken, { uid: sponsored.uid });
  const reactivated = (await db.doc(`users/${sponsored.uid}`).get()).data();
  assert.equal(reactivated.accountStatus, 'active');
  assert.equal(reactivated.license.status, 'inactive',
    'account reactivation must not silently rewrite historical per-user licence state');
  await callFunction('verifyLicence', sponsoredToken, { extensionVersion: '1.11.1' }, 'UNAUTHENTICATED');
  sponsoredToken = await signIn(sponsored.email);
  const reactivatedAccess = await callFunction(
    'verifyLicence', sponsoredToken, { extensionVersion: '1.11.1' }
  );
  assert.equal(reactivatedAccess.status, 'inactive',
    'account reactivation must not bypass the independent user licence deactivation');
  assert.equal(reactivatedAccess.licenseType, 'organisation');
  assert.equal(reactivatedAccess.applyAllowed, false);
  await callFunction('setUserLicense', adminToken, { uid: sponsored.uid, action: 'activate', durationWeeks: 4 });
  assert.equal((await callFunction('verifyLicence', sponsoredToken, { extensionVersion: '1.12.0' })).applyAllowed, true);
}

async function testIndividualLifecycle(auth, db, adminToken) {
  const individual = await createVerifiedUser(auth, 'acceptance-individual@claim-spark.local', 'Individual Processor');
  const individualToken = await signIn(individual.email);
  const now = Date.now();
  await db.doc(`users/${individual.uid}`).set({
    email: individual.email,
    displayName: 'Individual Processor',
    organizationId: 'platform',
    role: 'processor',
    accountStatus: 'active',
    onboardingSource: 'acceptance-test-existing-individual',
    license: defaultLicense(),
    createdAt: Timestamp.fromMillis(now),
    updatedAt: Timestamp.fromMillis(now)
  });
  const payment = await callFunction('submitPaymentProof', individualToken, {
    paymentReference: 'ACCEPTANCE-UPI-UTR-0001', durationWeeks: 4
  });
  assert.deepEqual(payment, { paymentStatus: 'pending_verification', durationWeeks: 4, paymentAmount: 300 });
  let user = (await db.doc(`users/${individual.uid}`).get()).data();
  assert.equal(user.license.requestedDurationWeeks, 4);
  assert.equal(user.license.paymentAmount, 300);
  assert.equal(user.license.paymentProvider, 'upi');

  await callFunction('setUserLicense', adminToken, {
    uid: individual.uid, action: 'activate', durationWeeks: 4
  }, 'FAILED_PRECONDITION');
  await callFunction('verifyUserPayment', adminToken, { uid: individual.uid, verified: true });
  await callFunction('activateUser', adminToken, { uid: individual.uid });
  await callFunction('setUserLicense', adminToken, {
    uid: individual.uid, action: 'activate', durationWeeks: 2
  }, 'FAILED_PRECONDITION');
  await callFunction('setUserLicense', adminToken, {
    uid: individual.uid, action: 'activate', durationWeeks: 4
  });

  user = (await db.doc(`users/${individual.uid}`).get()).data();
  assert.equal(user.accountStatus, 'active');
  assert.equal(user.license.paymentStatus, 'verified');
  assert.equal(user.license.status, 'active');
  assert.equal(user.license.durationWeeks, 4);
  const access = await callFunction('verifyLicence', individualToken, { extensionVersion: '1.11.1' });
  assert.equal(access.status, 'active');
  assert.equal(access.applyAllowed, true);

  const renewalBase = Date.now() + 6 * 24 * 60 * 60 * 1000;
  await db.doc(`users/${individual.uid}`).update({
    'license.expiresAt': Timestamp.fromMillis(renewalBase),
    'license.paymentStatus': 'verified'
  });
  const renewal = await callFunction('submitPaymentProof', individualToken, {
    paymentReference: 'ACCEPTANCE-UPI-UTR-0002', durationWeeks: 2
  });
  assert.deepEqual(renewal, { paymentStatus: 'pending_verification', durationWeeks: 2, paymentAmount: 198 });
  const pendingRenewalAccess = await callFunction('verifyLicence', individualToken, { extensionVersion: '1.11.1' });
  assert.equal(pendingRenewalAccess.status, 'active');
  assert.equal(pendingRenewalAccess.applyAllowed, true);
  assert.equal(pendingRenewalAccess.expiringSoon, true);
  assert.equal(pendingRenewalAccess.paymentStatus, 'pending_verification');
  await callFunction('verifyUserPayment', adminToken, { uid: individual.uid, verified: false, reason: 'Synthetic declined renewal' });
  assert.equal((await callFunction('verifyLicence', individualToken, { extensionVersion: '1.12.0' })).applyAllowed, true,
    'declining a renewal must preserve the previously paid current term');
  await callFunction('verifyUserPayment', adminToken, { uid: individual.uid, verified: true });
  await callFunction('setUserLicense', adminToken, {
    uid: individual.uid, action: 'extend', durationWeeks: 1
  }, 'FAILED_PRECONDITION');
  await callFunction('setUserLicense', adminToken, {
    uid: individual.uid, action: 'extend', durationWeeks: 2
  });
  const renewed = (await db.doc(`users/${individual.uid}`).get()).data();
  assert.ok(renewed.license.expiresAt.toMillis() > renewalBase);
}

async function testSelfServiceSafety(auth, db, adminToken) {
  const register = (token, expectedError = null) => callFunction(
    'completeInvitationOnboarding', token, { displayName: 'Synthetic Processor' }, expectedError
  );
  const fresh = await createVerifiedUser(auth, 'selfservice-fresh@claim-spark.local', 'Synthetic Processor');
  const token = await signIn(fresh.email);
  const registration = await register(token);
  assert.equal(registration.status, 'invited');
  assert.equal(registration.activationRequired, true);
  assert.equal(registration.accessSelectionRequired, true);
  assert.equal((await register(token)).alreadyAccepted, true);
  const created = (await db.doc(`users/${fresh.uid}`).get()).data();
  assert.equal(created.accountStatus, 'invited');
  assert.equal(created.license.type, 'individual');
  assert.equal(created.license.status, 'inactive');
  await callFunction('verifyLicence', token, { extensionVersion: '1.12.0' }, 'PERMISSION_DENIED');
  const audits = await db.collection('auditLogs').where('targetId', '==', fresh.uid).get();
  assert.equal(audits.docs.filter(doc => doc.data().action === 'user.registration_completed').length, 1);
  for (const status of ['suspended', 'rejected', 'deleted']) {
    const identity = await createVerifiedUser(auth, `selfservice-${status}@claim-spark.local`, 'Synthetic Processor');
    await db.doc(`users/${identity.uid}`).set({
      email: identity.email, role: 'processor', organizationId: 'platform',
      accountStatus: status, onboardingSource: 'self-registration', license: defaultLicense()
    });
    await register(await signIn(identity.email), 'PERMISSION_DENIED');
    assert.equal((await db.doc(`users/${identity.uid}`).get()).data().accountStatus, status);
  }
  await callFunction('submitPaymentProof', token, { paymentReference: 'SELF-REG-PAYMENT', durationWeeks: 1 });
  assert.equal((await register(token)).accessSelectionRequired, false);
  assert.equal((await db.doc(`users/${fresh.uid}`).get()).data().license.paymentStatus, 'pending_verification');
  await callFunction('activateUser', adminToken, { uid: fresh.uid });
  assert.equal((await callFunction('verifyLicence', token, { extensionVersion: '1.12.0' })).applyAllowed, false,
    'account approval alone must not activate an unpaid licence');
  await callFunction('setUserLicense', adminToken, { uid: fresh.uid, action: 'activate', durationWeeks: 1 }, 'FAILED_PRECONDITION');
  // Even inconsistent active data cannot authorize an unpaid initial term.
  await db.doc(`users/${fresh.uid}`).update({ 'license.status': 'active', 'license.expiresAt': Timestamp.fromMillis(Date.now() + 86400000) });
  assert.equal((await callFunction('verifyLicence', token, { extensionVersion: '1.12.0' })).applyAllowed, false);
  await callFunction('getActiveProcessingRules', token, { extensionVersion: '1.12.0' }, 'PERMISSION_DENIED');
  await db.doc(`users/${fresh.uid}`).update({ 'license.paymentStatus': 'not_required' });
  await callFunction('setUserLicense', adminToken, { uid: fresh.uid, action: 'extend', durationWeeks: 1 }, 'FAILED_PRECONDITION');
  const inherited = await createVerifiedUser(auth, 'legacy-inherited@claim-spark.local', 'Legacy Unactivated Processor');
  const inheritedToken = await signIn(inherited.email);
  await db.doc(`users/${inherited.uid}`).set({ email: inherited.email, role: 'processor', accountStatus: 'active',
    organizationId: 'platform', onboardingSource: 'self-registration', license: {
      ...defaultLicense(), type: 'organisation', status: 'active', organizationId: 'platform',
      expiresAt: Timestamp.fromMillis(Date.now() + 86400000)
    } });
  assert.equal((await callFunction('verifyLicence', inheritedToken, { extensionVersion: '1.12.0' })).applyAllowed, false,
    'legacy automatically inherited licence must require explicit administrator activation');
  await callFunction('getActiveProcessingRules', inheritedToken, { extensionVersion: '1.12.0' }, 'PERMISSION_DENIED');
  await callFunction('setUserLicense', adminToken, { uid: inherited.uid, action: 'activate', durationWeeks: 4 });
  assert.equal((await callFunction('verifyLicence', inheritedToken, { extensionVersion: '1.12.0' })).applyAllowed, true);
  const unverified = await auth.createUser({ email: 'selfservice-unverified@claim-spark.local', password: TEST_PASSWORD });
  await register(await signIn(unverified.email), 'FAILED_PRECONDITION');
  assert.equal((await db.doc(`users/${unverified.uid}`).get()).exists, false);
  const licenceReference = db.doc('licences/platform');
  const originalLicence = (await licenceReference.get()).data();
  try {
    await licenceReference.update({ expiryDate: Timestamp.fromMillis(Date.now() - 1) });
    const waiting = await createVerifiedUser(auth, 'selfservice-waiting@claim-spark.local', 'Synthetic Processor');
    assert.equal((await register(await signIn(waiting.email))).status, 'invited');
    await callFunction('activateUser', adminToken, { uid: waiting.uid }, 'FAILED_PRECONDITION');
    await licenceReference.set(originalLicence);
    const activeCount = (await db.collection('users').where('organizationId', '==', 'platform').where('accountStatus', '==', 'active').get()).size;
    await licenceReference.update({ maximumUsers: activeCount + 1 });
    const contenders = await Promise.all([1, 2].map(index => createVerifiedUser(auth, `selfservice-race-${index}@claim-spark.local`, 'Synthetic Processor')));
    for (const identity of contenders) await register(await signIn(identity.email));
    const results = await Promise.all(contenders.map(identity => jsonRequest(`${FUNCTIONS_BASE_URL}/activateUser`, {
      method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { uid: identity.uid } })
    })));
    assert.equal(results.filter(result => result.body.result).length, 1);
    assert.equal(results.filter(result => result.body.error?.status === 'RESOURCE_EXHAUSTED').length, 1);
  } finally { await licenceReference.set(originalLicence); }
  console.log('PASS: pending registration, idempotent recovery, unpaid access denial and administrator capacity enforcement.');
}

async function testRuleGovernance(auth, db, adminToken) {
  const secondAdmin = await createVerifiedUser(auth, 'acceptance-policy-admin@claim-spark.local', 'Synthetic Policy Administrator');
  await auth.setCustomUserClaims(secondAdmin.uid, { role: 'platformAdmin', accountStatus: 'active', organizationId: 'platform' });
  await db.doc(`users/${secondAdmin.uid}`).set({ email: secondAdmin.email, role: 'platformAdmin', accountStatus: 'active', organizationId: 'platform' });
  const secondToken = await signIn(secondAdmin.email);
  const warning = { ruleId: 'QA-WARNING', schemaVersion: 2, name: 'Synthetic warning', description: '',
    processingArea: 'ALL', enabled: true, priority: 200, enforcement: 'advisory',
    conditions: { operator: 'packagePresent', packageCodes: ['QA-WARN'] }, actions: [{ type: 'warn', message: 'Synthetic review warning' }], scenarios: [] };
  await callFunction('saveProcessingRuleDraft', adminToken, { rule: warning });
  await callFunction('setProcessingRuleStatus', adminToken, { ruleId: warning.ruleId, enabled: false });
  await callFunction('setProcessingRuleStatus', adminToken, { ruleId: warning.ruleId, enabled: true });
  const validated = await callFunction('validateProcessingRuleDrafts', adminToken, { bundledFallbackEnabled: true });
  assert.equal(validated.ruleCount, 1);
  const first = await callFunction('publishProcessingRuleDrafts', adminToken, { bundledFallbackEnabled: true });
  assert.equal(first.approvalRequired, false); assert.ok(first.versionId);
  const deduction = { ruleId: 'QA-DEDUCTION', schemaVersion: 2, name: 'Synthetic deduction', description: '',
    processingArea: 'IPD', enabled: true, priority: 100, enforcement: 'mandatory',
    conditions: { operator: 'packagePresent', packageCodes: ['QA-DEDUCT'] }, actions: [{ type: 'applyDeduction',
      targetPackageCodes: ['QA-DEDUCT'], calculation: { method: 'fixedAmount', basis: 'claimedAmount', value: 100 }, cumulative: false }],
    scenarios: [{ scenarioId: 'QA-DEDUCT-TEST', name: 'Synthetic deduction test', processingArea: 'IPD',
      lines: [{ packageCodes: ['QA-DEDUCT'], claimAmount: 1000, approvedAmount: 1000 }],
      expected: { matchedRuleIds: ['QA-DEDUCTION'], blocked: false, approvedAmounts: { 'QA-DEDUCT': 900 } } }] };
  await callFunction('saveProcessingRuleDraft', adminToken, { rule: deduction });
  const impact = await callFunction('validateProcessingRuleDrafts', adminToken, { bundledFallbackEnabled: true });
  assert.equal(impact.scenarios.publishable, true);
  const pending = await callFunction('publishProcessingRuleDrafts', adminToken, { bundledFallbackEnabled: true });
  assert.equal(pending.approvalRequired, true);
  await callFunction('approveProcessingRulePublication', adminToken, { approvalId: pending.approval.approvalId }, 'PERMISSION_DENIED');
  const approved = await callFunction('approveProcessingRulePublication', secondToken, { approvalId: pending.approval.approvalId });
  assert.ok(approved.versionId);
  const reader = await createVerifiedUser(auth, 'acceptance-rule-reader@claim-spark.local', 'Synthetic Rule Reader');
  await db.doc(`users/${reader.uid}`).set({ email: reader.email, role: 'processor', accountStatus: 'active', organizationId: 'platform',
    license: { ...defaultLicense(), type: 'organisation', status: 'active', organizationId: 'platform' } });
  const readerToken = await signIn(reader.email);
  const active = await callFunction('getActiveProcessingRules', readerToken, { extensionVersion: '1.12.0', supportedRuleSchemaVersions: [2] });
  assert.equal(active.versionId, approved.versionId); assert.equal(active.rules.length, 2);
  const unchanged = await callFunction('getActiveProcessingRules', readerToken, {
    extensionVersion: '1.12.0', supportedRuleSchemaVersions: [2], knownVersionId: active.versionId });
  assert.equal(unchanged.unchanged, true);
  const feedback = await callFunction('submitProcessingRuleFeedback', readerToken, { ruleId: deduction.ruleId, extensionVersion: '1.12.0',
    ruleSetVersion: approved.versionId, category: 'incorrect_deduction', processingArea: 'IPD', packageCodes: ['QA-DEDUCT'] });
  for (const status of ['under_review', 'accepted', 'rejected', 'resolved']) {
    await callFunction('reviewProcessingRuleFeedback', adminToken, { feedbackId: feedback.feedbackId, status,
      resolution: status === 'resolved' ? 'rule_updated' : null });
  }
  assert.equal((await callFunction('listProcessingRuleFeedback', adminToken)).feedback.find(item => item.feedbackId === feedback.feedbackId).status, 'resolved');
  const rollback = await callFunction('activateProcessingRuleVersion', adminToken, { versionId: first.versionId });
  if (rollback.approvalRequired) await callFunction('approveProcessingRulePublication', secondToken, { approvalId: rollback.approval.approvalId });
  assert.equal((await db.doc('processingRuleState/active').get()).data().versionId, first.versionId);
  const rejected = await callFunction('publishProcessingRuleDrafts', adminToken, { bundledFallbackEnabled: true });
  assert.equal(rejected.approvalRequired, true);
  await callFunction('rejectProcessingRulePublication', secondToken, { approvalId: rejected.approval.approvalId });
  assert.equal((await db.doc(`processingRuleApprovals/${rejected.approval.approvalId}`).get()).data().status, 'rejected');
  assert.equal((await db.doc('processingRuleState/active').get()).data().versionId, first.versionId);
  assert.equal((await callFunction('listProcessingRuleVersions', adminToken)).versions.length, 2);
  assert.ok((await callFunction('listProcessingRuleApprovals', adminToken)).approvals.length >= 2);
  assert.ok((await callFunction('listProcessingRuleHistory', adminToken)).events.length >= 5);
  console.log('PASS: rule drafts/status, validation, publish, distinct-admin approval, self-approval rejection, version refresh, feedback/review, rollback, rejected publication and history on isolated emulators.');
}

async function testAdminMonitor(auth, db, adminToken) {
  const endpoint = `${FUNCTIONS_BASE_URL}/monitorAdminDashboard`;
  const denied = await fetch(endpoint, { method: 'POST' });
  assert.equal(denied.status, 401);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let reader;
  const reference = db.doc('users/monitor-synthetic');
  const adminIdentity = await auth.verifyIdToken(adminToken);
  const adminReference = db.doc(`users/${adminIdentity.uid}`);
  const adminProfile = (await adminReference.get()).data();
  let adminChanged = false;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    const nextSnapshot = async () => {
      while (true) {
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (block.startsWith('event: snapshot\n')) return JSON.parse(block.split('\ndata: ')[1]);
          if (block.startsWith('event: monitor-error\n')) return { monitorError: JSON.parse(block.split('\ndata: ')[1]).code };
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, 'Live monitor closed before the expected snapshot');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const before = await nextSnapshot();
    assert.equal(before.projectId, PROJECT_ID);
    await reference.set({ email: 'monitor-synthetic@claim-spark.local', displayName: 'Synthetic monitor account',
      organizationId: 'platform', accountStatus: 'invited', role: 'processor', license: defaultLicense(), updatedAt: Timestamp.now() });
    let after;
    do { after = await nextSnapshot(); } while (after.counts.users === before.counts.users);
    assert.equal(after.counts.users, before.counts.users + 1);
    assert.equal(after.counts.pending, before.counts.pending + 1);
    await reference.update({ accountStatus: 'active', updatedAt: Timestamp.now() });
    do { after = await nextSnapshot(); } while (after.counts.pending !== before.counts.pending);
    assert.equal(after.counts.active, before.counts.active + 1);
    const processor = await createVerifiedUser(auth, 'monitor-processor@claim-spark.local', 'Synthetic monitor processor');
    await auth.setCustomUserClaims(processor.uid, { role: 'processor', accountStatus: 'active', organizationId: 'platform' });
    const processorToken = await signIn(processor.email);
    const forbidden = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${processorToken}` } });
    assert.equal(forbidden.status, 403);
    adminChanged = true;
    await adminReference.update({ accountStatus: 'suspended' });
    do { after = await nextSnapshot(); } while (!after.monitorError);
    assert.equal(after.monitorError, 'PERMISSION_DENIED');
    console.log('PASS: real Firebase emulator live monitor authentication, full counts, registration/activation push updates, processor denial and immediate administrator revocation.');
  } finally {
    controller.abort(); clearTimeout(timer); if (reader) await reader.cancel().catch(() => {});
    await reference.delete();
    if (adminChanged) await adminReference.set(adminProfile);
  }
}

async function testServerLicenceSecurity(auth, db) {
  assert.equal(PROJECT_ID, 'demo-claimextension');
  const identity = await createVerifiedUser(auth, 'licence-security@claim-spark.local', 'Synthetic Security Processor');
  const reference = db.doc(`users/${identity.uid}`), configReference = db.doc('appConfig/production');
  const originalConfig = (await configReference.get()).data();
  const profile = { email: identity.email, role: 'processor', accountStatus: 'active', organizationId: 'platform',
    license: { ...defaultLicense(), type: 'individual', status: 'active', paymentStatus: 'verified',
      activatedAt: Timestamp.fromMillis(Date.now()), expiresAt: Timestamp.fromMillis(Date.now() + 180000) } };
  const request = { extensionVersion: '1.12.1', supportedRuleSchemaVersions: [2] };
  try {
    await reference.set(profile);
    let token = await signIn(identity.email);
    const policy = await callFunction('getActiveProcessingRules', token, request);
    const decision = await callFunction('verifyLicence', token, { extensionVersion: request.extensionVersion });
    assert.equal(decision.applyAllowed, true);
    assert(Date.parse(decision.authorizationExpiresAt) <= Date.parse(decision.serverTime) + 300000);
    assert(Date.parse(decision.authorizationExpiresAt) <= profile.license.expiresAt.toMillis());
    await callFunction('getActiveProcessingRules', 'not-a-valid-token', request, 'UNAUTHENTICATED');
    await callFunction('getActiveProcessingRules', token, { ...request, applyAllowed: true }, 'INVALID_ARGUMENT');
    await configReference.update({ minimumSupportedVersion: '99.0.0' });
    await callFunction('getActiveProcessingRules', token, { ...request, knownVersionId: policy.versionId }, 'FAILED_PRECONDITION');
    assert.equal((await callFunction('verifyLicence', token, { extensionVersion: request.extensionVersion })).status, 'update-required');
    await configReference.update({ minimumSupportedVersion: '0.0.0', maintenanceMode: true });
    await callFunction('getActiveProcessingRules', token, request, 'FAILED_PRECONDITION');
    await configReference.set(originalConfig);
    await reference.update({ license: { ...profile.license, expiresAt: Timestamp.fromMillis(Date.now() - 1000) } });
    assert.equal((await callFunction('verifyLicence', token, { extensionVersion: request.extensionVersion })).applyAllowed, false);
    await callFunction('getActiveProcessingRules', token, request, 'PERMISSION_DENIED');
    await reference.set({ ...profile, license: null });
    await callFunction('getActiveProcessingRules', token, request, 'PERMISSION_DENIED');
    await reference.set(profile);
    await callFunction('getActiveProcessingRules', token, request);
    await reference.update({ license: { ...profile.license, status: 'inactive' } });
    await callFunction('getActiveProcessingRules', token, { ...request, extensionVersion: '999.0.0' }, 'PERMISSION_DENIED');
    await reference.set(profile);
    // Revocation timestamps have second precision; ensure the sign-in predates it.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await auth.revokeRefreshTokens(identity.uid);
    for (const name of ['verifyLicence', 'getActiveProcessingRules', 'getCurrentUserProfile']) {
      await callFunction(name, token, name === 'getCurrentUserProfile' ? {} : request, 'UNAUTHENTICATED');
    }
    token = await signIn(identity.email);
    await callFunction('getActiveProcessingRules', token, request);
    await auth.updateUser(identity.uid, { disabled: true });
    await callFunction('getActiveProcessingRules', token, request, 'UNAUTHENTICATED');
    console.log('PASS: server licence security: forged token/local flags, missing/expired/revoked licences, old versions, maintenance, bounded decisions, current-session revocation and disabled Auth identities. Emulator only.');
  } finally {
    await configReference.set(originalConfig);
    await reference.delete();
    await auth.deleteUser(identity.uid);
  }
}

async function main() {
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  const app = initializeApp({ projectId: PROJECT_ID });
  try {
    const auth = getAuth(app);
    const db = getFirestore(app);
    const { admin, sponsoredExpiry } = await seedFoundation(auth, db);
    const adminToken = await signIn(admin.email);
    if (process.argv.includes('--licence-regressions-only')) {
      await testIndividualLifecycle(auth, db, adminToken);
      await testSelfServiceSafety(auth, db, adminToken);
      console.log('PASS: final unpaid, legacy inherited access, renewal and capacity regressions on local emulators.');
      return;
    }
    if (process.argv.includes('--governance-only')) {
      await testRuleGovernance(auth, db, adminToken);
      await testServerLicenceSecurity(auth, db);
      await testAdminMonitor(auth, db, adminToken);
      console.log('PASS: complete rule-governance acceptance against local emulators.');
      return;
    }
    await testSponsoredLifecycle(auth, db, adminToken, sponsoredExpiry);
    await testIndividualLifecycle(auth, db, adminToken);
    await testSelfServiceSafety(auth, db, adminToken);
    await require('./signup-browser-acceptance').testSignupBrowser({ db, adminToken, callFunction });
    if (process.argv.includes('--onboarding-only')) return;
    await testRuleGovernance(auth, db, adminToken);
    await testServerLicenceSecurity(auth, db);
    await testAdminMonitor(auth, db, adminToken);
    console.log('PASS: sponsored and individual licence lifecycles completed against local emulators.');
  } finally {
    await deleteApp(app);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
