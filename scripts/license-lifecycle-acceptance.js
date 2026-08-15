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
  const sponsoredToken = await signIn(sponsored.email);
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
  await callFunction('suspendUser', adminToken, { uid: sponsored.uid });
  await callFunction('activateUser', adminToken, { uid: sponsored.uid });
  const reactivated = (await db.doc(`users/${sponsored.uid}`).get()).data();
  assert.equal(reactivated.accountStatus, 'active');
  assert.equal(reactivated.license.status, 'inactive',
    'account reactivation must preserve an independent per-user licence deactivation');
  const reactivatedAccess = await callFunction(
    'verifyLicence', sponsoredToken, { extensionVersion: '1.11.1' }
  );
  assert.equal(reactivatedAccess.status, 'inactive');
  assert.equal(reactivatedAccess.applyAllowed, false);
}

async function testIndividualLifecycle(auth, db, adminToken) {
  const individual = await createVerifiedUser(auth, 'acceptance-individual@claim-spark.local', 'Individual Processor');
  const individualToken = await signIn(individual.email);
  await callFunction('completeInvitationOnboarding', individualToken, { displayName: 'Individual Processor' });
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

async function main() {
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  const app = initializeApp({ projectId: PROJECT_ID });
  try {
    const auth = getAuth(app);
    const db = getFirestore(app);
    const { admin, sponsoredExpiry } = await seedFoundation(auth, db);
    const adminToken = await signIn(admin.email);
    await testSponsoredLifecycle(auth, db, adminToken, sponsoredExpiry);
    await testIndividualLifecycle(auth, db, adminToken);
    console.log('PASS: sponsored and individual licence lifecycles completed against local emulators.');
  } finally {
    await deleteApp(app);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
