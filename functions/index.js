'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, Timestamp, getFirestore } = require('firebase-admin/firestore');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const {
  ACCOUNT_STATUSES,
  DEFAULT_LICENSE,
  EVENT_ACTIONS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  LICENSE_STATUSES,
  LICENSE_TYPES,
  ORGANIZATION_STATUSES,
  PAYMENT_STATUSES,
  ROLES,
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  callableData,
  compareSemanticVersions,
  computeLicenseExpiry,
  enumValue,
  invitationToken,
  individualPlan,
  licenceAccessDecision,
  normalizedEmail,
  normalizedPaymentReference,
  requiredString,
  resolveActivationTarget,
  rosterDocumentId,
  safeDocumentId,
  selectEmailInvitation,
  tokenHash
} = require('./lib/contracts');
const {
  FEEDBACK_CATEGORIES,
  SCHEMA_VERSION: PROCESSING_RULE_SCHEMA_VERSION,
  normalizeRule: normalizeProcessingRule,
  normalizeRuleSet: normalizeProcessingRuleSet,
  runScenarios: runProcessingRuleScenarios
} = require('./lib/processing-rules');

initializeApp();
const db = getFirestore();
const REGION = 'asia-south1';
const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;
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
const USER_LIST_LIMIT = 500;
const SELF_SERVICE_ORGANIZATION_ID = 'platform';
const SELF_SERVICE_ROLE = 'processor';

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

async function recordProcessingRuleHistory(auth, action, targetId, details = {}) {
  assertNoClaimContent(details);
  await db.collection('processingRuleHistory').add({
    actorId: auth.uid,
    actorRole: 'platformAdmin',
    action,
    targetId: String(targetId).slice(0, 128),
    details,
    timestamp: FieldValue.serverTimestamp()
  });
  await recordAdminEvent(auth, action, 'processingRule', targetId, details);
}

function processingRuleVersion(snapshot) {
  const value = snapshot.data();
  return {
    versionId: snapshot.id,
    schemaVersion: value.schemaVersion,
    checksum: value.checksum,
    ruleCount: Array.isArray(value.rules) ? value.rules.length : 0,
    createdAt: timestampIso(value.createdAt),
    createdBy: value.createdBy || null,
    bundledFallbackEnabled: value.bundledFallbackEnabled !== false
  };
}

function processingRuleDraft(snapshot) {
  const value = snapshot.data();
  return {
    ruleId: value.ruleId,
    name: value.name,
    description: value.description || '',
    schemaVersion: value.schemaVersion,
    processingArea: value.processingArea,
    enabled: value.enabled,
    priority: value.priority,
    enforcement: value.enforcement,
    conditions: value.conditions,
    actions: value.actions,
    scenarios: value.scenarios || []
  };
}

function ruleImpact(previousRules, nextRules) {
  const previous = new Map((previousRules || []).map(rule => [rule.ruleId, rule]));
  const next = new Map((nextRules || []).map(rule => [rule.ruleId, rule]));
  const added = [...next.keys()].filter(id => !previous.has(id));
  const removed = [...previous.keys()].filter(id => !next.has(id));
  const modified = [...next.keys()].filter(id => previous.has(id)
    && JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id)));
  const highImpact = [...new Set([...next.keys(), ...previous.keys()])].filter(ruleId => {
    const rule = next.get(ruleId);
    const old = previous.get(ruleId);
    if (!rule) return old.actions.some(action => ['applyDeduction', 'excludePackage'].includes(action.type))
      || old.enforcement === 'blocking';
    if (old && JSON.stringify(old) === JSON.stringify(rule)) return false;
    return rule.enforcement === 'blocking'
      || (old?.enforcement === 'advisory' && rule.enforcement !== 'advisory')
      || [...(old?.actions || []), ...rule.actions].some(action => ['applyDeduction', 'excludePackage'].includes(action.type));
  });
  const dualApproval = [...new Set([...next.keys(), ...previous.keys()])].filter(ruleId => {
    const old = previous.get(ruleId);
    const rule = next.get(ruleId);
    if (old && rule && JSON.stringify(old) === JSON.stringify(rule)) return false;
    return [...(old?.actions || []), ...(rule?.actions || [])]
      .some(action => ['applyDeduction', 'excludePackage'].includes(action.type));
  });
  return { added, modified, removed, highImpact, dualApproval };
}

function approvalRecord(snapshot) {
  const value = snapshot.data();
  return {
    approvalId: snapshot.id,
    status: value.status,
    requestedBy: value.requestedBy,
    requestedAt: timestampIso(value.requestedAt),
    expiresAt: timestampIso(value.expiresAt),
    reviewedBy: value.reviewedBy || null,
    reviewedAt: timestampIso(value.reviewedAt),
    checksum: value.checksum,
    activeVersionId: value.activeVersionId || '',
    bundledFallbackEnabled: value.bundledFallbackEnabled !== false,
    impact: value.impact || {},
    kind: value.kind || 'publish',
    targetVersionId: value.targetVersionId || null
  };
}

