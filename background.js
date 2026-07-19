// Background service worker: serialized storage writer plus per-tab audit badge.

const STORAGE_POLICIES = Object.freeze({
  claimActivityLog: { limit: 500, timestampField: 'timestamp', maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  rghsAuditFeedback: { limit: 2000 },
  rghsAuditLog: { limit: 2000, dedupe: true },
  claimRecoverySnapshots: { limit: 20, timestampField: 'createdAt', maxAgeMs: 24 * 60 * 60 * 1000 }
});

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
    }
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.local && chrome.storage?.sync) {
  const storageWriter = createSerializedStorageWriter(chrome.storage.local);
  const overrideMigration = migrateRuleOverridesToLocal(chrome.storage.local, chrome.storage.sync)
    .catch(() => false);
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'setAuditBadge' && sender.tab && sender.tab.id !== undefined) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: request.count > 0 ? String(request.count) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#c0392b' });
      return undefined;
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
