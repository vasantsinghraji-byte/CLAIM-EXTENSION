#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-claimextension';

const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp, deleteApp } = functionsRequire('firebase-admin/app');
const { getAuth } = functionsRequire('firebase-admin/auth');
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore');

const ADMIN_EMAIL = 'admin@claim-spark.local';
const ADMIN_PASSWORD = 'LocalAdmin!2026';
const USER_EMAIL = 'individual@claim-spark.local';
const USER_PASSWORD = 'LocalUser!2026';

async function upsertUser(auth, email, password, displayName) {
  let user;
  try {
    user = await auth.getUserByEmail(email);
    user = await auth.updateUser(user.uid, { password, displayName, emailVerified: true, disabled: false });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({ email, password, displayName, emailVerified: true });
  }
  return user;
}

async function main() {
  const app = initializeApp({ projectId: 'demo-claimextension' });
  try {
    const auth = getAuth(app);
    const db = getFirestore(app);
    const admin = await upsertUser(auth, ADMIN_EMAIL, ADMIN_PASSWORD, 'Local Platform Admin');
    const individual = await upsertUser(auth, USER_EMAIL, USER_PASSWORD, 'Local Individual User');
    const now = Date.now();
    const defaultLicense = {
      type: 'individual', status: 'inactive', durationWeeks: 0,
      activatedAt: null, expiresAt: null, organizationId: null,
      paymentStatus: 'not_required', paymentReference: null,
      paymentProvider: 'upi', requestedDurationWeeks: null, paymentAmount: null,
      verifiedBy: null, verifiedAt: null
    };

    await Promise.all([
      auth.setCustomUserClaims(admin.uid, {
        organizationId: 'platform', role: 'platformAdmin', accountStatus: 'active'
      }),
      auth.setCustomUserClaims(individual.uid, {
        organizationId: 'platform', role: 'processor', accountStatus: 'invited'
      }),
      db.doc('organizations/platform').set({
        name: 'Local Platform', status: 'active', plan: 'fixed-pilot',
        accessType: 'organization-sponsored', maximumUsers: 5,
        createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
      }),
      db.doc(`users/${admin.uid}`).set({
        email: ADMIN_EMAIL, displayName: 'Local Platform Admin', organizationId: 'platform',
        role: 'platformAdmin', accountStatus: 'active', onboardingSource: 'emulator-seed',
        license: {
          ...defaultLicense,
          type: 'organisation',
          status: 'active',
          durationWeeks: 12,
          organizationId: 'platform',
          activatedAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(now + 12 * 7 * 24 * 60 * 60 * 1000)
        },
        createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
      }),
      db.doc(`users/${individual.uid}`).set({
        email: USER_EMAIL, displayName: 'Local Individual User', organizationId: 'platform',
        role: 'processor', accountStatus: 'invited', onboardingSource: 'self-registration',
        license: defaultLicense,
        createdAt: Timestamp.fromMillis(now), updatedAt: Timestamp.fromMillis(now)
      }),
      db.doc('licences/platform').set({
        organizationId: 'platform', accessType: 'organization-sponsored', status: 'active',
        startDate: Timestamp.fromMillis(now), expiryDate: Timestamp.fromMillis(now + 90 * 24 * 60 * 60 * 1000),
        maximumUsers: 5, monthlyAiLimit: 0, updatedAt: Timestamp.fromMillis(now)
      }),
      db.doc('appConfig/production').set({
        minimumSupportedVersion: '0.0.0', maintenanceMode: false, aiEnabled: false
      })
    ]);

    console.log('Local emulator data seeded.');
    console.log(`Admin: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
    console.log(`Pending individual: ${USER_EMAIL} / ${USER_PASSWORD}`);
  } finally {
    await deleteApp(app);
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
