'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, serverTimestamp, setDoc } = require('firebase/firestore');

let environment;

test.before(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'claimextension-test',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    }
  });
});

test.beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const firestore = context.firestore();
    await setDoc(doc(firestore, 'organizations/org-a'), {
      name: 'Organization A',
      status: 'active',
      plan: 'fixed-pilot',
      maximumUsers: 50
    });
    await setDoc(doc(firestore, 'users/user-a'), {
      email: 'a@example.test',
      organizationId: 'org-a',
      role: 'processor',
      accountStatus: 'active'
    });
    await setDoc(doc(firestore, 'users/user-b'), {
      email: 'b@example.test',
      organizationId: 'org-b',
      role: 'processor',
      accountStatus: 'active'
    });
    await setDoc(doc(firestore, 'licences/org-a'), { status: 'active' });
    await setDoc(doc(firestore, 'auditLogs/log-a'), { action: 'preview_created' });
    await setDoc(doc(firestore, 'rateLimits/user-a_extensionEvent'), { count: 1 });
    await setDoc(doc(firestore, 'appConfig/production'), {
      minimumSupportedVersion: '1.6.0',
      maintenanceMode: false,
      aiEnabled: false
    });
  });
});

test.after(async () => {
  await environment.cleanup();
});

test('unauthenticated access is denied', async () => {
  const firestore = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(firestore, 'appConfig/production')));
  await assertFails(getDoc(doc(firestore, 'users/user-a')));
});

test('users read only their own profile and organization', async () => {
  const firestore = environment.authenticatedContext('user-a', {
    organizationId: 'org-a',
    role: 'processor'
  }).firestore();
  await assertSucceeds(getDoc(doc(firestore, 'users/user-a')));
  await assertFails(getDoc(doc(firestore, 'users/user-b')));
  await assertSucceeds(getDoc(doc(firestore, 'organizations/org-a')));
  await assertFails(getDoc(doc(firestore, 'organizations/org-b')));
});

test('processors cannot write protected profiles, licences, audit logs or rate limits', async () => {
  const firestore = environment.authenticatedContext('user-a', {
    organizationId: 'org-a',
    role: 'processor'
  }).firestore();
  await assertFails(setDoc(doc(firestore, 'users/user-a'), { accountStatus: 'active' }));
  await assertFails(setDoc(doc(firestore, 'organizations/org-a'), { status: 'suspended' }));
  await assertFails(getDoc(doc(firestore, 'licences/org-a')));
  await assertFails(setDoc(doc(firestore, 'licences/org-a'), { status: 'active' }));
  await assertFails(getDoc(doc(firestore, 'auditLogs/log-a')));
  await assertFails(setDoc(doc(firestore, 'auditLogs/new-log'), { action: 'preview_created' }));
  await assertFails(getDoc(doc(firestore, 'rateLimits/user-a_extensionEvent')));
  await assertFails(setDoc(doc(firestore, 'rateLimits/user-a_extensionEvent'), { count: 0 }));
});

test('own settings accept only the allowlisted schema', async () => {
  const firestore = environment.authenticatedContext('user-a', {
    organizationId: 'org-a',
    role: 'processor'
  }).firestore();
  const reference = doc(firestore, 'userSettings/user-a');
  await assertSucceeds(setDoc(reference, {
    extensionPreferences: { auditMode: 'flag', claimToolsEnabled: true },
    enabledFeatures: { claimAssistance: true, packageAudit: true },
    lastSyncedAt: serverTimestamp()
  }));
  await assertFails(setDoc(reference, {
    extensionPreferences: { auditMode: 'flag', claimToolsEnabled: true },
    enabledFeatures: { claimAssistance: true, packageAudit: true },
    patientName: 'forbidden',
    lastSyncedAt: serverTimestamp()
  }));
  const otherReference = doc(firestore, 'userSettings/user-b');
  await assertFails(setDoc(otherReference, {
    extensionPreferences: { auditMode: 'flag', claimToolsEnabled: true },
    enabledFeatures: { claimAssistance: true, packageAudit: true },
    lastSyncedAt: serverTimestamp()
  }));
});

test('authenticated users can read non-executable app configuration', async () => {
  const firestore = environment.authenticatedContext('user-a', {
    organizationId: 'org-a',
    role: 'processor'
  }).firestore();
  const snapshot = await assertSucceeds(getDoc(doc(firestore, 'appConfig/production')));
  assert.equal(snapshot.data().aiEnabled, false);
});
