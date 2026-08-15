// Background service worker: serialized storage writer plus per-tab audit badge.

// runtime-config.js is generated from the git-ignored Firebase build config.
// It must load before auth-core.js in the service worker.
if (typeof importScripts === 'function') importScripts('runtime-config.js', 'auth-core.js', 'processing-rules.js');

const STORAGE_POLICIES = Object.freeze({
  claimActivityLog: { limit: 500, timestampField: 'timestamp', maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  rghsAuditFeedback: { limit: 2000 },
  rghsAuditLog: { limit: 2000, dedupe: true },
  claimRecoverySnapshots: { limit: 20, timestampField: 'createdAt', maxAgeMs: 24 * 60 * 60 * 1000 }
});

const FIREBASE_WEB_API_KEY = globalThis.ClaimSparkRuntimeConfig?.firebaseApiKey || '';
const FUNCTIONS_BASE_URL = globalThis.ClaimSparkRuntimeConfig?.functionsBaseUrl || '';
const LICENCE_RECHECK_ALARM = 'claimExtensionLicenceRecheck';
const PROCESSING_RULE_SCHEMA_VERSION = 2;
// How long Apply keeps trusting the last successful licence check if the
// backend is simply unreachable (not an expired/suspended licence - a
// network failure). Matches the ID token lifetime.
const LICENCE_OUTAGE_TOLERANCE_MS = 60 * 60 * 1000;

function auditLogEntryKey(entry) {
  return [entry.url, entry.tid, entry.ruleId, entry.rowNumber, entry.findingType, entry.action].join('|');
}

function storageGet(storage, key) {
  return new Promise((resolve, reject) => storage.get([key], result => {
    const error = globalThis.chrome?.runtime?.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result || {});
  }));
}