function scenarioPublicationCheck(normalized, impact, bundledFallbackEnabled) {
  const report = runProcessingRuleScenarios(normalized.rules);
  const rulesById = new Map(normalized.rules.map(rule => [rule.ruleId, rule]));
  const requiredIds = new Set(impact.highImpact);
  if (!bundledFallbackEnabled) {
    for (const rule of normalized.rules.filter(item => item.enabled)) requiredIds.add(rule.ruleId);
  }
  const covered = new Set(report.results
    .filter(result => result.passed && (rulesById.get(result.ruleId)?.enabled
      ? result.actual.matchedRuleIds.includes(result.ruleId)
      : !result.actual.matchedRuleIds.includes(result.ruleId)))
    .map(result => result.ruleId));
  const missingRuleIds = [...requiredIds].filter(ruleId => !covered.has(ruleId));
  return { ...report, requiredRuleIds: [...requiredIds], missingRuleIds, publishable: report.passed && missingRuleIds.length === 0 };
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
    license: user.license || DEFAULT_LICENSE,
    onboardingSource: user.onboardingSource || 'invitation',
    pendingApproval: user.accountStatus === 'invited',
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
    accountStatus: user.accountStatus,
    license: user.license || DEFAULT_LICENSE
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
    const license = user.license;
    if (!license || !LICENSE_TYPES.includes(license.type)) {
      return { status: 'unlicensed', previewAllowed: false, applyAllowed: false };
    }
    const now = Date.now();
    const userExpiryMs = timestampMillis(license.expiresAt);
    if (license.status === 'inactive') {
      return {
        status: license.type === 'individual' && license.paymentStatus === 'pending_verification'
          ? 'payment-pending'
          : 'inactive',
        licenseType: license.type,
        paymentStatus: license.paymentStatus,
        previewAllowed: false,
        applyAllowed: false
      };
    }
    const configSnapshot = await db.doc('appConfig/production').get();
    const config = configSnapshot.exists ? configSnapshot.data() : {};
    const minimumVersion = configSnapshot.exists
      ? String(config.minimumSupportedVersion || '0.0.0')
      : '0.0.0';
    if (config.maintenanceMode === true) {
      return { status: 'maintenance', previewAllowed: false, applyAllowed: false, minimumVersion };
    }
    if (compareSemanticVersions(extensionVersion, minimumVersion) < 0) {
      return { status: 'update-required', previewAllowed: false, applyAllowed: false, minimumVersion };
    }
    const userAccess = licenceAccessDecision({
      status: license.status,
      expiryMs: userExpiryMs,
      now,
      gracePeriodMs: GRACE_PERIOD_MS
    });
    let access = userAccess;
    let expiryMs = userExpiryMs;
    if (license.type === 'organisation') {
      const [organizationSnapshot, licenceSnapshot] = await Promise.all([
        db.doc(`organizations/${user.organizationId}`).get(),
        db.doc(`licences/${user.organizationId}`).get()
      ]);
      if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
        return { status: 'suspended', previewAllowed: false, applyAllowed: false, minimumVersion };
      }
      if (!licenceSnapshot.exists) {
        return { status: 'unlicensed', previewAllowed: false, applyAllowed: false, minimumVersion };
      }
      const organisationLicence = licenceSnapshot.data();
      const organisationExpiryMs = timestampMillis(organisationLicence.expiryDate);
      const organisationAccess = licenceAccessDecision({
        status: organisationLicence.status,
        expiryMs: organisationExpiryMs,
        now,
        gracePeriodMs: GRACE_PERIOD_MS
      });
      if (!userAccess.applyAllowed || !organisationAccess.applyAllowed) {
        access = !userAccess.previewAllowed || !organisationAccess.previewAllowed
          ? { status: userAccess.status === 'active' ? organisationAccess.status : userAccess.status, previewAllowed: false, applyAllowed: false }
          : { status: 'grace', previewAllowed: true, applyAllowed: false };
      }
      expiryMs = Math.min(userExpiryMs, organisationExpiryMs);
    }
    if (access.status === 'active') {
      return {
        ...access,
        licenseType: license.type,
        paymentStatus: license.paymentStatus,
        expiringSoon: expiryMs - now <= EXPIRING_SOON_MS,
        expiresAt: new Date(expiryMs).toISOString(),
        minimumVersion,
        checkedVersion: extensionVersion
      };
    }
    if (access.status === 'grace') {
      return {
        ...access,
        licenseType: license.type,
        paymentStatus: license.paymentStatus,
        expiresAt: new Date(expiryMs).toISOString(),
        graceEndsAt: new Date(expiryMs + GRACE_PERIOD_MS).toISOString(),
        minimumVersion
      };
    }
    return {
      ...access,
      licenseType: license.type,
      paymentStatus: license.paymentStatus,
      expiresAt: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null,
      minimumVersion
    };
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

exports.getActiveProcessingRules = onCall(callableOptions, async request => {
  try {
    const data = callableData(request);
    assertKeys(data, ['knownVersionId', 'extensionVersion', 'supportedRuleSchemaVersions'], ['extensionVersion']);
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'processingRules', 240, 60 * 60 * 1000);
    await activeUser(auth.uid);
    requiredString(data.extensionVersion, 'extensionVersion', 32);
    const supported = data.supportedRuleSchemaVersions === undefined
      ? []
      : data.supportedRuleSchemaVersions;
    if (!Array.isArray(supported) || supported.some(value => !Number.isSafeInteger(value))) {
      fail('invalid-argument', 'supportedRuleSchemaVersions is invalid');
    }
    const [stateSnapshot, appConfigSnapshot] = await Promise.all([
      db.doc('processingRuleState/active').get(),
      db.doc('appConfig/production').get()
    ]);
    const configuredMode = appConfigSnapshot.exists
      ? String(appConfigSnapshot.data().processingRulesMode || '')
      : '';
    const mode = configuredMode || (stateSnapshot.exists ? 'remote-required' : 'bundled');
    if (!stateSnapshot.exists) {
      if (mode === 'remote-required') fail('failed-precondition', 'No active processing rule set');
      return { mode, unchanged: true, versionId: '', schemaVersion: PROCESSING_RULE_SCHEMA_VERSION, checksum: '' };
    }
    const state = stateSnapshot.data();
    const versionId = safeDocumentId(state.versionId, 'versionId');
    if (!supported.includes(Number(state.schemaVersion))) {
      fail('failed-precondition', 'Extension does not support the active processing rule schema');
    }
    if (data.knownVersionId && String(data.knownVersionId) === versionId) {
      return { mode, unchanged: true, versionId, schemaVersion: state.schemaVersion, checksum: state.checksum };
    }
    const versionSnapshot = await db.doc(`processingRuleSets/${versionId}`).get();
    if (!versionSnapshot.exists) fail('failed-precondition', 'Active processing rule set is unavailable');
    const version = versionSnapshot.data();
    return {
      mode,
      unchanged: false,
      versionId,
      schemaVersion: version.schemaVersion,
      checksum: version.checksum,
      bundledFallbackEnabled: version.bundledFallbackEnabled !== false,
      rules: version.rules
    };
  } catch (error) {
    translateValidation(error);
  }
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
            license: { ...DEFAULT_LICENSE, type: 'organisation', organizationId: invitation.organizationId },
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
        license: { ...DEFAULT_LICENSE, type: 'organisation', organizationId: invitation.organizationId },
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

// Verified processors can register without an invitation, but remain pending
// until a platform administrator approves them. Invitations remain
// authoritative for users assigned a different organization or elevated role.
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
    const registrationAuditReference = db.collection('auditLogs').doc();
    let onboarding;
    let accountStatus = 'invited';
    let alreadyAccepted = false;

    function createRegistrationAudit(transaction, organizationId, onboardingSource) {
      transaction.create(registrationAuditReference, {
        actorId: auth.uid,
        actorRole: 'processor',
        action: 'user.registration_requested',
        targetType: 'user',
        targetId: auth.uid,
        details: { organizationId, onboardingSource },
        timestamp: FieldValue.serverTimestamp()
      });
    }

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
        const organizationReference = db.doc(`organizations/${SELF_SERVICE_ORGANIZATION_ID}`);
        const organizationSnapshot = await transaction.get(organizationReference);
        if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
          fail('failed-precondition', 'Registration organization is not active');
        }
        onboarding = {
          organizationId: SELF_SERVICE_ORGANIZATION_ID,
          role: SELF_SERVICE_ROLE
        };
        transaction.create(userReference, {
          email: authenticatedEmail,
          displayName,
          organizationId: SELF_SERVICE_ORGANIZATION_ID,
          role: SELF_SERVICE_ROLE,
          accountStatus: 'invited',
          license: { ...DEFAULT_LICENSE },
          onboardingSource: 'self-registration',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        createRegistrationAudit(transaction, SELF_SERVICE_ORGANIZATION_ID, 'self-registration');
        return;
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
        license: { ...DEFAULT_LICENSE, type: 'organisation', organizationId: invitation.organizationId },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(acceptedForSameCaller ? { recoveredAt: FieldValue.serverTimestamp() } : {})
      });
      createRegistrationAudit(transaction, invitation.organizationId, 'invitation');
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

