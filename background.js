// Background service worker: serialized storage writer plus per-tab audit badge.

// runtime-config.js is generated from the git-ignored Firebase build config.
// It must load before auth-core.js in the service worker.
if (typeof importScripts === 'function') importScripts('runtime-config.js', 'auth-core.js');

const STORAGE_POLICIES = Object.freeze({
  claimActivityLog: { limit: 500, timestampField: 'timestamp', maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  rghsAuditFeedback: { limit: 2000 },
  rghsAuditLog: { limit: 2000, dedupe: true },
  claimRecoverySnapshots: { limit: 20, timestampField: 'createdAt', maxAgeMs: 24 * 60 * 60 * 1000 }
});

const FIREBASE_WEB_API_KEY = globalThis.ClaimSparkRuntimeConfig?.firebaseApiKey || '';
const FUNCTIONS_BASE_URL = globalThis.ClaimSparkRuntimeConfig?.functionsBaseUrl || '';
const LICENCE_RECHECK_ALARM = 'claimExtensionLicenceRecheck';
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
      displayName: profile?.displayName || '',
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
      await storageWriter.setPendingAuth({
        ...localSession,
        displayName: '',
        invitationToken: '',
        stage: 'accept-invitation',
        lastError: null
      });
      await Promise.all([
        storageWriter.clearAuthSession(),
        storageWriter.setLicenceState(null)
      ]);
      return { success: true, requiresProfileRecovery: true };
    }
    if (profile?.accountStatus === 'invited') {
      await storageWriter.setPendingAuth({
        ...localSession,
        displayName: profile.displayName || '',
        invitationToken: '',
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

  // Tries acceptInvitation with whatever invitation token/display name are on
  // the pending record. Never throws: a failed attempt (bad/expired/already-
  // used token) just stays at the 'accept-invitation' stage with lastError
  // set, so the popup can show it and let the user correct the token.
  async function attemptAcceptInvitation(pending) {
    try {
      await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'acceptInvitation',
        idToken: pending.idToken,
        data: { token: pending.invitationToken, displayName: pending.displayName },
        fetchImpl: fetch
      });
      const next = { ...pending, stage: 'awaiting-activation', lastError: null };
      await storageWriter.setPendingAuth(next);
      return next;
    } catch (error) {
      const next = { ...pending, stage: 'accept-invitation', lastError: String(error.status || error.message || error) };
      await storageWriter.setPendingAuth(next);
      return next;
    }
  }

  async function handleAuthSignUp(email, password, displayName, invitationTokenValue) {
    const session = await AuthCore.signUp({ apiKey: FIREBASE_WEB_API_KEY, email, password, fetchImpl: fetch });
    await AuthCore.sendEmailVerification({ apiKey: FIREBASE_WEB_API_KEY, idToken: session.idToken, fetchImpl: fetch });
    await storageWriter.setPendingAuth({
      uid: session.uid,
      email: session.email,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      displayName: String(displayName || '').trim(),
      invitationToken: String(invitationTokenValue || '').trim(),
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

  // On success, immediately attempts acceptInvitation with the token/name
  // collected at sign-up - no separate manual step for the common case where
  // the invitation is still valid.
  async function handleCheckEmailVerified() {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    const info = await AuthCore.accountInfo({ apiKey: FIREBASE_WEB_API_KEY, idToken: pending.idToken, fetchImpl: fetch });
    if (!info.emailVerified) {
      await storageWriter.setPendingAuth(pending);
      return { success: true, emailVerified: false };
    }
    const afterAccept = await attemptAcceptInvitation({ ...pending, stage: 'accept-invitation' });
    return { success: true, emailVerified: true, stage: afterAccept.stage, error: afterAccept.lastError };
  }

  // Manual retry, used when the auto-attempt above failed (e.g. the token was
  // mistyped, expired, or already used) and the user corrects it.
  async function handleAcceptInvitation(invitationTokenValue, displayName) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth);
    const result = await attemptAcceptInvitation({
      ...pending,
      invitationToken: String(invitationTokenValue || '').trim(),
      displayName: String(displayName || '').trim()
    });
    return { success: !result.lastError, stage: result.stage, error: result.lastError };
  }

  // acceptInvitation leaves accountStatus 'invited', not 'active' - a platform
  // admin still has to call activateUser. Until they do, getCurrentUserProfile
  // (and everything else gated by activeUser()) fails PERMISSION_DENIED, which
  // just means "keep waiting", not an error to surface.
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
      return { success: true, active: false };
    }
    await storageWriter.setAuthSession({
      uid: pending.uid,
      email: pending.email,
      displayName: profile?.displayName || pending.displayName || '',
      organizationId: profile?.organizationId || null,
      role: profile?.role || null,
      idToken: pending.idToken,
      refreshToken: pending.refreshToken,
      expiresAt: pending.expiresAt,
      signedInAt: Date.now()
    });
    const licence = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'verifyLicence',
      idToken: pending.idToken,
      data: { extensionVersion: chrome.runtime.getManifest().version },
      fetchImpl: fetch
    });
    await storageWriter.setLicenceState({ ...licence, checkedAt: Date.now(), source: 'server' });
    await storageWriter.clearPendingAuth();
    if (chrome.alarms) chrome.alarms.create(LICENCE_RECHECK_ALARM, { periodInMinutes: 15 });
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
    } catch {
      const { licenceState: previous } = await storageGet(chrome.storage.local, 'licenceState');
      const lastCheckedAt = previous?.checkedAt;
      const withinTolerance = Number.isFinite(lastCheckedAt) && Date.now() - lastCheckedAt <= LICENCE_OUTAGE_TOLERANCE_MS;
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

  const ADMIN_FUNCTIONS = Object.freeze({
    adminActivateLicence: 'activateLicence',
    adminInviteUser: 'inviteUser',
    adminActivateUser: 'activateUser',
    adminListUsers: 'listUsers',
    adminListInvitations: 'listInvitations',
    adminRevokeInvitation: 'revokeInvitation',
    adminReplaceInvitation: 'replaceInvitation',
    adminSuspendUser: 'suspendUser',
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
      if (alarm.name === LICENCE_RECHECK_ALARM) performLicenceRecheck();
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'setAuditBadge' && sender.tab && sender.tab.id !== undefined) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: request.count > 0 ? String(request.count) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#c0392b' });
      return undefined;
    }
    if (request?.action === 'authSignIn') {
      handleAuthSignIn(request.email, request.password)
        .then(sendResponse)
        .catch(error => sendResponse({ success: false, error: String(error.code || error.status || error.message || error) }));
      return true;
    }
    if (request?.action === 'authSignOut') {
      Promise.all([storageWriter.clearAuthSession(), storageWriter.setLicenceState(null)])
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
      handleAuthSignUp(request.email, request.password, request.displayName, request.invitationToken)
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
    if (request?.action === 'authAcceptInvitation') {
      handleAcceptInvitation(request.invitationToken, request.displayName)
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
    } else if (request?.action === 'setRuleOverride') {
      mutation = overrideMigration.then(() => storageWriter.setRuleOverride(request.ruleId, request.autoDeductEligible));
    } else if (request?.action === 'resetRuleOverrides') {
      mutation = overrideMigration.then(() => storageWriter.resetRuleOverrides());
    } else if (request?.action === 'ensureRuleOverridesMigration') {
      mutation = overrideMigration.then(() => 0);
    } else if (request?.action === 'setCustomRuleConfig') {
      mutation = storageWriter.setCustomRuleConfig(request.config);
    }
    if (!mutation) return undefined;
    mutation.then(count => sendResponse({ success: true, count }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  });

  if (chrome.tabs?.onUpdated && chrome.action) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== 'loading') return;
      chrome.action.setBadgeText({ tabId, text: '' });
    });
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { STORAGE_POLICIES, auditLogEntryKey, createSerializedStorageWriter, migrateRuleOverridesToLocal };
}
