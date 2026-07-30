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
  ROLES,
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
  selectEmailInvitation,
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
const ADMIN_LIST_LIMIT = 100;

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

async function requirePlatformAdmin(request) {
  const auth = requireVerifiedEmail(request);
  if (auth.token.role !== 'platformAdmin') fail('permission-denied', 'Platform administrator required');
  const snapshot = await db.doc(`users/${auth.uid}`).get();
  if (!snapshot.exists) fail('permission-denied', 'Administrator profile not active');
  const profile = snapshot.data();
  if (profile.accountStatus !== 'active' || profile.role !== 'platformAdmin') {
    fail('permission-denied', 'Administrator profile not active');
  }
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

function timestampIso(value) {
  const millis = timestampMillis(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

async function recordAdminEvent(auth, action, targetType, targetId, details = {}) {
  assertNoClaimContent(details);
  await db.collection('auditLogs').add({
    actorId: auth.uid,
    actorRole: 'platformAdmin',
    action,
    targetType,
    targetId: String(targetId).slice(0, 254),
    details,
    timestamp: FieldValue.serverTimestamp()
  });
}

function serializeUser(snapshot) {
  const user = snapshot.data();
  return {
    uid: snapshot.id,
    email: user.email,
    displayName: user.displayName || '',
    organizationId: user.organizationId,
    role: user.role,
    accountStatus: user.accountStatus,
    createdAt: timestampIso(user.createdAt),
    updatedAt: timestampIso(user.updatedAt)
  };
}

function serializeInvitation(snapshot) {
  const invitation = snapshot.data();
  const expired = invitation.status === 'pending'
    && timestampMillis(invitation.expiresAt) < Date.now();
  return {
    invitationId: snapshot.id,
    email: invitation.email,
    organizationId: invitation.organizationId,
    role: invitation.role,
    status: expired ? 'expired' : invitation.status,
    expiresAt: timestampIso(invitation.expiresAt),
    createdAt: timestampIso(invitation.createdAt),
    acceptedAt: timestampIso(invitation.acceptedAt),
    acceptedBy: invitation.acceptedBy || null,
    replacedBy: invitation.replacedBy || null
  };
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
    const auth = await requirePlatformAdmin(request);
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
    await recordAdminEvent(auth, 'organization.created', 'organization', organizationId, {
      name,
      maximumUsers
    });
    return { organizationId };
  } catch (error) {
    translateValidation(error);
  }
});

exports.inviteUser = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
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
    await recordAdminEvent(auth, 'invitation.created', 'invitation', hash, {
      email,
      organizationId,
      role
    });
    return { token, invitationId: hash, expiresInSeconds: INVITATION_LIFETIME_MS / 1000 };
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

// New onboarding model: the administrator authorizes an email address and the
// verified owner of that address claims the invitation. The secret-token
// endpoint above remains available during the 1.10.0 compatibility window,
// but new clients never ask a user to enter or re-enter a token.
exports.completeInvitationOnboarding = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'completeInvitationOnboarding', 10, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['displayName'], ['displayName']);
    const displayName = requiredString(data.displayName, 'displayName', 120);
    const authenticatedEmail = normalizedEmail(auth.token.email);
    const invitationsSnapshot = await db.collection('invitations')
      .where('email', '==', authenticatedEmail)
      .limit(ADMIN_LIST_LIMIT)
      .get();
    const selectedInvitation = selectEmailInvitation(
      invitationsSnapshot.docs.map(snapshot => ({
        snapshot,
        status: snapshot.data().status,
        acceptedBy: snapshot.data().acceptedBy || null,
        expiresAtMs: timestampMillis(snapshot.data().expiresAt),
        createdAtMs: timestampMillis(snapshot.data().createdAt)
      })),
      auth.uid
    );
    const invitationSnapshot = selectedInvitation?.snapshot || null;
    const userReference = db.doc(`users/${auth.uid}`);
    const invitationReference = invitationSnapshot?.ref || null;
    let onboarding;
    let accountStatus = 'invited';
    let alreadyAccepted = false;

    await db.runTransaction(async transaction => {
      const userSnapshot = await transaction.get(userReference);
      if (userSnapshot.exists) {
        const user = userSnapshot.data();
        if (user.email !== authenticatedEmail) {
          fail('failed-precondition', 'Existing user profile does not match authenticated email');
        }
        onboarding = user;
        accountStatus = user.accountStatus;
        alreadyAccepted = true;
        return;
      }
      if (!invitationReference) {
        fail('not-found', 'No active invitation exists for this verified email');
      }
      const currentInvitationSnapshot = await transaction.get(invitationReference);
      if (!currentInvitationSnapshot.exists) fail('not-found', 'Invitation not found');
      const invitation = currentInvitationSnapshot.data();
      const acceptedForSameCaller = invitation.status === 'accepted'
        && invitation.acceptedBy === auth.uid
        && invitation.email === authenticatedEmail;
      if (!acceptedForSameCaller) {
        if (invitation.status !== 'pending') fail('failed-precondition', 'Invitation is no longer active');
        if (timestampMillis(invitation.expiresAt) < Date.now()) fail('deadline-exceeded', 'Invitation expired');
        if (invitation.email !== authenticatedEmail) fail('permission-denied', 'Invitation email does not match');
      } else {
        alreadyAccepted = true;
      }
      onboarding = invitation;
      transaction.create(userReference, {
        email: authenticatedEmail,
        displayName,
        organizationId: invitation.organizationId,
        role: invitation.role,
        accountStatus: 'invited',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(acceptedForSameCaller ? { recoveredAt: FieldValue.serverTimestamp() } : {})
      });
      if (!acceptedForSameCaller) {
        transaction.update(invitationReference, {
          status: 'accepted',
          acceptedAt: FieldValue.serverTimestamp(),
          acceptedBy: auth.uid
        });
      }
    });
    await getAuth().setCustomUserClaims(auth.uid, {
      organizationId: onboarding.organizationId,
      role: onboarding.role,
      accountStatus
    });
    return {
      status: accountStatus === 'active' ? 'active' : 'accepted',
      activationRequired: accountStatus !== 'active',
      alreadyAccepted
    };
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
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'activateUser', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid', 'email']);
    const uid = await resolveUid(resolveActivationTarget(data));
    const reference = db.doc(`users/${uid}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'User not found');
    const user = snapshot.data();
    const [organizationSnapshot, licenceSnapshot, organizationUsers] = await Promise.all([
      db.doc(`organizations/${user.organizationId}`).get(),
      db.doc(`licences/${user.organizationId}`).get(),
      db.collection('users').where('organizationId', '==', user.organizationId).get()
    ]);
    if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
      fail('failed-precondition', 'Organization is not active');
    }
    if (!licenceSnapshot.exists || licenceSnapshot.data().status !== 'active') {
      fail('failed-precondition', 'Licence is not active');
    }
    const maximumUsers = boundedInteger(licenceSnapshot.data().maximumUsers, 'maximumUsers', 1, 500);
    const activeUsers = organizationUsers.docs.filter(document =>
      document.id !== uid && document.data().accountStatus === 'active'
    ).length;
    if (activeUsers >= maximumUsers) fail('resource-exhausted', 'Licence user limit reached');
    await reference.update({ accountStatus: 'active', updatedAt: FieldValue.serverTimestamp() });
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'active'
    });
    await getAuth().updateUser(uid, { disabled: false });
    await recordAdminEvent(auth, 'user.activated', 'user', uid, {
      email: user.email,
      organizationId: user.organizationId
    });
    return { uid, accountStatus: 'active' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.suspendUser = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'suspendUser', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid'], ['uid']);
    const uid = safeDocumentId(data.uid, 'uid');
    if (uid === auth.uid) fail('failed-precondition', 'You cannot suspend your own administrator account');
    await db.doc(`users/${uid}`).update({
      accountStatus: 'suspended',
      updatedAt: FieldValue.serverTimestamp()
    });
    await getAuth().revokeRefreshTokens(uid);
    await getAuth().updateUser(uid, { disabled: true });
    const user = (await db.doc(`users/${uid}`).get()).data();
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'suspended'
    });
    await recordAdminEvent(auth, 'user.suspended', 'user', uid, {
      email: user.email,
      organizationId: user.organizationId
    });
    return { uid, accountStatus: 'suspended' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.activateLicence = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'activateLicence', 30, 60 * 60 * 1000);
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
    await recordAdminEvent(auth, 'licence.activated', 'licence', organizationId, {
      maximumUsers,
      termDays
    });
    return { organizationId, status: 'active', termDays };
  } catch (error) {
    translateValidation(error);
  }
});

exports.suspendLicence = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'suspendLicence', 30, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId'], ['organizationId']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    await db.doc(`licences/${organizationId}`).update({
      status: 'suspended',
      updatedAt: FieldValue.serverTimestamp()
    });
    await recordAdminEvent(auth, 'licence.suspended', 'licence', organizationId);
    return { organizationId, status: 'suspended' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listUsers = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listUsers', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId']);
    const organizationId = data.organizationId === undefined
      ? null
      : safeDocumentId(data.organizationId, 'organizationId');
    const snapshot = await db.collection('users').limit(ADMIN_LIST_LIMIT).get();
    const users = snapshot.docs
      .map(serializeUser)
      .filter(user => !organizationId || user.organizationId === organizationId)
      .sort((left, right) => left.email.localeCompare(right.email));
    return { users, limit: ADMIN_LIST_LIMIT, truncated: snapshot.size === ADMIN_LIST_LIMIT };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listInvitations = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listInvitations', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId']);
    const organizationId = data.organizationId === undefined
      ? null
      : safeDocumentId(data.organizationId, 'organizationId');
    const snapshot = await db.collection('invitations').limit(ADMIN_LIST_LIMIT).get();
    const invitations = snapshot.docs
      .map(serializeInvitation)
      .filter(invitation => !organizationId || invitation.organizationId === organizationId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return { invitations, limit: ADMIN_LIST_LIMIT, truncated: snapshot.size === ADMIN_LIST_LIMIT };
  } catch (error) {
    translateValidation(error);
  }
});

exports.revokeInvitation = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'revokeInvitation', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['invitationId'], ['invitationId']);
    const invitationId = safeDocumentId(data.invitationId, 'invitationId');
    const reference = db.doc(`invitations/${invitationId}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'Invitation not found');
    if (snapshot.data().status !== 'pending') {
      fail('failed-precondition', 'Only pending invitations can be revoked');
    }
    await reference.update({
      status: 'revoked',
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: auth.uid
    });
    await recordAdminEvent(auth, 'invitation.revoked', 'invitation', invitationId, {
      email: snapshot.data().email
    });
    return { invitationId, status: 'revoked' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.replaceInvitation = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'replaceInvitation', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['invitationId'], ['invitationId']);
    const invitationId = safeDocumentId(data.invitationId, 'invitationId');
    const oldReference = db.doc(`invitations/${invitationId}`);
    const token = invitationToken();
    const replacementId = tokenHash(token);
    const replacementReference = db.doc(`invitations/${replacementId}`);
    let invitation;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(oldReference);
      if (!snapshot.exists) fail('not-found', 'Invitation not found');
      invitation = snapshot.data();
      if (invitation.status !== 'pending') {
        fail('failed-precondition', 'Only pending invitations can be replaced');
      }
      transaction.update(oldReference, {
        status: 'replaced',
        replacedAt: FieldValue.serverTimestamp(),
        replacedBy: replacementId
      });
      transaction.create(replacementReference, {
        email: invitation.email,
        organizationId: invitation.organizationId,
        role: invitation.role,
        status: 'pending',
        expiresAt: Timestamp.fromMillis(Date.now() + INVITATION_LIFETIME_MS),
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.uid,
        replaces: invitationId
      });
    });
    await recordAdminEvent(auth, 'invitation.replaced', 'invitation', invitationId, {
      replacementId,
      email: invitation.email
    });
    return {
      token,
      invitationId: replacementId,
      email: invitation.email,
      expiresInSeconds: INVITATION_LIFETIME_MS / 1000
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.changeUserRole = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'changeUserRole', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid', 'role'], ['uid', 'role']);
    const uid = safeDocumentId(data.uid, 'uid');
    const role = enumValue(data.role, 'role', ROLES);
    if (uid === auth.uid) fail('failed-precondition', 'You cannot change your own administrator role');
    const reference = db.doc(`users/${uid}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'User not found');
    const user = snapshot.data();
    if (user.accountStatus === 'deleted') fail('failed-precondition', 'Deleted users cannot change role');
    await reference.update({ role, updatedAt: FieldValue.serverTimestamp() });
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role,
      accountStatus: user.accountStatus
    });
    await getAuth().revokeRefreshTokens(uid);
    await recordAdminEvent(auth, 'user.role_changed', 'user', uid, {
      fromRole: user.role,
      toRole: role,
      organizationId: user.organizationId
    });
    return { uid, role };
  } catch (error) {
    translateValidation(error);
  }
});

exports.deleteUserAccount = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'deleteUserAccount', 20, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid', 'confirmEmail'], ['uid', 'confirmEmail']);
    const uid = safeDocumentId(data.uid, 'uid');
    const confirmEmail = normalizedEmail(data.confirmEmail);
    if (uid === auth.uid) fail('failed-precondition', 'You cannot delete your own administrator account');
    const reference = db.doc(`users/${uid}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'User not found');
    const user = snapshot.data();
    if (normalizedEmail(user.email) !== confirmEmail) fail('failed-precondition', 'Confirmation email does not match');
    await getAuth().updateUser(uid, { disabled: true });
    await getAuth().revokeRefreshTokens(uid);
    await reference.update({
      email: `deleted-${uid}@redacted.invalid`,
      displayName: '',
      accountStatus: 'deleted',
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    await recordAdminEvent(auth, 'user.deleted', 'user', uid, {
      organizationId: user.organizationId
    });
    await getAuth().deleteUser(uid);
    return { uid, accountStatus: 'deleted' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.updateOrganization = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'updateOrganization', 30, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'name', 'maximumUsers', 'status'], ['organizationId']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const updates = { updatedAt: FieldValue.serverTimestamp() };
    if (data.name !== undefined) updates.name = requiredString(data.name, 'name', 160);
    if (data.maximumUsers !== undefined) {
      updates.maximumUsers = boundedInteger(data.maximumUsers, 'maximumUsers', 1, 500);
    }
    if (data.status !== undefined) {
      updates.status = enumValue(data.status, 'status', ORGANIZATION_STATUSES);
    }
    if (Object.keys(updates).length === 1) fail('invalid-argument', 'At least one change is required');
    const reference = db.doc(`organizations/${organizationId}`);
    if (!(await reference.get()).exists) fail('not-found', 'Organization not found');
    await reference.update(updates);
    await recordAdminEvent(auth, 'organization.updated', 'organization', organizationId, {
      changedFields: Object.keys(updates).filter(key => key !== 'updatedAt')
    });
    return { organizationId, updated: true };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listOrganizations = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listOrganizations', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, []);
    const snapshot = await db.collection('organizations').limit(ADMIN_LIST_LIMIT).get();
    return {
      organizations: snapshot.docs.map(document => {
        const organization = document.data();
        return {
          organizationId: document.id,
          name: organization.name,
          status: organization.status,
          plan: organization.plan,
          maximumUsers: organization.maximumUsers,
          createdAt: timestampIso(organization.createdAt),
          updatedAt: timestampIso(organization.updatedAt)
        };
      }).sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
      limit: ADMIN_LIST_LIMIT,
      truncated: snapshot.size === ADMIN_LIST_LIMIT
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listAuditEvents = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listAuditEvents', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, []);
    const snapshot = await db.collection('auditLogs')
      .orderBy('timestamp', 'desc')
      .limit(ADMIN_LIST_LIMIT)
      .get();
    return {
      events: snapshot.docs.map(document => {
        const event = document.data();
        return {
          eventId: document.id,
          actorId: event.actorId || event.userId || null,
          organizationId: event.organizationId || null,
          action: event.action,
          result: event.result || null,
          targetType: event.targetType || null,
          targetId: event.targetId || null,
          details: event.details || null,
          timestamp: timestampIso(event.timestamp)
        };
      }),
      limit: ADMIN_LIST_LIMIT,
      truncated: snapshot.size === ADMIN_LIST_LIMIT
    };
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