exports.completeOrganizationSponsoredOnboarding = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'organizationSponsoredOnboarding', 10, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'employeeCode', 'displayName'], ['organizationId', 'employeeCode', 'displayName']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const employeeCode = safeDocumentId(String(data.employeeCode).toUpperCase(), 'employeeCode');
    const displayName = requiredString(data.displayName, 'displayName', 120);
    const authenticatedEmail = normalizedEmail(auth.token.email);
    const rosterId = rosterDocumentId(organizationId, employeeCode);
    const organizationReference = db.doc(`organizations/${organizationId}`);
    const rosterReference = db.doc(`orgRoster/${rosterId}`);
    const userReference = db.doc(`users/${auth.uid}`);
    const auditReference = db.collection('auditLogs').doc();
    let role;
    let accountStatus = 'invited';
    let alreadyCompleted = false;

    await db.runTransaction(async transaction => {
      const [organizationSnapshot, rosterSnapshot, userSnapshot] = await Promise.all([
        transaction.get(organizationReference),
        transaction.get(rosterReference),
        transaction.get(userReference)
      ]);
      if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
        fail('failed-precondition', 'Organization is not active');
      }
      if (!rosterSnapshot.exists) fail('not-found', 'Employee code is not registered');
      const roster = rosterSnapshot.data();
      role = enumValue(roster.role, 'role', INVITABLE_ROLES);
      if (userSnapshot.exists) {
        const user = userSnapshot.data();
        if (user.email !== authenticatedEmail || user.organizationId !== organizationId
            || user.onboardingSource !== 'organisation-roster') {
          fail('failed-precondition', 'Existing user profile belongs to a different onboarding path');
        }
        if (roster.status !== 'claimed' || roster.claimedByUid !== auth.uid) {
          fail('failed-precondition', 'Employee code is not assigned to this user');
        }
        role = user.role;
        accountStatus = user.accountStatus;
        alreadyCompleted = true;
        return;
      }
      if (roster.status !== 'available' || roster.email !== authenticatedEmail) {
        fail('permission-denied', 'Sponsorship credentials are invalid');
      }
      transaction.create(userReference, {
        email: authenticatedEmail,
        displayName,
        organizationId,
        role,
        accountStatus: 'invited',
        onboardingSource: 'organisation-roster',
        employeeCode,
        license: { ...DEFAULT_LICENSE, type: 'organisation', organizationId },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(rosterReference, {
        status: 'claimed',
        claimedByUid: auth.uid,
        claimedAt: FieldValue.serverTimestamp()
      });
      transaction.create(auditReference, {
        actorId: auth.uid,
        actorRole: role,
        action: 'user.registration_requested',
        targetType: 'user',
        targetId: auth.uid,
        details: { organizationId, onboardingSource: 'organisation-roster' },
        timestamp: FieldValue.serverTimestamp()
      });
    });
    await getAuth().setCustomUserClaims(auth.uid, { organizationId, role, accountStatus });
    return {
      status: accountStatus === 'active' ? 'active' : 'accepted',
      activationRequired: accountStatus !== 'active',
      alreadyCompleted
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
    if (user.accountStatus === 'deleted') fail('failed-precondition', 'Deleted users cannot be activated');
    await db.runTransaction(async transaction => {
      const organizationReference = db.doc(`organizations/${user.organizationId}`);
      const licenceReference = db.doc(`licences/${user.organizationId}`);
      const activeUsersQuery = db.collection('users')
        .where('organizationId', '==', user.organizationId)
        .where('accountStatus', '==', 'active');
      const [latestUser, organizationSnapshot, licenceSnapshot, activeUsers] = await Promise.all([
        transaction.get(reference),
        transaction.get(organizationReference),
        transaction.get(licenceReference),
        transaction.get(activeUsersQuery)
      ]);
      if (!latestUser.exists || latestUser.data().accountStatus === 'deleted') {
        fail('failed-precondition', 'User cannot be activated');
      }
      if (!organizationSnapshot.exists || organizationSnapshot.data().status !== 'active') {
        fail('failed-precondition', 'Organization is not active');
      }
      if (!licenceSnapshot.exists || licenceSnapshot.data().status !== 'active'
          || timestampMillis(licenceSnapshot.data().expiryDate) < Date.now()) {
        fail('failed-precondition', 'Licence is not active');
      }
      const maximumUsers = boundedInteger(licenceSnapshot.data().maximumUsers, 'maximumUsers', 1, 500);
      const alreadyActive = activeUsers.docs.some(document => document.id === uid);
      if (!alreadyActive && activeUsers.size >= maximumUsers) {
        fail('resource-exhausted', 'Licence user limit reached');
      }
      const updates = { accountStatus: 'active', updatedAt: FieldValue.serverTimestamp() };
      const latestLicense = latestUser.data().license;
      // Initial approval inherits the organisation entitlement. Reactivating an
      // account must not undo an independent per-user licence deactivation.
      if (latestLicense?.type === 'organisation'
          && latestUser.data().accountStatus === 'invited') {
        const now = Date.now();
        const expiryMs = timestampMillis(licenceSnapshot.data().expiryDate);
        const durationWeeks = Math.max(1, Math.ceil((expiryMs - now) / (7 * 24 * 60 * 60 * 1000)));
        updates.license = {
          ...DEFAULT_LICENSE,
          ...latestLicense,
          type: 'organisation',
          status: 'active',
          durationWeeks,
          activatedAt: Timestamp.fromMillis(now),
          expiresAt: licenceSnapshot.data().expiryDate,
          organizationId: user.organizationId,
          paymentStatus: 'not_required'
        };
      }
      transaction.update(reference, updates);
    });
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'active'
    });
    await getAuth().updateUser(uid, { disabled: false });
    const auditAction = user.accountStatus === 'invited'
      ? 'user.registration_approved'
      : 'user.reactivated';
    await recordAdminEvent(auth, auditAction, 'user', uid, {
      email: user.email,
      organizationId: user.organizationId,
      previousStatus: user.accountStatus
    });
    return { uid, accountStatus: 'active' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.addRosterEntry = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'addRosterEntry', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'employeeCode', 'email', 'role'], ['organizationId', 'employeeCode', 'email', 'role']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const employeeCode = safeDocumentId(String(data.employeeCode).toUpperCase(), 'employeeCode');
    const email = normalizedEmail(data.email);
    const role = enumValue(data.role, 'role', INVITABLE_ROLES);
    const organization = await db.doc(`organizations/${organizationId}`).get();
    if (!organization.exists || organization.data().status !== 'active') {
      fail('failed-precondition', 'Organization is not active');
    }
    const rosterId = rosterDocumentId(organizationId, employeeCode);
    const reference = db.doc(`orgRoster/${rosterId}`);
    let created = true;
    await db.runTransaction(async transaction => {
      const existing = await transaction.get(reference);
      if (existing.exists) {
        if (existing.data().status !== 'available') {
          fail('failed-precondition', 'Claimed roster entries cannot be reassigned');
        }
        created = false;
        transaction.update(reference, {
          email,
          role,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: auth.uid
        });
        return;
      }
      transaction.create(reference, {
        organizationId,
        employeeCode,
        email,
        role,
        status: 'available',
        claimedByUid: null,
        claimedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.uid
      });
    });
    await recordAdminEvent(auth, created ? 'roster.entry_added' : 'roster.entry_updated', 'orgRoster', rosterId, {
      organizationId,
      employeeCode,
      email,
      role
    });
    return { rosterId, organizationId, employeeCode, email, role, status: 'available', created };
  } catch (error) {
    translateValidation(error);
  }
});

