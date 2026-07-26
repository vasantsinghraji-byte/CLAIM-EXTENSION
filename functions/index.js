'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const {
  ACCOUNT_STATUSES,
  EVENT_ACTIONS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  ORGANIZATION_STATUSES,
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  callableData,
  enumValue,
  invitationToken,
  licenceAccessDecision,
  normalizedEmail,
  requiredString,
  resolveActivationTarget,
  safeDocumentId,
  tokenHash
} = require('./lib/contracts');

initializeApp();
const db = getFirestore();
const REGION = 'asia-south1';
const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const INVITATION_LIFETIME_MS = 72 * 60 * 60 * 1000;
const callableOptions = Object.freeze({
  region: REGION,
  cors: true,
  enforceAppCheck: false,
  maxInstances: 10,
  timeoutSeconds: 30,
  memory: '256MiB'
});

function fail(code, message) {
  throw new HttpsError(code, message);
}

function translateValidation(error) {
  if (error instanceof HttpsError) throw error;
  fail('invalid-argument', String(error && error.message || 'Invalid request'));
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) fail('unauthenticated', 'Authentication required');
  return request.auth;
}

function requireVerifiedEmail(request) {
  const auth = requireAuth(request);
  if (auth.token.email_verified !== true) fail('failed-precondition', 'Verified email required');
  return auth;
}

function requirePlatformAdmin(request) {
  const auth = requireVerifiedEmail(request);
  if (auth.token.role !== 'platformAdmin') fail('permission-denied', 'Platform administrator required');
  return auth;
}

async function activeUser(uid) {
  const snapshot = await db.doc(`users/${uid}`).get();
  if (!snapshot.exists) fail('permission-denied', 'User profile not active');
  const user = snapshot.data();
  if (user.accountStatus !== 'active') fail('permission-denied', 'User account not active');
  return user;
}

function timestampMillis(value) {
  return value && typeof value.toMillis === 'function' ? value.toMillis() : NaN;
}

