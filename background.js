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
function investigationSheetStorageKey(tid) {
  return `investigationSheet:${String(tid || '')}`;
}
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
  // Session, entitlement and policy writes share one queue. A sign-out must
  // finish after earlier writes, and obsolete network responses must not write.
  const writeAuthState = (key, value, guard) => enqueue('auth-state', async () => {
    if (guard && !guard()) throw new Error('SESSION_CHANGED');
    await storageSet(storage, { [key]: value });
    return value;
  });

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
    markRecoveryEntriesRestored(id, restoredIds) {
      return enqueue('claimRecoverySnapshots', async () => {
        const result = await storageGet(storage, 'claimRecoverySnapshots');
        const ids = new Set(restoredIds);
        const snapshots = (result.claimRecoverySnapshots || []).map(snapshot => snapshot.id !== id ? snapshot
          : { ...snapshot, entries: snapshot.entries.filter(entry => !ids.has(entry.id)) })
          .filter(snapshot => snapshot.id !== id || snapshot.entries.length);
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
    setProcessingRuleSet(ruleSet, guard) {
      return writeAuthState('processingRuleSet', ruleSet, guard);
    },
    setAuthSession(session, guard) {
      return writeAuthState('authSession', session, guard);
    },
    clearAuthSession(guard) {
      return writeAuthState('authSession', null, guard);
    },
    setLicenceState(state, guard) {
      return writeAuthState('licenceState', state, guard);
    },
    setPendingAuth(pending, guard) {
      return writeAuthState('pendingAuth', pending, guard);
    },
    clearPendingAuth(guard) {
      return writeAuthState('pendingAuth', null, guard);
    }
  };
}

function createReviewDecisionStore(storage, now = () => Date.now()) {
  let chain = Promise.resolve();
  const run = work => { const next = chain.catch(() => {}).then(work); chain = next; return next; };
  const keyFor = context => JSON.stringify([context.uid, context.tid, context.url]);
  async function entries() {
    const result = await storageGet(storage, 'claimReviewDecisions');
    return (Array.isArray(result.claimReviewDecisions) ? result.claimReviewDecisions : [])
      .filter(item => Number.isFinite(item.savedAt) && now() - item.savedAt < 24 * 60 * 60 * 1000);
  }
  return {
    save(context, value) {
      return run(async () => {
        if (!value || !/^[a-f0-9]{8}$/.test(value.previewToken || '')) throw new Error('Invalid review identity');
        const selectedKeys = value.selectedKeys;
        if (!Array.isArray(selectedKeys) || selectedKeys.length > 1000 || selectedKeys.some(key => typeof key !== 'string' || key.length > 200)) throw new Error('Invalid review selection');
        for (const [key, amount] of Object.entries(value.approvedOverrides || {})) {
          if (!selectedKeys.includes(key) || !Number.isFinite(amount) || amount < 0) throw new Error('Invalid saved amount decision');
        }
        for (const [key, remark] of Object.entries(value.remarkOverrides || {})) {
          if (!selectedKeys.includes(key) || typeof remark !== 'string' || remark.length > 2000) throw new Error('Invalid saved remark decision');
        }
        if (!Array.isArray(value.exceptionalGroups) || value.exceptionalGroups.some(id => typeof id !== 'string' || id.length > 200)) throw new Error('Invalid saved review groups');
        const saved = { previewToken: value.previewToken, ruleSetVersion: String(value.ruleSetVersion || '').slice(0, 128),
          ruleSetChecksum: String(value.ruleSetChecksum || '').slice(0, 128), selectedKeys: [...new Set(selectedKeys)],
          approvedOverrides: value.approvedOverrides || {}, remarkOverrides: value.remarkOverrides || {}, exceptionalGroups: value.exceptionalGroups };
        if (JSON.stringify(saved).length > 250000) throw new Error('Saved review is too large');
        const key = keyFor(context);
        await storageSet(storage, { claimReviewDecisions: [...(await entries()).filter(item => item.key !== key), { key, savedAt: now(), value: saved }].slice(-30) });
        return true;
      });
    },
    get: context => run(async () => (await entries()).find(item => item.key === keyFor(context))?.value || null),
    clear: context => run(async () => { await storageSet(storage, { claimReviewDecisions: (await entries()).filter(item => item.key !== keyFor(context)) }); return true; }),
    clearAll: () => run(async () => { await storageSet(storage, { claimReviewDecisions: [] }); return true; })
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.local && chrome.storage?.sync) {
  const storageWriter = createSerializedStorageWriter(chrome.storage.local);
  const overrideMigration = migrateRuleOverridesToLocal(chrome.storage.local, chrome.storage.sync)
    .catch(() => false);
  const AuthCore = globalThis.ClaimAuthCore;
  const ProcessingRules = globalThis.ClaimProcessingRules;
  const reviewDecisions = chrome.storage.session ? createReviewDecisionStore(chrome.storage.session) : null;
  let reviewEpoch = 0;
  let reviewIdentityChanging = false;
  async function withReviewIdentityReset(work) {
    const epoch = ++reviewEpoch;
    reviewIdentityChanging = true;
    let cleared = false;
    try {
      try {
        await reviewDecisions?.clearAll();
        cleared = true;
      } catch {
        // Review-memory errors must not prevent sign-out. Keep the broker
        // unavailable until a subsequent identity reset clears it successfully.
      }
      return await work();
    } finally {
      if (epoch === reviewEpoch) reviewIdentityChanging = !cleared;
    }
  }

  let authEpoch = 0;
  let ruleRefreshInFlight = null;
  let signUpInFlight = null;
  function guardedWriter(epoch) {
    return Object.fromEntries(['setAuthSession', 'clearAuthSession', 'setLicenceState',
      'setPendingAuth', 'clearPendingAuth', 'setProcessingRuleSet'].map(name =>
      [name, (...args) => storageWriter[name](...args, () => epoch === authEpoch)]));
  }
  function clearSessionState() {
    return Promise.all([storageWriter.clearAuthSession(), storageWriter.clearPendingAuth(),
      storageWriter.setLicenceState(null), storageWriter.setProcessingRuleSet(null)]);
  }
  async function startAuthFlow(work) {
    const epoch = ++authEpoch;
    ruleRefreshInFlight = null;
    return withReviewIdentityReset(async () => {
      if (epoch !== authEpoch) throw new Error('SESSION_CHANGED');
      await clearSessionState();
      if (epoch !== authEpoch) throw new Error('SESSION_CHANGED');
      return work(epoch);
    });
  }

  async function handleAuthSignIn(email, password, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
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
      await writer.setPendingAuth({ ...localSession, stage: 'verify-email', lastError: null });
      return { success: true, requiresEmailVerification: true };
    }
    if (requiresProfileRecovery) {
      const pending = {
        ...localSession,
        stage: 'complete-onboarding',
        lastError: null
      };
      const afterCompletion = pending.displayName
        ? await attemptCompleteOnboarding(pending, epoch)
        : pending;
      if (afterCompletion.stage === 'active') return { success: true };
      await writer.setPendingAuth(afterCompletion);
      await Promise.all([
        writer.clearAuthSession(),
        writer.setLicenceState(null)
      ]);
      return ['choose-access', 'awaiting-activation'].includes(afterCompletion.stage)
        ? { success: true, awaitingActivation: true }
        : { success: true, requiresProfileRecovery: true, error: afterCompletion.lastError };
    }
    if (profile?.accountStatus === 'invited') {
      const activated = await attemptCompleteOnboarding({
        ...localSession,
        displayName: profile.displayName || '',
        stage: 'complete-onboarding',
        lastError: null
      }, epoch);
      if (activated.stage === 'active') return { success: true };
      await writer.setPendingAuth(activated);
      await Promise.all([
        writer.clearAuthSession(),
        writer.setLicenceState(null)
      ]);
      return { success: true, awaitingActivation: true, error: activated.lastError };
    }
    await writer.setAuthSession(localSession);
    await writer.clearPendingAuth();
    const licence = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'verifyLicence',
      idToken: session.idToken,
      data: { extensionVersion: chrome.runtime.getManifest().version },
      fetchImpl: fetch
    });
    await writer.setLicenceState({ ...licence, checkedAt: Date.now(), source: 'server' });
    if (chrome.alarms) chrome.alarms.create(LICENCE_RECHECK_ALARM, { periodInMinutes: 15 });
    refreshProcessingRules(epoch).catch(() => undefined);
    return { success: true };
  }

  async function refreshPendingIfStale(pending, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    if (AuthCore.isTokenFresh(pending)) return pending;
    const refreshed = await AuthCore.refreshIdToken({
      apiKey: FIREBASE_WEB_API_KEY,
      refreshToken: pending.refreshToken,
      fetchImpl: fetch
    });
    const next = { ...pending, idToken: refreshed.idToken, refreshToken: refreshed.refreshToken, expiresAt: refreshed.expiresAt };
    await writer.setPendingAuth(next);
    return next;
  }

  async function establishActiveSession(session, profile, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    await writer.setAuthSession({
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
    await writer.setLicenceState({ ...licence, checkedAt: Date.now(), source: 'server' });
    await writer.clearPendingAuth();
    if (chrome.alarms) chrome.alarms.create(LICENCE_RECHECK_ALARM, { periodInMinutes: 15 });
    refreshProcessingRules(epoch).catch(() => undefined);
  }

  // Completes normal self-service registration after email verification.
  async function attemptCompleteOnboarding(pending, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    try {
      const onboarding = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'completeInvitationOnboarding',
        idToken: pending.idToken,
        data: { displayName: pending.displayName },
        fetchImpl: fetch
      });
      const next = { ...pending, stage: onboarding.accessSelectionRequired ? 'choose-access' : 'awaiting-activation', lastError: null };
      await writer.setPendingAuth(next);
      if (!onboarding.activationRequired) {
        const profile = await AuthCore.callFunction({
          functionsBaseUrl: FUNCTIONS_BASE_URL,
          name: 'getCurrentUserProfile',
          idToken: pending.idToken,
          data: {},
          fetchImpl: fetch
        });
        await establishActiveSession(pending, profile, epoch);
        return { ...pending, stage: 'active', lastError: null };
      }
      return next;
    } catch (error) {
      const next = { ...pending, stage: 'complete-onboarding', lastError: String(error.status || error.message || error) };
      await writer.setPendingAuth(next);
      return next;
    }
  }

  async function handleAuthSignUp(email, password, displayName, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    const session = await AuthCore.signUp({ apiKey: FIREBASE_WEB_API_KEY, email, password, fetchImpl: fetch });
    const normalizedDisplayName = String(displayName || '').trim();
    // Persist recovery before optional profile/email requests. A sent email or
    // failed profile update must never leave a created identity stranded.
    const pending = {
      ...session, displayName: normalizedDisplayName, stage: 'verify-email', lastError: null
    };
    await writer.setPendingAuth(pending);
    try { await AuthCore.updateProfile({
      apiKey: FIREBASE_WEB_API_KEY,
      idToken: session.idToken,
      displayName: normalizedDisplayName,
      fetchImpl: fetch
    }); } catch (error) {
      if (epoch !== authEpoch) throw error;
      // The pending record retains the supplied display name for onboarding.
    }
    try {
      await AuthCore.sendEmailVerification({ apiKey: FIREBASE_WEB_API_KEY, idToken: session.idToken, fetchImpl: fetch });
      return { success: true };
    } catch (error) {
      await writer.setPendingAuth({ ...pending, lastError: String(error.code || error.message) });
      return { success: true, verificationEmailSent: false, error: String(error.code || error.message) };
    }
  }

  async function handleResendVerification(epoch = authEpoch) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth, epoch);
    await AuthCore.sendEmailVerification({ apiKey: FIREBASE_WEB_API_KEY, idToken: pending.idToken, fetchImpl: fetch });
    return { success: true };
  }

  // Verification establishes identity; access selection and administrator
  // activation remain separate steps.
  async function handleCheckEmailVerified(epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw Object.assign(new Error('Sign in again to resume verification.'), { code: 'PENDING_AUTH_MISSING' });
    let pending = await refreshPendingIfStale(pendingAuth, epoch);
    const info = await AuthCore.accountInfo({ apiKey: FIREBASE_WEB_API_KEY, idToken: pending.idToken, fetchImpl: fetch });
    if (!info.emailVerified) {
      await writer.setPendingAuth(pending);
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
    await writer.setPendingAuth(pending);
    const afterVerification = {
      ...pending,
      displayName: pending.displayName || info.displayName || '',
      stage: 'complete-onboarding',
      lastError: null
    };
    const completed = await attemptCompleteOnboarding(afterVerification, epoch);
    return {
      success: true,
      emailVerified: true,
      stage: completed.stage,
      error: completed.lastError
    };
  }

  // Manual retry is only needed for legacy accounts that lost their local
  // display name or a temporary licence/organization failure.
  async function handleCompleteOnboarding(displayName, epoch = authEpoch) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth, epoch);
    const result = await attemptCompleteOnboarding({
      ...pending,
      displayName: String(displayName || pending.displayName || '').trim()
    }, epoch);
    return { success: !result.lastError, stage: result.stage, error: result.lastError };
  }

  async function handleOrgSponsoredOnboarding(organizationId, employeeCode, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth, epoch);
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
    await writer.setPendingAuth(next);
    if (!onboarding.activationRequired) {
      const profile = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'getCurrentUserProfile',
        idToken: pending.idToken,
        data: {},
        fetchImpl: fetch
      });
      await establishActiveSession(pending, profile, epoch);
      return { success: true, stage: 'active' };
    }
    return { success: true, stage: 'awaiting-activation' };
  }

  async function handleIndividualPaidOnboarding(paymentReference, durationWeeks, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth, epoch);
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
    await writer.setPendingAuth({
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

  async function freshAuthenticatedSession(epoch = authEpoch) {
    const writer = guardedWriter(epoch);
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
    await writer.setAuthSession(session);
    return session;
  }

  async function handleChangePassword(password, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
    const session = await freshAuthenticatedSession();
    const updated = await AuthCore.updatePassword({
      apiKey: FIREBASE_WEB_API_KEY,
      idToken: session.idToken,
      password: String(password || ''),
      fetchImpl: fetch
    });
    await writer.setAuthSession({
      ...session,
      idToken: updated.idToken,
      refreshToken: updated.refreshToken || session.refreshToken,
      expiresAt: updated.expiresAt
    });
    return { success: true };
  }

  async function handleIndividualRenewal(paymentReference, durationWeeks, epoch = authEpoch) {
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
    const licenceState = await performLicenceRecheck(epoch);
    return { success: true, result, licenceState };
  }

  // Both ordinary registrations and explicit invitations require administrator
  // approval before the user becomes active.
  async function handleCheckActivation(epoch = authEpoch) {
    const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
    if (!pendingAuth) throw new Error('No pending sign-up');
    const pending = await refreshPendingIfStale(pendingAuth, epoch);
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
    const licence = await AuthCore.callFunction({ functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: 'verifyLicence', idToken: pending.idToken,
      data: { extensionVersion: chrome.runtime.getManifest().version }, fetchImpl: fetch });
    if (licence.applyAllowed !== true) return { success: true, active: false, licenceStatus: licence.status };
    await establishActiveSession(pending, profile, epoch);
    return { success: true, active: true };
  }

  async function performLicenceRecheck(epoch = authEpoch) {
    const writer = guardedWriter(epoch);
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
        await writer.setAuthSession(session);
      }
      const licence = await AuthCore.callFunction({
        functionsBaseUrl: FUNCTIONS_BASE_URL,
        name: 'verifyLicence',
        idToken: session.idToken,
        data: { extensionVersion: chrome.runtime.getManifest().version },
        fetchImpl: fetch
      });
      const state = { ...licence, checkedAt: Date.now(), source: 'server' };
      await writer.setLicenceState(state);
      return state;
    } catch (error) {
      if (epoch !== authEpoch) return null;
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
      await writer.setLicenceState(state);
      return state;
    }
  }

  function refreshProcessingRules(epoch = authEpoch) {
    if (ruleRefreshInFlight?.epoch === epoch) return ruleRefreshInFlight.promise;
    const entry = { epoch, promise: fetchProcessingRules(epoch) };
    ruleRefreshInFlight = entry;
    const finish = () => { if (ruleRefreshInFlight === entry) ruleRefreshInFlight = null; };
    entry.promise.then(finish, finish);
    return entry.promise;
  }

  async function fetchProcessingRules(epoch) {
    const writer = guardedWriter(epoch);
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
      await writer.setAuthSession(session);
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
      await writer.setProcessingRuleSet(null);
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
      await writer.setProcessingRuleSet(null);
      throw new Error('Published processing rule checksum is invalid');
    }
    await writer.setProcessingRuleSet(ruleSet);
    return ruleSet;
  }

  async function submitProcessingRuleFeedback(data, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
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
      await writer.setAuthSession(session);
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

  async function handleAdminAction(action, data, epoch = authEpoch) {
    const writer = guardedWriter(epoch);
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
      await writer.setAuthSession(session);
    }

    const result = await AuthCore.callFunction({
      functionsBaseUrl: FUNCTIONS_BASE_URL,
      name: functionName,
      idToken: session.idToken,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
      fetchImpl: fetch
    });
    const licenceState = action === 'adminActivateLicence'
      ? await performLicenceRecheck(epoch)
      : undefined;
    return { success: true, result, licenceState };
  }

  if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === LICENCE_RECHECK_ALARM) {
        performLicenceRecheck().catch(() => undefined);
        refreshProcessingRules().catch(() => undefined);
      }
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (['saveReviewDecisions', 'getReviewDecisions', 'clearReviewDecisions'].includes(request?.action)) {
      const epoch = reviewEpoch;
      (async () => {
        const { authSession } = await storageGet(chrome.storage.local, 'authSession');
        const tid = String(request.tid || '');
        const url = sender.tab?.url || '';
        const parsed = new URL(url);
        if (reviewIdentityChanging || !reviewDecisions || !authSession?.uid || epoch !== reviewEpoch || !tid || tid.length > 128
          || !(parsed.origin === 'https://rghs.rajasthan.gov.in' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) throw new Error('Review session unavailable');
        const context = { uid: authSession.uid, tid, url };
        const value = request.action === 'saveReviewDecisions' ? await reviewDecisions.save(context, request.data)
          : request.action === 'clearReviewDecisions' ? await reviewDecisions.clear(context) : await reviewDecisions.get(context);
        return { success: epoch === reviewEpoch, value: epoch === reviewEpoch ? value : null };
      })().then(sendResponse).catch(error => sendResponse({ success: false, error: String(error.message || error) }));
      return true;
    }
    if (request?.action === 'registerInvestigationChecklist' && sender.tab?.id !== undefined && request.tid) {
      chrome.storage.session.set({ [investigationSheetStorageKey(request.tid)]: {
        tabId: sender.tab.id,
        items: Array.isArray(request.items) ? request.items.slice(0, 100) : [],
        registeredAt: Date.now()
      } }, () => { void chrome.runtime.lastError; });
      return undefined;
    }
    if (request?.action === 'openInvestigationCompanion') {
      const tid = String(request.tid || '');
      chrome.storage.session.get(investigationSheetStorageKey(tid), saved => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        const sheet = saved[investigationSheetStorageKey(tid)];
        chrome.storage.session.set({
          investigationCompanion: {
            tid,
            items: (sheet?.items?.length ? sheet.items : Array.isArray(request.items) ? request.items : []).slice(0, 100),
            createdAt: Date.now()
          }
        }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          chrome.windows.create({
            url: `${chrome.runtime.getURL('investigation-companion.html')}?tid=${encodeURIComponent(tid)}`,
            type: 'popup',
            width: 400,
            height: 620
          }, () => sendResponse(chrome.runtime.lastError
            ? { success: false, error: chrome.runtime.lastError.message }
            : { success: true }));
        });
      });
      return true;
    }
    if (request?.action === 'openReviewDocuments') {
      const senderUrl = sender.tab?.url || '';
      let origin = '';
      try { origin = new URL(senderUrl).origin; } catch (_) { origin = ''; }
      const urls = [...new Set((Array.isArray(request.documents) ? request.documents : [])
        .map(item => String(item?.url || item || '').trim())
        .filter(url => {
          try {
            const parsed = new URL(url);
            return parsed.origin === origin && /^https?:$/i.test(parsed.protocol);
          } catch (_) { return false; }
        }))].slice(0, 20);
      if (!urls.length) {
        sendResponse({ success: false, count: 0, error: 'No eligible portal document links were found.' });
        return undefined;
      }
      let remaining = urls.length;
      let opened = 0;
      for (const url of urls) {
        chrome.tabs.create({ url, active: false }, () => {
          if (!chrome.runtime.lastError) opened++;
          remaining--;
          if (!remaining) sendResponse({ success: opened > 0, count: opened });
        });
      }
      return true;
    }
    if (request?.action === 'investigationCompanionPreview' || request?.action === 'investigationCompanionApply') {
      const tid = String(request.tid || '');
      chrome.storage.session.get(investigationSheetStorageKey(tid), saved => {
        const sheet = saved[investigationSheetStorageKey(tid)];
        if (!sheet?.tabId) {
          sendResponse({ success: false, error: 'Matching process sheet is unavailable. Refresh the process sheet and reopen the Investigation Report.' });
          return;
        }
        const action = request.action === 'investigationCompanionPreview'
          ? 'previewInvestigationVerification'
          : 'applyInvestigationVerification';
        const payload = request.action === 'investigationCompanionPreview'
          ? { action, verifiedCounts: request.verifiedCounts }
          : { action, token: request.token, acknowledgedHighRisk: request.acknowledgedHighRisk === true };
        chrome.tabs.sendMessage(sheet.tabId, payload, response => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: 'Matching process sheet is unavailable. Refresh it and reopen the Investigation Report.' });
            return;
          }
          sendResponse(response || { success: false, error: 'The process sheet did not respond.' });
        });
      });
      return true;
    }
    if (request?.action === 'reloadInvestigationProcessSheet') {
      const tid = String(request.tid || '').trim();
      if (!tid) {
        sendResponse({ success: false, error: 'Claim identifier is unavailable. Reopen the Investigation Report from the IPD main page.' });
        return undefined;
      }
      chrome.tabs.query({}, tabs => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        const sheet = tabs.find(tab => tab.url?.includes(`/RGHS/processSheetSearch/${tid}/`));
        if (!sheet?.id) {
          sendResponse({ success: false, error: 'Matching process sheet tab was not found.' });
          return;
        }
        chrome.tabs.reload(sheet.id, () => sendResponse(chrome.runtime.lastError
          ? { success: false, error: chrome.runtime.lastError.message }
          : { success: true }));
      });
      return true;
    }
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
      startAuthFlow(epoch => handleAuthSignIn(request.email, request.password, epoch))
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
      const epoch = ++authEpoch;
      ruleRefreshInFlight = null;
      withReviewIdentityReset(() => {
        if (epoch !== authEpoch) throw new Error('SESSION_CHANGED');
        return clearSessionState();
      })
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
      if (signUpInFlight) {
        sendResponse({ success: false, error: 'AUTH_IN_PROGRESS' });
        return undefined;
      }
      const signup = (async () => {
        const { pendingAuth } = await storageGet(chrome.storage.local, 'pendingAuth');
        if (pendingAuth?.email?.toLowerCase() === String(request.email || '').trim().toLowerCase()) {
          throw Object.assign(new Error('Account already created. Sign in to resume.'), { code: 'EMAIL_EXISTS' });
        }
        return startAuthFlow(epoch => handleAuthSignUp(request.email, request.password, request.displayName, epoch));
      })();
      signUpInFlight = signup;
      signup.then(result => {
        if (signUpInFlight === signup) signUpInFlight = null;
        sendResponse(result);
      }, error => {
        if (signUpInFlight === signup) signUpInFlight = null;
        sendResponse({ success: false, error: String(error.code || error.status || error.message || error) });
      });
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
      ++authEpoch;
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
    } else if (request?.action === 'markRecoveryEntriesRestored') {
      mutation = storageWriter.markRecoveryEntriesRestored(request.id, Array.isArray(request.restoredIds) ? request.restoredIds : []);
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
    createReviewDecisionStore,
    ignoreMissingTabError,
    migrateRuleOverridesToLocal,
    setTabBadge
  };
}