exports.bulkAddRosterEntries = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'bulkAddRosterEntries', 10, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'entries'], ['organizationId', 'entries']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > 100) {
      fail('invalid-argument', 'entries must contain between 1 and 100 roster records');
    }
    const entries = data.entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('invalid-argument', `entries[${index}] is invalid`);
      }
      assertKeys(entry, ['employeeCode', 'email', 'role'], ['employeeCode', 'email', 'role']);
      const employeeCode = safeDocumentId(String(entry.employeeCode).toUpperCase(), `entries[${index}].employeeCode`);
      return {
        employeeCode,
        email: normalizedEmail(entry.email),
        role: enumValue(entry.role, `entries[${index}].role`, INVITABLE_ROLES),
        rosterId: rosterDocumentId(organizationId, employeeCode)
      };
    });
    if (new Set(entries.map(entry => entry.rosterId)).size !== entries.length) {
      fail('invalid-argument', 'CSV contains duplicate employee codes');
    }
    const organization = await db.doc(`organizations/${organizationId}`).get();
    if (!organization.exists || organization.data().status !== 'active') {
      fail('failed-precondition', 'Organization is not active');
    }
    let created = 0;
    let updated = 0;
    await db.runTransaction(async transaction => {
      const references = entries.map(entry => db.doc(`orgRoster/${entry.rosterId}`));
      const snapshots = await Promise.all(references.map(reference => transaction.get(reference)));
      snapshots.forEach((snapshot, index) => {
        const entry = entries[index];
        const reference = references[index];
        if (snapshot.exists) {
          if (snapshot.data().status !== 'available') {
            fail('failed-precondition', `Claimed roster entry cannot be reassigned: ${entry.employeeCode}`);
          }
          updated += 1;
          transaction.update(reference, {
            email: entry.email,
            role: entry.role,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: auth.uid
          });
        } else {
          created += 1;
          transaction.create(reference, {
            organizationId,
            employeeCode: entry.employeeCode,
            email: entry.email,
            role: entry.role,
            status: 'available',
            claimedByUid: null,
            claimedAt: null,
            createdAt: FieldValue.serverTimestamp(),
            createdBy: auth.uid
          });
        }
      });
    });
    await recordAdminEvent(auth, 'roster.bulk_imported', 'organization', organizationId, {
      organizationId,
      submitted: entries.length,
      created,
      updated
    });
    return { organizationId, submitted: entries.length, created, updated };
  } catch (error) {
    translateValidation(error);
  }
});