async function enforceRateLimit(uid, action, limit, windowMs) {
  const reference = db.doc(`rateLimits/${uid}_${action}`);
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.exists ? snapshot.data() : {};
    const windowStartedAt = timestampMillis(current.windowStartedAt);
    if (!Number.isFinite(windowStartedAt) || windowStartedAt + windowMs <= now) {
      transaction.set(reference, {
        count: 1,
        windowStartedAt: Timestamp.fromMillis(now),
        updatedAt: FieldValue.serverTimestamp()
      });
      return;
    }
    if (!Number.isSafeInteger(current.count) || current.count >= limit) {
      fail('resource-exhausted', 'Request limit exceeded');
    }
    transaction.update(reference, {
      count: current.count + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

exports.getCurrentUserProfile = onCall(callableOptions, async request => {
  const auth = requireVerifiedEmail(request);
  await enforceRateLimit(auth.uid, 'profile', 120, 60 * 60 * 1000);
  // This endpoint is also the recovery path after an invitation has been
  // accepted but before an administrator activates the account. It is safe to
  // return the caller's own profile, including its status; privileged
  // operations continue to use activeUser().
  const snapshot = await db.doc(`users/${auth.uid}`).get();
  if (!snapshot.exists) fail('not-found', 'User profile not found');
  const user = snapshot.data();
  return {
    uid: auth.uid,
    email: user.email,
    displayName: user.displayName || '',
    organizationId: user.organizationId,
    role: user.role,
    accountStatus: user.accountStatus
  };
});

exports.verifyLicence = onCall(callableOptions, async request => {
  try {
    const data = callableData(request);
    assertKeys(data, ['extensionVersion'], ['extensionVersion']);
    const extensionVersion = requiredString(data.extensionVersion, 'extensionVersion', 32);
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'licence', 120, 60 * 60 * 1000);
    const user = await activeUser(auth.uid);
    const [organizationSnapshot, licenceSnapshot, configSnapshot] = await Promise.all([
      db.doc(`organizations/${user.organizationId}`).get(),
      db.doc(`licences/${user.organizationId}`).get(),
      db.doc('appConfig/production').get()
    ]);
    if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
      return { status: 'suspended', previewAllowed: false, applyAllowed: false };
    }
    if (!licenceSnapshot.exists) {
      return { status: 'unlicensed', previewAllowed: false, applyAllowed: false };
    }
    const licence = licenceSnapshot.data();
    const expiryMs = timestampMillis(licence.expiryDate);
    const now = Date.now();
    const minimumVersion = configSnapshot.exists
      ? String(configSnapshot.data().minimumSupportedVersion || '0.0.0')
      : '0.0.0';
    const access = licenceAccessDecision({
      status: licence.status,
      expiryMs,
      now,
      gracePeriodMs: GRACE_PERIOD_MS
    });
    if (access.status === 'active') {
      return {
        ...access,
        expiresAt: new Date(expiryMs).toISOString(),
        minimumVersion,
        checkedVersion: extensionVersion
      };
    }
    if (access.status === 'grace') {
      return {
        ...access,
        graceEndsAt: new Date(expiryMs + GRACE_PERIOD_MS).toISOString(),
        minimumVersion
      };
    }
    return { ...access, minimumVersion };
  } catch (error) {
    translateValidation(error);
  }
});

exports.getExtensionConfig = onCall(callableOptions, async request => {
  const auth = requireVerifiedEmail(request);
  await enforceRateLimit(auth.uid, 'config', 120, 60 * 60 * 1000);
  const snapshot = await db.doc('appConfig/production').get();
  const config = snapshot.exists ? snapshot.data() : {};
  return {
    minimumSupportedVersion: String(config.minimumSupportedVersion || '1.6.0'),
    maintenanceMode: config.maintenanceMode === true,
    aiEnabled: false,
    supportMessage: String(config.supportMessage || '').slice(0, 500)
  };
});

exports.createOrganization = onCall(callableOptions, async request => {
  try {
    const auth = requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'createOrganization', 20, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'name', 'maximumUsers'], ['organizationId', 'name', 'maximumUsers']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const name = requiredString(data.name, 'name', 160);
    const maximumUsers = boundedInteger(data.maximumUsers, 'maximumUsers', 1, 500);
    const reference = db.doc(`organizations/${organizationId}`);
    await db.runTransaction(async transaction => {
      if ((await transaction.get(reference)).exists) fail('already-exists', 'Organization already exists');
      transaction.create(reference, {
        name,
        status: 'active',
        plan: 'fixed-pilot',
        maximumUsers,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    return { organizationId };
  } catch (error) {
    translateValidation(error);
  }
});

exports.inviteUser = onCall(callableOptions, async request => {
  try {
    const auth = requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'inviteUser', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['email', 'organizationId', 'role'], ['email', 'organizationId', 'role']);
    const email = normalizedEmail(data.email);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const role = enumValue(data.role, 'role', INVITABLE_ROLES);
    const organization = await db.doc(`organizations/${organizationId}`).get();
    if (!organization.exists || organization.data().status !== 'active') {
      fail('failed-precondition', 'Organization is not active');
    }
    const token = invitationToken();
    const hash = tokenHash(token);
    await db.doc(`invitations/${hash}`).create({
      email,
      organizationId,
      role,
      status: 'pending',
      expiresAt: Timestamp.fromMillis(Date.now() + INVITATION_LIFETIME_MS),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: request.auth.uid
    });
    return { token, expiresInSeconds: INVITATION_LIFETIME_MS / 1000 };
  } catch (error) {
    translateValidation(error);
  }
});

exports.acceptInvitation = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'acceptInvitation', 10, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['token', 'displayName'], ['token', 'displayName']);
    const hash = tokenHash(data.token);
    const displayName = requiredString(data.displayName, 'displayName', 120);
    const authenticatedEmail = normalizedEmail(auth.token.email);
    const invitationReference = db.doc(`invitations/${hash}`);
    const userReference = db.doc(`users/${auth.uid}`);
    let accepted;
    let alreadyAccepted = false;
    let acceptedAccountStatus = 'invited';
    await db.runTransaction(async transaction => {
      const [invitationSnapshot, userSnapshot] = await Promise.all([
        transaction.get(invitationReference),
        transaction.get(userReference)
      ]);
      if (!invitationSnapshot.exists) fail('not-found', 'Invitation is invalid');
      const invitation = invitationSnapshot.data();
      if (invitation.status === 'accepted'
        && invitation.acceptedBy === auth.uid
        && invitation.email === authenticatedEmail) {
        if (userSnapshot.exists && userSnapshot.data().email !== authenticatedEmail) {
          fail('failed-precondition', 'Existing user profile does not match invitation');
        }
        if (userSnapshot.exists) {
          acceptedAccountStatus = userSnapshot.data().accountStatus;
        }
        if (!userSnapshot.exists) {
          transaction.create(userReference, {
            email: authenticatedEmail,
            displayName,
            organizationId: invitation.organizationId,
            role: invitation.role,
            accountStatus: 'invited',
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            recoveredAt: FieldValue.serverTimestamp()
          });
        }
        accepted = invitation;
        alreadyAccepted = true;
        return;
      }
      if (invitation.status !== 'pending') fail('failed-precondition', 'Invitation was already used');
      if (timestampMillis(invitation.expiresAt) < Date.now()) fail('deadline-exceeded', 'Invitation expired');
      if (invitation.email !== authenticatedEmail) fail('permission-denied', 'Invitation email does not match');
      if (userSnapshot.exists) fail('already-exists', 'User profile already exists');
      accepted = invitation;
      transaction.create(userReference, {
        email: authenticatedEmail,
        displayName,
        organizationId: invitation.organizationId,
        role: invitation.role,
        accountStatus: 'invited',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(invitationReference, {
        status: 'accepted',
        acceptedAt: FieldValue.serverTimestamp(),
        acceptedBy: auth.uid
      });
    });
    await getAuth().setCustomUserClaims(auth.uid, {
      organizationId: accepted.organizationId,
      role: accepted.role,
      accountStatus: acceptedAccountStatus
    });
    return { status: 'accepted', activationRequired: true, alreadyAccepted };
  } catch (error) {
    translateValidation(error);
  }
});

async function resolveUid(target) {
  if (target.by === 'uid') return target.value;
  try {
    return (await getAuth().getUserByEmail(target.value)).uid;
  } catch {
    fail('not-found', 'No account found for that email');
  }
}

exports.activateUser = onCall(callableOptions, async request => {
  try {
    requirePlatformAdmin(request);
    const data = callableData(request);
    assertKeys(data, ['uid', 'email']);
    const uid = await resolveUid(resolveActivationTarget(data));
    const reference = db.doc(`users/${uid}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'User not found');
    const user = snapshot.data();
    await reference.update({ accountStatus: 'active', updatedAt: FieldValue.serverTimestamp() });
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'active'
    });
    return { uid, accountStatus: 'active' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.suspendUser = onCall(callableOptions, async request => {
  try {
    requirePlatformAdmin(request);
    const data = callableData(request);
    assertKeys(data, ['uid'], ['uid']);
    const uid = safeDocumentId(data.uid, 'uid');
    await db.doc(`users/${uid}`).update({
      accountStatus: 'suspended',
      updatedAt: FieldValue.serverTimestamp()
    });
    await getAuth().revokeRefreshTokens(uid);
    const user = (await db.doc(`users/${uid}`).get()).data();
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'suspended'
    });
    return { uid, accountStatus: 'suspended' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.activateLicence = onCall(callableOptions, async request => {
  try {
    requirePlatformAdmin(request);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'maximumUsers', 'termDays'], ['organizationId', 'maximumUsers']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const maximumUsers = boundedInteger(data.maximumUsers, 'maximumUsers', 1, 500);
    const termDays = data.termDays === undefined
      ? 90
      : boundedInteger(data.termDays, 'termDays', 1, 366);
    const now = Date.now();
    await db.doc(`licences/${organizationId}`).set({
      organizationId,
      status: 'active',
      startDate: Timestamp.fromMillis(now),
      expiryDate: Timestamp.fromMillis(now + termDays * 24 * 60 * 60 * 1000),
      maximumUsers,
      monthlyAiLimit: 0,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { organizationId, status: 'active', termDays };
  } catch (error) {
    translateValidation(error);
  }
});

exports.suspendLicence = onCall(callableOptions, async request => {
  try {
    requirePlatformAdmin(request);
    const data = callableData(request);
    assertKeys(data, ['organizationId'], ['organizationId']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    await db.doc(`licences/${organizationId}`).update({
      status: 'suspended',
      updatedAt: FieldValue.serverTimestamp()
    });
    return { organizationId, status: 'suspended' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.recordExtensionEvent = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'extensionEvent', 300, 60 * 60 * 1000);
    const user = await activeUser(auth.uid);
    const data = callableData(request);
    assertKeys(data, ['action', 'result', 'extensionVersion'], ['action', 'result', 'extensionVersion']);
    assertNoClaimContent(data);
    const action = enumValue(data.action, 'action', EVENT_ACTIONS);
    const result = requiredString(data.result, 'result', 40);
    const extensionVersion = requiredString(data.extensionVersion, 'extensionVersion', 32);
    await db.collection('auditLogs').add({
      userId: auth.uid,
      organizationId: user.organizationId,
      action,
      result,
      extensionVersion,
      timestamp: FieldValue.serverTimestamp()
    });
    return { recorded: true };
  } catch (error) {
    logger.warn('Rejected extension event', { reason: String(error && error.message || error) });
    translateValidation(error);
  }
});

exports._test = {
  ACCOUNT_STATUSES,
  EVENT_ACTIONS,
  GRACE_PERIOD_MS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  ORGANIZATION_STATUSES
};