function storageSet(storage, value) {
  return new Promise((resolve, reject) => storage.set(value, () => {
    const error = globalThis.chrome?.runtime?.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}

function storageRemove(storage, key) {
  return new Promise((resolve, reject) => storage.remove(key, () => {
    const error = globalThis.chrome?.runtime?.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}

function ignoreMissingTabError() {
  // A tab can disappear between an event/message and the badge update. Reading
  // lastError in the callback consumes that expected Chrome race instead of
  // leaving a rejected Promise in the service-worker error log.
  void globalThis.chrome?.runtime?.lastError;
}

function setTabBadge(tabId, text, color) {
  if (!Number.isInteger(tabId) || !chrome.action) return;
  chrome.action.setBadgeText({ tabId, text }, ignoreMissingTabError);
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }, ignoreMissingTabError);
}

async function migrateRuleOverridesToLocal(localStorage, syncStorage) {
  const [markerResult, localResult] = await Promise.all([
    storageGet(localStorage, 'ruleOverridesMigratedToLocal'),
    storageGet(localStorage, 'ruleOverrides')
  ]);
  if (markerResult.ruleOverridesMigratedToLocal === true) return false;

  const hasLocalOverrides = Object.prototype.hasOwnProperty.call(localResult, 'ruleOverrides')
    && localResult.ruleOverrides
    && typeof localResult.ruleOverrides === 'object'
    && !Array.isArray(localResult.ruleOverrides);
  let ruleOverrides = hasLocalOverrides ? localResult.ruleOverrides : null;
  if (!ruleOverrides) {
    const syncResult = await storageGet(syncStorage, 'ruleOverrides');
    ruleOverrides = syncResult.ruleOverrides && typeof syncResult.ruleOverrides === 'object' && !Array.isArray(syncResult.ruleOverrides)
      ? syncResult.ruleOverrides
      : {};
  }
  await storageSet(localStorage, { ruleOverrides, ruleOverridesMigratedToLocal: true });
  await storageRemove(syncStorage, 'ruleOverrides');
  return true;
}

function createSerializedStorageWriter(storage, now = () => Date.now()) {
  const queues = new Map();
  const enqueue = (key, operation) => {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queues.set(key, next);
    const cleanup = () => { if (queues.get(key) === next) queues.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  };

  return {
    append(key, incoming) {
      const policy = STORAGE_POLICIES[key];
      if (!policy) return Promise.reject(new Error(`Unsupported storage append key: ${key}`));
      const entries = Array.isArray(incoming) ? incoming : [];
      return enqueue(key, async () => {
        const result = await storageGet(storage, key);
        let existing = Array.isArray(result[key]) ? result[key] : [];
        if (policy.maxAgeMs) {
          const cutoff = now() - policy.maxAgeMs;
          existing = existing.filter(item => {
            const value = item?.[policy.timestampField];
            const timestamp = typeof value === 'number' ? value : Date.parse(value);
            return Number.isFinite(timestamp) && timestamp >= cutoff;
          });
        }
        let additions = entries;
        if (policy.dedupe) {
          const seen = new Set(existing.map(auditLogEntryKey));
          additions = entries.filter(entry => {
            const id = auditLogEntryKey(entry);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
        }
        const merged = [...existing, ...additions].slice(-policy.limit);
        await storageSet(storage, { [key]: merged });
        return merged.length;
      });
    },
    removeRecoverySnapshot(id) {
      return enqueue('claimRecoverySnapshots', async () => {
        const result = await storageGet(storage, 'claimRecoverySnapshots');
        const snapshots = (Array.isArray(result.claimRecoverySnapshots) ? result.claimRecoverySnapshots : [])
          .filter(snapshot => snapshot.id !== id);
        await storageSet(storage, { claimRecoverySnapshots: snapshots });
        return snapshots.length;
      });
    },
    setRuleOverride(ruleId, autoDeductEligible) {
      return enqueue('ruleOverrides', async () => {
        const result = await storageGet(storage, 'ruleOverrides');
        const existing = result.ruleOverrides && typeof result.ruleOverrides === 'object' && !Array.isArray(result.ruleOverrides)
          ? result.ruleOverrides
          : {};
        const merged = {
          ...existing,
          [String(ruleId)]: { autoDeductEligible: autoDeductEligible === true }
        };
        await storageSet(storage, { ruleOverrides: merged });
        return Object.keys(merged).length;
      });
    },
    resetRuleOverrides() {
      return enqueue('ruleOverrides', async () => {
        await storageSet(storage, { ruleOverrides: {} });
        return 0;
      });
    },
    setCustomRuleConfig(config) {
      return enqueue('customRuleConfig', async () => {
        await storageSet(storage, { customRuleConfig: config });
        return Array.isArray(config?.rules) ? config.rules.length : 0;
      });
    },
    setProcessingRuleSet(ruleSet) {
      return enqueue('processingRuleSet', async () => {
        await storageSet(storage, { processingRuleSet: ruleSet });
        return ruleSet;
      });
    },
    setAuthSession(session) {
      return enqueue('authSession', async () => {
        await storageSet(storage, { authSession: session });
        return session;
      });
    },
    clearAuthSession() {
      return enqueue('authSession', async () => {
        await storageSet(storage, { authSession: null });
        return null;
      });
    },
    setLicenceState(state) {
      return enqueue('licenceState', async () => {
        await storageSet(storage, { licenceState: state });
        return state;
      });
    },
    setPendingAuth(pending) {
      return enqueue('pendingAuth', async () => {
        await storageSet(storage, { pendingAuth: pending });
        return pending;
      });
    },
    clearPendingAuth() {
      return enqueue('pendingAuth', async () => {
        await storageSet(storage, { pendingAuth: null });
        return null;
      });
    }
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.local && chrome.storage?.sync) {
  const storageWriter = createSerializedStorageWriter(chrome.storage.local);
  const overrideMigration = migrateRuleOverridesToLocal(chrome.storage.local, chrome.storage.sync)
    .catch(() => false);
  const AuthCore = globalThis.ClaimAuthCore;
  const ProcessingRules = globalThis.ClaimProcessingRules;

  async function handleAuthSignIn(email, password) {
    const session = await AuthCore.signInWithPassword({ apiKey: FIREBASE_WEB_API_KEY, email, password, fetchImpl: fetch });
    let profile = null;
    let requiresEmailVerification = false;
    let requiresProfileRecovery = false;
    try {
      profile = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'getCurrentUserProfile',
        idToken: session.idToken,
        data: {},
        fetchImpl: fetch
      });
    } catch (error) {
      if (error.status === 'FAILED_PRECONDITION') {
        requiresEmailVerification = true;
      } else if (error.status === 'NOT_FOUND') {
        requiresProfileRecovery = true;
      } else {
        throw error;
      }
    }
    const localSession = {
      uid: session.uid,
      email: session.email,
      displayName: profile?.displayName || session.displayName || '',
      organizationId: profile?.organizationId || null,
      role: profile?.role || null,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      signedInAt: Date.now()
    };
    if (requiresEmailVerification) {
      await storageWriter.setAuthSession(localSession);
      await storageWriter.setLicenceState({
        status: 'unverified',
        previewAllowed: false,
        applyAllowed: false,
        expiresAt: null,
        graceEndsAt: null,
        minimumVersion: null,
        checkedAt: Date.now(),
        source: 'server'
      });
      return { success: true, requiresEmailVerification: true };
    }
    if (requiresProfileRecovery) {
      const pending = {
        ...localSession,
        stage: 'complete-onboarding',
        lastError: null
      };
      const afterCompletion = pending.displayName
        ? await attemptCompleteOnboarding(pending)
        : pending;
      if (afterCompletion.stage === 'active') return { success: true };
      await storageWriter.setPendingAuth(afterCompletion);
      await Promise.all([
        storageWriter.clearAuthSession(),
        storageWriter.setLicenceState(null)
      ]);
      return afterCompletion.stage === 'awaiting-activation'
        ? { success: true, awaitingActivation: true }
        : { success: true, requiresProfileRecovery: true, error: afterCompletion.lastError };
    }
    if (profile?.accountStatus === 'invited') {
      await storageWriter.setPendingAuth({
        ...localSession,
        displayName: profile.displayName || '',
        stage: 'awaiting-activation',
        lastError: null
      });
      await Promise.all([
        storageWriter.clearAuthSession(),
        storageWriter.setLicenceState(null)
      ]);
      return { success: true, awaitingActivation: true };
    }
    await storageWriter.setAuthSession(localSession);
    await storageWriter.clearPendingAuth();
    const licence = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'verifyLicence',
      idToken: session.idToken,
      data: { extensionVersion: chrome.runtime.getManifest().version },
      fetchImpl: fetch
    });
    await storageWriter.setLicenceState({ ...licence, checkedAt: Date.now(), source: 'server' });
    if (chrome.alarms) chrome.alarms.create(LICENCE_RECHECK_ALARM, { periodInMinutes: 15 });
    refreshProcessingRules().catch(() => undefined);
    return { success: true };
  }

  async function refreshPendingIfStale(pending) {
    if (AuthCore.isTokenFresh(pending)) return pending;
    const refreshed = await AuthCore.refreshIdToken({
      apiKey: FIREBASE_WEB_API_KEY,
      refreshToken: pending.refreshToken,
      fetchImpl: fetch
    });
    const next = { ...pending, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
    await storageWriter.setPendingAuth(next);
    return next;
  }

  async function establishActiveSession(session, profile) {
    await storageWriter.setAuthSession({
      uid: session.uid,
      email: session.email,
      displayName: profile?.displayName || session.displayName || '',
      organizationId: profile?.organizationId || null,
      role: profile?.role || null,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      signedInAt: Date.now()
    });
    const licence = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'verifyLicence',
      idToken: session.idToken,
      data: { extensionVersion: chrome.runtime.getManifest().version },
      fetchImpl: fetch
    });
    await storageWriter.setLicenceState({ ...licence, checkedAt: Date.now(), source: 'server' });
    await storageWriter.clearPendingAuth();
    if (chrome.alarms) chrome.alarms.create(LICENCE_RECHECK_ALARM, { periodInMinutes: 15 });
    refreshProcessingRules().catch(() => undefined);
  }

  // Registers a verified processor for administrator approval. An explicit
  // invitation remains authoritative when one assigns another role or tenant.
  async function attemptCompleteOnboarding(pending) {
    try {
      const onboarding = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'completeInvitationOnboarding',
        idToken: pending.idToken,
        data: { displayName: pending.displayName },
        fetchImpl: fetch
      });
      const next = { ...pending, stage: 'awaiting-activation', lastError: null };
      await storageWriter.setPendingAuth(next);
      if (!onboarding.activationRequired) {
        const profile = await AuthCore.callFunction({
          functionsBaseUrl: FUNCTIONS_BASE_URL,
          name: 'getCurrentUserProfile',
          idToken: pending.idToken,
          data: {},
          fetchImpl: fetch
        });
        await establishActiveSession(pending, profile);
        return { ...pending, stage: 'active', lastError: null };
      }
      return next;
    } catch (error) {
      const next = { ...pending, stage: 'complete-onboarding', lastError: String(error.status || error.message || error) };
      await storageWriter.setPendingAuth(next);
      return next;
    }
  }

  async function handleAuthSignUp(email, password, displayName) {
    const session = await AuthCore.signUp({ apiKey: FIREBASE_WEB_API_KEY, email, password, fetchImpl: fetch });
    const normalizedDisplayName = String(displayName || '').trim();
    await AuthCore.updateProfile({
      apiKey: FIREBASE_WEB_API_KEY,
      idToken: session.idToken,
      displayName: normalizedDisplayName,
      fetchImpl: fetch
    });
    await AuthCore.sendEmailVerification({ apiKey: FIREBASE_WEB_API_KEY, idToken: session.idToken, fetchImpl: fetch });
    await storageWriter.setPendingAuth({
      uid: session.uid,
      email: session.email,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      displayName: normalizedDisplayName,
      stage: 'verify-email',
      lastError: null
    });
    return { success: true };
  }

  async function handleResendVerification() {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    await AuthCore.sendEmailVerification({ apiKey: FIREBASE_WEB_API_KEY, idToken: pending.idToken, fetchImpl: fetch });
    return { success: true };
  }

  // Email verification precedes the access-path choice. No account profile is
  // created until the user chooses organisation sponsorship or the default path.
  async function handleCheckEmailVerified() {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    let pending = await refreshPendingIfStale(pendingAuth);
    const info = await AuthCore.accountInfo({ apiKey: FIREBASE_WEB_API_KEY, idToken: pending.idToken, fetchImpl: fetch });
    if (!info.emailVerified) {
      await storageWriter.setPendingAuth(pending);
      return { success: true, emailVerified: false };
    }
    // Email verification happens outside the extension. Even a non-expired ID
    // token still contains the old email_verified=false claim, so force a token
    // refresh before calling a server endpoint that requires verified email.
    const refreshed = await AuthCore.refreshIdToken({
      apiKey: FIREBASE_WEB_API_KEY,
      refreshToken: pending.refreshToken,
      fetchImpl: fetch
    });
    pending = {
      ...pending,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt
    };
    await storageWriter.setPendingAuth(pending);
    const afterCompletion = {
      ...pending,
      displayName: pending.displayName || info.displayName || '',
      stage: 'choose-access-path',
      lastError: null
    };
    await storageWriter.setPendingAuth(afterCompletion);
    return {
      success: true,
      emailVerified: true,
      stage: afterCompletion.stage,
      error: afterCompletion.lastError
    };
  }

  // Manual retry is only needed for legacy accounts that lost their local
  // display name or a temporary licence/organization failure.
  async function handleCompleteOnboarding(displayName) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    const result = await attemptCompleteOnboarding({
      ...pending,
      displayName: String(displayName || pending.displayName || '').trim()
    });
    return { success: !result.lastError, stage: result.stage, error: result.lastError };
  }

  async function handleOrgSponsoredOnboarding(organizationId, employeeCode) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    const onboarding = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'completeOrganizationSponsoredOnboarding',
      idToken: pending.idToken,
      data: {
        organizationId: String(organizationId || '').trim(),
        employeeCode: String(employeeCode || '').trim(),
        displayName: String(pending.displayName || '').trim()
      },
      fetchImpl: fetch
    });
    const next = { ...pending, stage: 'awaiting-activation', lastError: null };
    await storageWriter.setPendingAuth(next);
    if (!onboarding.activationRequired) {
      const profile = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'getCurrentUserProfile',
        idToken: pending.idToken,
        data: {},
        fetchImpl: fetch
      });
      await establishActiveSession(pending, profile);
      return { success: true, stage: 'active' };
    }
    return { success: true, stage: 'awaiting-activation' };
  }

  async function handleIndividualPaidOnboarding(paymentReference, durationWeeks) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'completeInvitationOnboarding',
      idToken: pending.idToken,
      data: { displayName: String(pending.displayName || '').trim() },
      fetchImpl: fetch
    });
    await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'submitPaymentProof',
      idToken: pending.idToken,
      data: {
        paymentReference: String(paymentReference || '').trim(),
        durationWeeks: Number(durationWeeks)
      },
      fetchImpl: fetch
    });
    await storageWriter.setPendingAuth({
      ...pending,
      stage: 'awaiting-activation',
      lastError: null
    });
    return { success: true, stage: 'awaiting-activation' };
  }

  async function handlePasswordReset(email) {
    try {
      await AuthCore.sendPasswordReset({
        apiKey: FIREBASE_WEB_API_KEY,
        email: String(email || '').trim().toLowerCase(),
        fetchImpl: fetch
      });
    } catch (error) {
      // Do not disclose whether an account exists for the supplied address.
      if (error?.code !== 'EMAIL_NOT_FOUND') throw error;
    }
    return { success: true };
  }

  async function freshAuthenticatedSession() {
    const { authSession } = await storageGet(chrome.storage.local, 'authSession');
    if (!authSession) throw new Error('Sign in first');
    if (AuthCore.isTokenFresh(authSession)) return authSession;
    const refreshed = await AuthCore.refreshIdToken({
      apiKey: FIREBASE_WEB_API_KEY,
      refreshToken: authSession.refreshToken,
      fetchImpl: fetch
    });
    const session = {
      ...authSession,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt
    };
    await storageWriter.setAuthSession(session);
    return session;
  }

  async function handleChangePassword(password) {
    const session = await freshAuthenticatedSession();
    const updated = await AuthCore.updatePassword({
      apiKey: FIREBASE_WEB_API_KEY,
      idToken: session.idToken,
      password: String(password || ''),
      fetchImpl: fetch
    });
    await storageWriter.setAuthSession({
      ...session,
      idToken: updated.idToken,
      refreshToken: updated.refreshToken || session.refreshToken,
      expiresAt: updated.expiresAt
    });
    return { success: true };
  }

  async function handleIndividualRenewal(paymentReference, durationWeeks) {
    const session = await freshAuthenticatedSession();
    const result = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'submitPaymentProof',
      idToken: session.idToken,
      data: {
        paymentReference: String(paymentReference || '').trim(),
        durationWeeks: Number(durationWeeks)
      },
      fetchImpl: fetch
    });
    const licenceState = await performLicenceRecheck();
    return { success: true, result, licenceState };
  }

  // Both ordinary registrations and explicit invitations require administrator
  // approval before the user becomes active.
  async function handleCheckActivation() {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    let profile;
    try {
      profile = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'getCurrentUserProfile',
        idToken: pending.idToken,
        data: {},
        fetchImpl: fetch
      });
    } catch (error) {
      if (error.status === 'PERMISSION_DENIED') return { success: true, active: false };
      throw error;
    }
    if (profile?.accountStatus !== 'active') {
      return { success: true, active: false, rejected: profile?.accountStatus === 'rejected' };
    }
    await establishActiveSession(pending, profile);
    return { success: true, active: true };
  }

  async function performLicenceRecheck() {
    const { authSession } = await storageGet(chrome.storage.local, 'authSession');
    if (!authSession) return null;
    try {
      let session = authSession;
      if (!AuthCore.isTokenFresh(session)) {
        const refreshed = await AuthCore.refreshIdToken({
          apiKey: FIREBASE_WEB_API_KEY,
          refreshToken: session.refreshToken,
          fetchImpl: fetch
        });
        session = { ...session, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
        await storageWriter.setAuthSession(session);
      }
      const licence = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'verifyLicence',
        idToken: session.idToken,
        data: { extensionVersion: chrome.runtime.getManifest().version },
        fetchImpl: fetch
      });
      const state = { ...licence, checkedAt: Date.now(), source: 'server' };
      await storageWriter.setLicenceState(state);
      return state;
    } catch (error) {
      const { licenceState: previous } = await storageGet(chrome.storage.local, 'licenceState');
      const lastCheckedAt = previous?.checkedAt;
      const transportFailure = error?.code === 'NETWORK_ERROR';
      const withinTolerance = transportFailure && Number.isFinite(lastCheckedAt)
        && Date.now() - lastCheckedAt <= LICENCE_OUTAGE_TOLERANCE_MS;
      const state = withinTolerance
        ? { ...previous, source: 'error' }
        : {
          status: 'unknown',
          previewAllowed: false,
          applyAllowed: false,
          expiresAt: null,
          graceEndsAt: null,
          minimumVersion: previous?.minimumVersion || null,
          checkedAt: lastCheckedAt ?? Date.now(),
          source: 'error'
        };
      await storageWriter.setLicenceState(state);
      return state;
    }
  }

  async function refreshProcessingRules() {
    const { authSession, processingRuleSet: cached } = await new Promise((resolve, reject) =>
      chrome.storage.local.get(['authSession', 'processingRuleSet'], result => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result || {});
      }));
    if (!authSession) throw new Error('Sign in first');
    let session = authSession;
    if (!AuthCore.isTokenFresh(session)) {
      const refreshed = await AuthCore.refreshIdToken({
        apiKey: FIREBASE_WEB_API_KEY,
        refreshToken: session.refreshToken,
        fetchImpl: fetch
      });
      session = { ...session, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
      await storageWriter.setAuthSession(session);
    }
    const response = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'getActiveProcessingRules',
      idToken: session.idToken,
      data: {
        knownVersionId: cached?.versionId || '',
        extensionVersion: chrome.runtime.getManifest().version,
        supportedRuleSchemaVersions: [PROCESSING_RULE_SCHEMA_VERSION]
      },
      fetchImpl: fetch
    });
    if (response.unchanged && response.versionId && cached?.versionId !== response.versionId) {
      throw new Error('Active rule version is not available in the local cache');
    }
    if (response.unchanged && response.checksum && cached?.versionId === response.versionId
        && (cached.checksum !== response.checksum || !(await ProcessingRules.verifyPublishedRuleSet(cached)))) {
      await storageWriter.setProcessingRuleSet(null);
      throw new Error('Cached processing rule checksum is invalid');
    }
    const ruleSet = response.unchanged && cached?.versionId === response.versionId
      ? { ...cached, mode: response.mode, checkedAt: Date.now(), source: 'server' }
      : {
          schemaVersion: response.schemaVersion,
          versionId: response.versionId || '',
          checksum: response.checksum || '',
          rules: Array.isArray(response.rules) ? response.rules : [],
          bundledFallbackEnabled: response.bundledFallbackEnabled !== false,
          mode: response.mode || 'bundled',
          checkedAt: Date.now(),
          source: 'server'
        };
    if (!response.unchanged && response.checksum && !(await ProcessingRules.verifyPublishedRuleSet(ruleSet))) {
      await storageWriter.setProcessingRuleSet(null);
      throw new Error('Published processing rule checksum is invalid');
    }
    await storageWriter.setProcessingRuleSet(ruleSet);
    return ruleSet;
  }

  async function submitProcessingRuleFeedback(data) {
    const { authSession } = await storageGet(chrome.storage.local, 'authSession');
    if (!authSession) throw new Error('Sign in first');
    let session = authSession;
    if (!AuthCore.isTokenFresh(session)) {
      const refreshed = await AuthCore.refreshIdToken({
        apiKey: FIREBASE_WEB_API_KEY,
        refreshToken: session.refreshToken,
        fetchImpl: fetch
      });
      session = { ...session, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
      await storageWriter.setAuthSession(session);
    }
    return AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'submitProcessingRuleFeedback',
      idToken: session.idToken,
      data,
      fetchImpl: fetch
    });
  }

  const ADMIN_FUNCTIONS = Object.freeze({
    adminActivateLicence: 'activateLicence',
    adminInviteUser: 'inviteUser',
    adminActivateUser: 'activateUser',
    adminListUsers: 'listUsers',
    adminListInvitations: 'listInvitations',
    adminRevokeInvitation: 'revokeInvitation',
    adminReplaceInvitation: 'replaceInvitation',
    adminSuspendUser: 'suspendUser',
    adminRejectUserRegistration: 'rejectUserRegistration',
    adminReactivateUser: 'activateUser',
    adminChangeUserRole: 'changeUserRole',
    adminDeleteUserAccount: 'deleteUserAccount',
    adminCreateOrganization: 'createOrganization',
    adminUpdateOrganization: 'updateOrganization',
    adminListOrganizations: 'listOrganizations',
    adminListAuditEvents: 'listAuditEvents'
  });

  async function handleAdminAction(action, data) {
    const functionName = ADMIN_FUNCTIONS[action];
    if (!functionName) throw new Error('Unsupported administrator action');
    const { authSession } = await storageGet(chrome.storage.local, 'authSession');
    if (!authSession) throw new Error('Sign in first');
    if (authSession.role !== 'platformAdmin') throw new Error('Platform administrator required');

    let session = authSession;
    if (!AuthCore.isTokenFresh(session)) {
      const refreshed = await AuthCore.refreshIdToken({
        apiKey: FIREBASE_WEB_API_KEY,
        refreshToken: session.refreshToken,
        fetchImpl: fetch
      });
      session = { ...session, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
      await storageWriter.setAuthSession(session);
    }

    const result = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: functionName,
      idToken: session.idToken,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
      fetchImpl: fetch
    });
    const licenceState = action === 'adminActivateLicence'
      ? await performLicenceRecheck()
      : undefined;
    return { success: true, result, licenceState };
  }

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === LICENCE_RECHECK_ALARM) {
        performLicenceRecheck();
        refreshProcessingRules().catch(() => undefined);
      }
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'setAuditBadge' && sender.tab && sender.tab.id !== undefined) {
      setTabBadge(sender.tab.id, request.count > 0 ? String(request.count) : '', '#c0392b');
      return undefined;
    }
    if (request?.action === 'refreshProcessingRules') {
      refreshProcessingRules()
        .then(ruleSet => sendResponse({ success: true, ruleSet }))
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'submitProcessingRuleFeedback') {
      submitProcessingRuleFeedback(request.data)
        .then(result => sendResponse({ success: true, result }))
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authSignIn') {
      handleAuthSignIn(request.email, request.password)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authSendPasswordReset') {
      handlePasswordReset(request.email)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.message || error) }));
      return true;
    }
    if (request?.action === 'authChangePassword') {
      handleChangePassword(request.password)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.message || error) }));
      return true;
    }
    if (request?.action === 'authSubmitRenewal') {
      handleIndividualRenewal(request.paymentReference, request.durationWeeks)
        .then(sendResponse)
        .catch(error => sendResponse({
          success: false,
          error: String(error.code || error.status || 'UNKNOWN'),
          message: String(error.message || '')
        }));
      return true;
    }
    if (request?.action === 'authSignOut') {
      Promise.all([
        storageWriter.clearAuthSession(),
        storageWriter.clearPendingAuth(),
        storageWriter.setLicenceState(null),
        storageWriter.setProcessingRuleSet(null)
      ])
        .then(() => {
          if (chrome.alarms) chrome.alarms.clear(LICENCE_RECHECK_ALARM);
          sendResponse({ success: true });
        })
        .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
      return true;
    }
    if (request?.action === 'authRefreshLicence') {
      performLicenceRecheck()
        .then(licenceState => sendResponse({ success: true, licenceState }))
        .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
      return true;
    }
    if (request?.action === 'authSignUp') {
      handleAuthSignUp(request.email, request.password, request.displayName)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authResendVerification') {
      handleResendVerification()
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authCheckEmailVerified') {
      handleCheckEmailVerified()
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authCompleteOnboarding' || request?.action === 'authAcceptInvitation') {
      handleCompleteOnboarding(request.displayName)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authOrganizationSponsoredOnboarding') {
      handleOrgSponsoredOnboarding(request.organizationId, request.employeeCode)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authIndividualPaidOnboarding') {
      handleIndividualPaidOnboarding(request.paymentReference, request.durationWeeks)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authCheckActivation') {
      handleCheckActivation()
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authCancelSignUp') {
      storageWriter.clearPendingAuth()
        .then(() => sendResponse({ success: true }))
        .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(ADMIN_FUNCTIONS, request?.action)) {
      handleAdminAction(request.action, request.data)
        .then(sendResponse)
        .catch(error => sendResponse({
          success: false,
          error: String(error.code || error.status || error.message || error)
        }));
      return true;
    }
    let mutation = null;
    if (request?.action === 'appendStorageEntries') {
      mutation = storageWriter.append(request.key, request.entries);
    } else if (request?.action === 'removeRecoverySnapshot') {
      mutation = storageWriter.removeRecoverySnapshot(request.id);
    } else if (request?.action === 'ensureRuleOverridesMigration') {
      mutation = overrideMigration.then(() => 0);
    }
    if (!mutation) return undefined;
    mutation.then(count => sendResponse({ success: true, count }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  });

  if (chrome.tabs?.onUpdated && chrome.action) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== 'loading') return;
      setTabBadge(tabId, '');
    });
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    STORAGE_POLICIES,
    auditLogEntryKey,
    createSerializedStorageWriter,
    ignoreMissingTabError,
    migrateRuleOverridesToLocal,
    setTabBadge
  };
}