exports.removeRosterEntry = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'removeRosterEntry', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId', 'employeeCode'], ['organizationId', 'employeeCode']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const employeeCode = safeDocumentId(String(data.employeeCode).toUpperCase(), 'employeeCode');
    const rosterId = rosterDocumentId(organizationId, employeeCode);
    const reference = db.doc(`orgRoster/${rosterId}`);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) fail('not-found', 'Roster entry not found');
      if (snapshot.data().status === 'claimed') {
        fail('failed-precondition', 'Claimed roster entries cannot be removed; suspend the resulting user instead');
      }
      transaction.delete(reference);
    });
    await recordAdminEvent(auth, 'roster.entry_removed', 'orgRoster', rosterId, {
      organizationId,
      employeeCode
    });
    return { rosterId, removed: true };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listRoster = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listRoster', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['organizationId'], ['organizationId']);
    const organizationId = safeDocumentId(data.organizationId, 'organizationId');
    const snapshot = await db.collection('orgRoster')
      .where('organizationId', '==', organizationId)
      .limit(ADMIN_LIST_LIMIT)
      .get();
    return {
      entries: snapshot.docs.map(document => {
        const entry = document.data();
        return {
          rosterId: document.id,
          organizationId: entry.organizationId,
          employeeCode: entry.employeeCode,
          email: entry.email,
          role: entry.role,
          status: entry.status,
          claimedByUid: entry.claimedByUid || null,
          claimedAt: timestampIso(entry.claimedAt),
          createdAt: timestampIso(entry.createdAt)
        };
      }).sort((left, right) => left.employeeCode.localeCompare(right.employeeCode)),
      limit: ADMIN_LIST_LIMIT,
      truncated: snapshot.size === ADMIN_LIST_LIMIT
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.rejectUserRegistration = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'rejectUserRegistration', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid'], ['uid']);
    const uid = safeDocumentId(data.uid, 'uid');
    if (uid === auth.uid) fail('failed-precondition', 'You cannot reject your own administrator account');
    const reference = db.doc(`users/${uid}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'User not found');
    const user = snapshot.data();
    if (user.accountStatus !== 'invited') {
      fail('failed-precondition', 'Only pending registrations can be rejected');
    }
    await getAuth().setCustomUserClaims(uid, {
      organizationId: user.organizationId,
      role: user.role,
      accountStatus: 'rejected'
    });
    await getAuth().revokeRefreshTokens(uid);
    await getAuth().updateUser(uid, { disabled: true });
    await reference.update({
      accountStatus: 'rejected',
      rejectedAt: FieldValue.serverTimestamp(),
      rejectedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp()
    });
    await recordAdminEvent(auth, 'user.registration_rejected', 'user', uid, {
      email: user.email,
      organizationId: user.organizationId
    });
    return { uid, accountStatus: 'rejected' };
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
    const organization = await db.doc(`organizations/${organizationId}`).get();
    if (!organization.exists) fail('not-found', 'Organization not found');
    const now = Date.now();
    await db.doc(`licences/${organizationId}`).set({
      organizationId,
      status: 'active',
      startDate: Timestamp.fromMillis(now),
      expiryDate: Timestamp.fromMillis(now + termDays * 24 * 60 * 60 * 1000),
      termDays,
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
    let query = db.collection('users');
    if (organizationId) query = query.where('organizationId', '==', organizationId);
    const snapshot = await query.limit(USER_LIST_LIMIT).get();
    const users = snapshot.docs
      .map(serializeUser)
      .sort((left, right) => left.email.localeCompare(right.email));
    return {
      users,
      pendingCount: users.filter(user => user.pendingApproval).length,
      limit: USER_LIST_LIMIT,
      truncated: snapshot.size === USER_LIST_LIMIT
    };
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
    let query = db.collection('invitations');
    if (organizationId) query = query.where('organizationId', '==', organizationId);
    const snapshot = await query.limit(ADMIN_LIST_LIMIT).get();
    const invitations = snapshot.docs
      .map(serializeInvitation)
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

exports.setUserLicense = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'setUserLicense', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid', 'action', 'durationWeeks'], ['uid', 'action']);
    const uid = safeDocumentId(data.uid, 'uid');
    const action = enumValue(data.action, 'action', ['activate', 'deactivate', 'extend']);
    const durationWeeks = action === 'deactivate'
      ? null
      : boundedInteger(data.durationWeeks, 'durationWeeks', 1, 52);
    const reference = db.doc(`users/${uid}`);
    const now = Date.now();
    let auditDetails;
    let resultLicense;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) fail('not-found', 'User not found');
      const user = snapshot.data();
      if (user.accountStatus === 'deleted') fail('failed-precondition', 'Deleted users cannot hold a license');
      const current = { ...DEFAULT_LICENSE, ...(user.license || {}) };
      const legacyActiveIndividual = current.type === 'individual'
        && current.status === 'active'
        && current.paymentStatus === 'not_required';
      if (current.type === 'individual' && action !== 'deactivate'
          && current.paymentStatus !== 'verified' && !legacyActiveIndividual) {
        fail('failed-precondition', 'Individual payment must be verified before license activation');
      }
      if (current.type === 'individual' && action !== 'deactivate' && current.requestedDurationWeeks
          && durationWeeks !== current.requestedDurationWeeks) {
        fail('failed-precondition', 'License duration must match the verified individual plan');
      }
      const currentExpiryMs = timestampMillis(current.expiresAt);
      if (current.type === 'individual' && action === 'activate' && current.status === 'active'
          && Number.isFinite(currentExpiryMs) && currentExpiryMs > now) {
        fail('failed-precondition', 'Use Extend license to preserve the remaining individual licence term');
      }
      let next;
      if (action === 'activate') {
        const expiresAtMs = computeLicenseExpiry(durationWeeks, now);
        next = {
          ...current,
          status: 'active',
          durationWeeks,
          activatedAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(expiresAtMs)
        };
      } else if (action === 'extend') {
        const from = Number.isFinite(currentExpiryMs) && currentExpiryMs > now ? currentExpiryMs : now;
        const expiresAtMs = computeLicenseExpiry(durationWeeks, from);
        next = {
          ...current,
          status: 'active',
          durationWeeks: boundedInteger(current.durationWeeks || 0, 'license.durationWeeks', 0, 5200) + durationWeeks,
          activatedAt: current.activatedAt || Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(expiresAtMs)
        };
      } else {
        next = { ...current, status: 'inactive' };
      }
      transaction.update(reference, { license: next, updatedAt: FieldValue.serverTimestamp() });
      const expiresAtMs = timestampMillis(next.expiresAt);
      auditDetails = {
        action,
        fromStatus: current.status,
        toStatus: next.status,
        durationWeeks: next.durationWeeks,
        expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null
      };
      resultLicense = {
        ...next,
        activatedAt: timestampIso(next.activatedAt),
        expiresAt: timestampIso(next.expiresAt),
        verifiedAt: timestampIso(next.verifiedAt)
      };
    });
    await recordAdminEvent(auth, 'user.license_updated', 'user', uid, auditDetails);
    return { uid, license: resultLicense };
  } catch (error) {
    translateValidation(error);
  }
});

exports.submitPaymentProof = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'submitPaymentProof', 5, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['paymentReference', 'durationWeeks'], ['paymentReference', 'durationWeeks']);
    const paymentReference = normalizedPaymentReference(data.paymentReference);
    const plan = individualPlan(data.durationWeeks);
    const userReference = db.doc(`users/${auth.uid}`);
    const paymentClaimReference = db.doc(`paymentClaims/${tokenHash(paymentReference)}`);
    const auditReference = db.collection('auditLogs').doc();
    await db.runTransaction(async transaction => {
      const [snapshot, paymentClaim] = await Promise.all([
        transaction.get(userReference),
        transaction.get(paymentClaimReference)
      ]);
      if (!snapshot.exists) fail('not-found', 'Complete individual onboarding before submitting payment');
      const user = snapshot.data();
      if (user.accountStatus === 'deleted') fail('failed-precondition', 'Deleted users cannot submit payment');
      const current = { ...DEFAULT_LICENSE, ...(user.license || {}) };
      if (current.type !== 'individual') fail('failed-precondition', 'Payment proof is only accepted for individual access');
      if (current.paymentStatus === 'pending_verification') fail('failed-precondition', 'A payment reference is already waiting for verification');
      const currentExpiryMs = timestampMillis(current.expiresAt);
      if (current.paymentStatus === 'verified' && current.status === 'active'
          && Number.isFinite(currentExpiryMs) && currentExpiryMs - Date.now() > EXPIRING_SOON_MS) {
        fail('failed-precondition', 'Renewal opens seven days before license expiry');
      }
      if (paymentClaim.exists && paymentClaim.data().uid !== auth.uid) {
        fail('already-exists', 'Payment reference was already submitted');
      }
      if (!paymentClaim.exists) {
        transaction.create(paymentClaimReference, {
          uid: auth.uid,
          submittedAt: FieldValue.serverTimestamp()
        });
      }
      transaction.update(userReference, {
        license: {
          ...current,
          paymentStatus: 'pending_verification',
          paymentReference,
          paymentProvider: 'upi',
          requestedDurationWeeks: plan.durationWeeks,
          paymentAmount: plan.price
        },
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.create(auditReference, {
        actorId: auth.uid,
        actorRole: user.role,
        action: 'user.payment_submitted',
        targetType: 'user',
        targetId: auth.uid,
        details: {
          paymentProvider: 'upi',
          durationWeeks: plan.durationWeeks,
          paymentAmount: plan.price
        },
        timestamp: FieldValue.serverTimestamp()
      });
    });
    return {
      paymentStatus: 'pending_verification',
      durationWeeks: plan.durationWeeks,
      paymentAmount: plan.price
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.verifyUserPayment = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'verifyUserPayment', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['uid', 'verified', 'reason'], ['uid', 'verified']);
    const uid = safeDocumentId(data.uid, 'uid');
    if (typeof data.verified !== 'boolean') fail('invalid-argument', 'verified must be a boolean');
    const reason = data.reason === undefined ? '' : requiredString(data.reason, 'reason', 300);
    const reference = db.doc(`users/${uid}`);
    let paymentStatus;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) fail('not-found', 'User not found');
      const user = snapshot.data();
      const current = { ...DEFAULT_LICENSE, ...(user.license || {}) };
      if (current.type !== 'individual') fail('failed-precondition', 'User does not have an individual license');
      if (!current.paymentReference) fail('failed-precondition', 'User has not submitted a payment reference');
      paymentStatus = data.verified ? 'verified' : 'pending_verification';
      transaction.update(reference, {
        license: {
          ...current,
          paymentStatus,
          verifiedBy: data.verified ? auth.uid : null,
          verifiedAt: data.verified ? FieldValue.serverTimestamp() : null
        },
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    await recordAdminEvent(
      auth,
      data.verified ? 'user.payment_verified' : 'user.payment_verification_declined',
      'user',
      uid,
      { paymentStatus, reason: reason || null }
    );
    return { uid, paymentStatus };
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

exports.listProcessingRuleDrafts = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listProcessingRuleDrafts', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, []);
    const snapshot = await db.collection('processingRuleDrafts').orderBy('priority').limit(1000).get();
    return { rules: snapshot.docs.map(processingRuleDraft) };
  } catch (error) {
    translateValidation(error);
  }
});

exports.saveProcessingRuleDraft = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'saveProcessingRuleDraft', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['rule'], ['rule']);
    const rule = normalizeProcessingRule(data.rule);
    const reference = db.doc(`processingRuleDrafts/${rule.ruleId}`);
    const existing = await reference.get();
    await reference.set({
      ...rule,
      createdAt: existing.exists ? existing.data().createdAt : FieldValue.serverTimestamp(),
      createdBy: existing.exists ? existing.data().createdBy : auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid
    });
    await recordProcessingRuleHistory(auth, existing.exists ? 'processing_rule_draft_updated' : 'processing_rule_draft_created', rule.ruleId, {
      enabled: rule.enabled,
      priority: rule.priority,
      processingArea: rule.processingArea,
      enforcement: rule.enforcement
    });
    return { rule };
  } catch (error) {
    translateValidation(error);
  }
});

exports.setProcessingRuleStatus = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'setProcessingRuleStatus', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['ruleId', 'enabled'], ['ruleId', 'enabled']);
    const ruleId = safeDocumentId(String(data.ruleId).toUpperCase(), 'ruleId');
    if (typeof data.enabled !== 'boolean') fail('invalid-argument', 'enabled must be boolean');
    const reference = db.doc(`processingRuleDrafts/${ruleId}`);
    if (!(await reference.get()).exists) fail('not-found', 'Processing rule draft not found');
    await reference.update({ enabled: data.enabled, updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid });
    await recordProcessingRuleHistory(auth, data.enabled ? 'processing_rule_enabled' : 'processing_rule_disabled', ruleId, {});
    return { ruleId, enabled: data.enabled };
  } catch (error) {
    translateValidation(error);
  }
});

async function draftRuleSetAndImpact() {
  const [draftSnapshot, activeState] = await Promise.all([
    db.collection('processingRuleDrafts').orderBy('priority').limit(1000).get(),
    db.doc('processingRuleState/active').get()
  ]);
  const normalized = normalizeProcessingRuleSet(draftSnapshot.docs.map(processingRuleDraft));
  let previousRules = [];
  let activeVersionId = '';
  if (activeState.exists && activeState.data().versionId) {
    activeVersionId = String(activeState.data().versionId);
    const activeVersion = await db.doc(`processingRuleSets/${activeVersionId}`).get();
    if (activeVersion.exists && Array.isArray(activeVersion.data().rules)) previousRules = activeVersion.data().rules;
  }
  const impact = ruleImpact(previousRules, normalized.rules);
  return { normalized, impact, activeVersionId };
}

exports.validateProcessingRuleDrafts = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'validateProcessingRuleDrafts', 120, 60 * 60 * 1000);
    assertKeys(callableData(request), ['bundledFallbackEnabled']);
    const { normalized, impact, activeVersionId } = await draftRuleSetAndImpact();
    const bundledFallbackEnabled = callableData(request).bundledFallbackEnabled !== false;
    const scenarios = scenarioPublicationCheck(normalized, impact, bundledFallbackEnabled);
    return {
      valid: true,
      schemaVersion: normalized.schemaVersion,
      checksum: normalized.checksum,
      ruleCount: normalized.rules.length,
      activeVersionId,
      impact,
      scenarios
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.publishProcessingRuleDrafts = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'publishProcessingRuleDrafts', 20, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['confirmHighImpact', 'bundledFallbackEnabled'], ['bundledFallbackEnabled']);
    if (typeof data.bundledFallbackEnabled !== 'boolean') fail('invalid-argument', 'bundledFallbackEnabled must be boolean');
    const { normalized, impact, activeVersionId } = await draftRuleSetAndImpact();
    const scenarios = scenarioPublicationCheck(normalized, impact, data.bundledFallbackEnabled);
    const dualApprovalRequired = impact.dualApproval.length > 0 || data.bundledFallbackEnabled === false;
    if (dualApprovalRequired && !scenarios.publishable) {
      fail('failed-precondition', `Passing synthetic scenarios are required for: ${scenarios.missingRuleIds.join(', ') || 'all high-impact rules'}`);
    }
    const publishedChecksum = `${normalized.checksum}:${data.bundledFallbackEnabled ? 'fallback' : 'central'}`;
    if (dualApprovalRequired) {
      const approvalReference = db.collection('processingRuleApprovals').doc();
      await approvalReference.create({
        kind: 'publish',
        status: 'pending',
        checksum: publishedChecksum,
        activeVersionId,
        bundledFallbackEnabled: data.bundledFallbackEnabled,
        impact,
        scenarioSummary: { total: scenarios.total, requiredRuleIds: scenarios.requiredRuleIds },
        requestedAt: FieldValue.serverTimestamp(),
        requestedBy: auth.uid,
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
        reviewedAt: null,
        reviewedBy: null
      });
      await recordProcessingRuleHistory(auth, 'processing_rule_approval_requested', approvalReference.id, {
        checksum: publishedChecksum,
        changedRuleIds: [...new Set([...impact.added, ...impact.modified, ...impact.removed])],
        bundledFallbackEnabled: data.bundledFallbackEnabled
      });
      return { approvalRequired: true, approval: approvalRecord(await approvalReference.get()), impact, scenarios };
    }
    const versionReference = db.collection('processingRuleSets').doc();
    const stateReference = db.doc('processingRuleState/active');
    await db.runTransaction(async transaction => {
      const latestState = await transaction.get(stateReference);
      const latestVersionId = latestState.exists ? String(latestState.data().versionId || '') : '';
      if (latestVersionId !== activeVersionId) fail('aborted', 'Active rule version changed; validate again');
      transaction.create(versionReference, {
        schemaVersion: normalized.schemaVersion,
        checksum: publishedChecksum,
        rules: normalized.rules,
        bundledFallbackEnabled: data.bundledFallbackEnabled,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.uid
      });
      transaction.set(stateReference, {
        versionId: versionReference.id,
        schemaVersion: normalized.schemaVersion,
        checksum: publishedChecksum,
        bundledFallbackEnabled: data.bundledFallbackEnabled,
        publishedAt: FieldValue.serverTimestamp(),
        publishedBy: auth.uid
      });
    });
    await recordProcessingRuleHistory(auth, 'processing_rule_set_published', versionReference.id, {
      fromVersionId: activeVersionId,
      checksum: publishedChecksum,
      ruleCount: normalized.rules.length,
      bundledFallbackEnabled: data.bundledFallbackEnabled,
      changedRuleIds: [...new Set([...impact.added, ...impact.modified, ...impact.removed])]
    });
    return { approvalRequired: false, ...processingRuleVersion(await versionReference.get()), impact, scenarios };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listProcessingRuleApprovals = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listProcessingRuleApprovals', 120, 60 * 60 * 1000);
    assertKeys(callableData(request), []);
    const snapshot = await db.collection('processingRuleApprovals').orderBy('requestedAt', 'desc').limit(50).get();
    return { approvals: snapshot.docs.map(approvalRecord) };
  } catch (error) {
    translateValidation(error);
  }
});

exports.approveProcessingRulePublication = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'approveProcessingRulePublication', 20, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['approvalId'], ['approvalId']);
    const approvalId = safeDocumentId(data.approvalId, 'approvalId');
    const approvalReference = db.doc(`processingRuleApprovals/${approvalId}`);
    const approvalSnapshot = await approvalReference.get();
    if (!approvalSnapshot.exists) fail('not-found', 'Processing-rule approval request not found');
    const approval = approvalSnapshot.data();
    if (approval.status !== 'pending') fail('failed-precondition', 'Approval request is no longer pending');
    if (approval.requestedBy === auth.uid) fail('permission-denied', 'A different platform administrator must approve this publication');
    if (timestampMillis(approval.expiresAt) <= Date.now()) fail('failed-precondition', 'Approval request has expired');
    if (approval.kind === 'activation') {
      const targetReference = db.doc(`processingRuleSets/${safeDocumentId(approval.targetVersionId, 'targetVersionId')}`);
      const targetSnapshot = await targetReference.get();
      if (!targetSnapshot.exists || targetSnapshot.data().checksum !== approval.checksum) fail('aborted', 'Target rule version changed or is unavailable');
      const stateReference = db.doc('processingRuleState/active');
      await db.runTransaction(async transaction => {
        const [latestApproval, latestState] = await Promise.all([transaction.get(approvalReference), transaction.get(stateReference)]);
        if (!latestApproval.exists || latestApproval.data().status !== 'pending') fail('aborted', 'Approval request is no longer pending');
        const latestVersionId = latestState.exists ? String(latestState.data().versionId || '') : '';
        if (latestVersionId !== approval.activeVersionId) fail('aborted', 'Active rule version changed; request approval again');
        transaction.set(stateReference, {
          versionId: targetSnapshot.id,
          schemaVersion: targetSnapshot.data().schemaVersion,
          checksum: targetSnapshot.data().checksum,
          bundledFallbackEnabled: targetSnapshot.data().bundledFallbackEnabled !== false,
          publishedAt: FieldValue.serverTimestamp(),
          publishedBy: approval.requestedBy,
          approvedBy: auth.uid
        });
        transaction.update(approvalReference, {
          status: 'approved', reviewedAt: FieldValue.serverTimestamp(), reviewedBy: auth.uid, versionId: targetSnapshot.id
        });
      });
      await recordProcessingRuleHistory(auth, 'processing_rule_activation_approved', targetSnapshot.id, {
        approvalId, requestedBy: approval.requestedBy, fromVersionId: approval.activeVersionId
      });
      return { ...processingRuleVersion(targetSnapshot), approvalId };
    }
    const { normalized, impact, activeVersionId } = await draftRuleSetAndImpact();
    const scenarios = scenarioPublicationCheck(normalized, impact, approval.bundledFallbackEnabled !== false);
    const checksum = `${normalized.checksum}:${approval.bundledFallbackEnabled === false ? 'central' : 'fallback'}`;
    if (checksum !== approval.checksum || activeVersionId !== approval.activeVersionId) fail('aborted', 'Rules or active version changed; request approval again');
    if (!scenarios.publishable) fail('failed-precondition', 'Synthetic scenarios must still pass before approval');
    const versionReference = db.collection('processingRuleSets').doc();
    const stateReference = db.doc('processingRuleState/active');
    await db.runTransaction(async transaction => {
      const [latestApproval, latestState] = await Promise.all([
        transaction.get(approvalReference), transaction.get(stateReference)
      ]);
      if (!latestApproval.exists || latestApproval.data().status !== 'pending') fail('aborted', 'Approval request is no longer pending');
      const latestVersionId = latestState.exists ? String(latestState.data().versionId || '') : '';
      if (latestVersionId !== activeVersionId) fail('aborted', 'Active rule version changed; request approval again');
      transaction.create(versionReference, {
        schemaVersion: normalized.schemaVersion,
        checksum,
        rules: normalized.rules,
        bundledFallbackEnabled: approval.bundledFallbackEnabled !== false,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: approval.requestedBy,
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy: auth.uid,
        approvalId
      });
      transaction.set(stateReference, {
        versionId: versionReference.id,
        schemaVersion: normalized.schemaVersion,
        checksum,
        bundledFallbackEnabled: approval.bundledFallbackEnabled !== false,
        publishedAt: FieldValue.serverTimestamp(),
        publishedBy: approval.requestedBy,
        approvedBy: auth.uid
      });
      transaction.update(approvalReference, {
        status: 'approved', reviewedAt: FieldValue.serverTimestamp(), reviewedBy: auth.uid, versionId: versionReference.id
      });
    });
    await recordProcessingRuleHistory(auth, 'processing_rule_publication_approved', versionReference.id, {
      approvalId, requestedBy: approval.requestedBy, checksum
    });
    return { ...processingRuleVersion(await versionReference.get()), approvalId };
  } catch (error) {
    translateValidation(error);
  }
});

exports.rejectProcessingRulePublication = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'rejectProcessingRulePublication', 60, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['approvalId'], ['approvalId']);
    const approvalId = safeDocumentId(data.approvalId, 'approvalId');
    const reference = db.doc(`processingRuleApprovals/${approvalId}`);
    const snapshot = await reference.get();
    if (!snapshot.exists) fail('not-found', 'Processing-rule approval request not found');
    if (snapshot.data().status !== 'pending') fail('failed-precondition', 'Approval request is no longer pending');
    if (snapshot.data().requestedBy === auth.uid) fail('permission-denied', 'A different platform administrator must review this publication');
    await reference.update({ status: 'rejected', reviewedAt: FieldValue.serverTimestamp(), reviewedBy: auth.uid });
    await recordProcessingRuleHistory(auth, 'processing_rule_publication_rejected', approvalId, { requestedBy: snapshot.data().requestedBy });
    return { approvalId, status: 'rejected' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listProcessingRuleVersions = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listProcessingRuleVersions', 120, 60 * 60 * 1000);
    assertKeys(callableData(request), []);
    const [versions, active] = await Promise.all([
      db.collection('processingRuleSets').orderBy('createdAt', 'desc').limit(50).get(),
      db.doc('processingRuleState/active').get()
    ]);
    const activeVersionId = active.exists ? String(active.data().versionId || '') : '';
    return {
      activeVersionId,
      versions: versions.docs.map(document => ({ ...processingRuleVersion(document), active: document.id === activeVersionId }))
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.activateProcessingRuleVersion = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'activateProcessingRuleVersion', 20, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['versionId'], ['versionId']);
    const versionId = safeDocumentId(data.versionId, 'versionId');
    const version = await db.doc(`processingRuleSets/${versionId}`).get();
    if (!version.exists) fail('not-found', 'Published processing rule version not found');
    const previous = await db.doc('processingRuleState/active').get();
    const previousVersionId = previous.exists ? String(previous.data().versionId || '') : '';
    let previousRules = [];
    if (previousVersionId) {
      const previousVersion = await db.doc(`processingRuleSets/${previousVersionId}`).get();
      if (previousVersion.exists) previousRules = previousVersion.data().rules || [];
    }
    const impact = ruleImpact(previousRules, version.data().rules || []);
    if (impact.dualApproval.length || version.data().bundledFallbackEnabled === false) {
      const approvalReference = db.collection('processingRuleApprovals').doc();
      await approvalReference.create({
        kind: 'activation',
        targetVersionId: versionId,
        status: 'pending',
        checksum: version.data().checksum,
        activeVersionId: previousVersionId,
        bundledFallbackEnabled: version.data().bundledFallbackEnabled !== false,
        impact,
        requestedAt: FieldValue.serverTimestamp(),
        requestedBy: auth.uid,
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
        reviewedAt: null,
        reviewedBy: null
      });
      await recordProcessingRuleHistory(auth, 'processing_rule_activation_approval_requested', approvalReference.id, {
        targetVersionId: versionId, fromVersionId: previousVersionId
      });
      return { approvalRequired: true, approval: approvalRecord(await approvalReference.get()) };
    }
    await db.doc('processingRuleState/active').set({
      versionId,
      schemaVersion: version.data().schemaVersion,
      checksum: version.data().checksum,
      bundledFallbackEnabled: version.data().bundledFallbackEnabled !== false,
      publishedAt: FieldValue.serverTimestamp(),
      publishedBy: auth.uid
    });
    await recordProcessingRuleHistory(auth, 'processing_rule_version_activated', versionId, {
      fromVersionId: previousVersionId,
      rollback: previousVersionId !== ''
    });
    return { approvalRequired: false, ...processingRuleVersion(version) };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listProcessingRuleHistory = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listProcessingRuleHistory', 120, 60 * 60 * 1000);
    assertKeys(callableData(request), []);
    const snapshot = await db.collection('processingRuleHistory').orderBy('timestamp', 'desc').limit(100).get();
    return {
      events: snapshot.docs.map(document => {
        const value = document.data();
        return {
          id: document.id,
          action: value.action,
          actorId: value.actorId,
          targetId: value.targetId,
          details: value.details || {},
          timestamp: timestampIso(value.timestamp)
        };
      })
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.submitProcessingRuleFeedback = onCall(callableOptions, async request => {
  try {
    const auth = requireVerifiedEmail(request);
    await enforceRateLimit(auth.uid, 'submitProcessingRuleFeedback', 60, 60 * 60 * 1000);
    const user = await activeUser(auth.uid);
    const data = callableData(request);
    assertKeys(data, ['ruleId', 'ruleSetVersion', 'category', 'processingArea', 'packageCodes'],
      ['ruleId', 'ruleSetVersion', 'category', 'processingArea', 'packageCodes']);
    const ruleId = safeDocumentId(String(data.ruleId).toUpperCase(), 'ruleId');
    const ruleSetVersion = safeDocumentId(data.ruleSetVersion, 'ruleSetVersion');
    const category = enumValue(data.category, 'category', FEEDBACK_CATEGORIES);
    const processingArea = enumValue(data.processingArea, 'processingArea', ['OPD', 'PHARMACY', 'IPD']);
    if (!Array.isArray(data.packageCodes) || data.packageCodes.length > 20) fail('invalid-argument', 'packageCodes is invalid');
    const packageCodes = [...new Set(data.packageCodes.map(value => requiredString(value, 'packageCode', 80).toUpperCase()))];
    const reference = db.collection('processingRuleFeedback').doc();
    await reference.create({
      ruleId,
      ruleSetVersion,
      category,
      processingArea,
      packageCodes,
      organizationId: user.organizationId,
      status: 'open',
      submittedBy: auth.uid,
      submittedAt: FieldValue.serverTimestamp(),
      reviewedBy: null,
      reviewedAt: null,
      resolution: null
    });
    return { feedbackId: reference.id, status: 'open' };
  } catch (error) {
    translateValidation(error);
  }
});

exports.listProcessingRuleFeedback = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'listProcessingRuleFeedback', 120, 60 * 60 * 1000);
    assertKeys(callableData(request), []);
    const snapshot = await db.collection('processingRuleFeedback').orderBy('submittedAt', 'desc').limit(100).get();
    return {
      feedback: snapshot.docs.map(document => {
        const value = document.data();
        return {
          feedbackId: document.id,
          ruleId: value.ruleId,
          ruleSetVersion: value.ruleSetVersion,
          category: value.category,
          processingArea: value.processingArea,
          packageCodes: value.packageCodes || [],
          organizationId: value.organizationId,
          status: value.status,
          submittedBy: value.submittedBy,
          submittedAt: timestampIso(value.submittedAt),
          reviewedBy: value.reviewedBy || null,
          reviewedAt: timestampIso(value.reviewedAt),
          resolution: value.resolution || null
        };
      })
    };
  } catch (error) {
    translateValidation(error);
  }
});

exports.reviewProcessingRuleFeedback = onCall(callableOptions, async request => {
  try {
    const auth = await requirePlatformAdmin(request);
    await enforceRateLimit(auth.uid, 'reviewProcessingRuleFeedback', 120, 60 * 60 * 1000);
    const data = callableData(request);
    assertKeys(data, ['feedbackId', 'status', 'resolution'], ['feedbackId', 'status']);
    const feedbackId = safeDocumentId(data.feedbackId, 'feedbackId');
    const status = enumValue(data.status, 'status', ['under_review', 'accepted', 'rejected', 'resolved']);
    const resolution = data.resolution === undefined || data.resolution === null
      ? null
      : enumValue(data.resolution, 'resolution', ['rule_updated', 'no_change', 'duplicate', 'insufficient_information']);
    const reference = db.doc(`processingRuleFeedback/${feedbackId}`);
    if (!(await reference.get()).exists) fail('not-found', 'Processing rule feedback not found');
    await reference.update({
      status,
      resolution,
      reviewedBy: auth.uid,
      reviewedAt: FieldValue.serverTimestamp()
    });
    await recordProcessingRuleHistory(auth, 'processing_rule_feedback_reviewed', feedbackId, { status, resolution });
    return { feedbackId, status, resolution };
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
  DEFAULT_LICENSE,
  EVENT_ACTIONS,
  GRACE_PERIOD_MS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  LICENSE_STATUSES,
  LICENSE_TYPES,
  ORGANIZATION_STATUSES,
  PAYMENT_STATUSES
};
