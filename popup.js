// Popup script for controlling the extension

const authSignedOut = document.getElementById('authSignedOut');
const authSignedIn = document.getElementById('authSignedIn');
const authEmailInput = document.getElementById('authEmail');
const authPasswordInput = document.getElementById('authPassword');
const authSignInBtn = document.getElementById('authSignInBtn');
const authEmailLabel = document.getElementById('authEmailLabel');
const licenceStatusLabel = document.getElementById('licenceStatusLabel');
const authRecheckBtn = document.getElementById('authRecheckBtn');
const authSignOutBtn = document.getElementById('authSignOutBtn');
const toggle = document.getElementById('autoFillToggle');
const auditModeSelect = document.getElementById('auditMode');
const fillNowBtn = document.getElementById('fillNowBtn');
const undoBtn = document.getElementById('undoBtn');
const exportLogBtn = document.getElementById('exportLogBtn');
const exportActivityBtn = document.getElementById('exportActivityBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const rulesStatsBtn = document.getElementById('rulesStatsBtn');
const statusMessage = document.getElementById('statusMessage');
const AuditCore = globalThis.RGHSAuditCore;
let previewCount = 0;
let previewToken = null;
let previewRowKeys = [];
let clearArmed = false;
let statusHideTimer = null;
document.getElementById('versionLabel').textContent = `Version ${chrome.runtime.getManifest().version}`;

function setFillButton(label = 'Preview Fill') {
  fillNowBtn.disabled = false;
  fillNowBtn.textContent = label;
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) throw new Error('No active tab');
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// Load initial state
chrome.storage.sync.get(['autoFillEnabled', 'auditMode'], (result) => {
  toggle.checked = result.autoFillEnabled !== false; // Default to true
  auditModeSelect.value = ['off', 'flag', 'deduct'].includes(result.auditMode) ? result.auditMode : 'flag';
});

sendToActiveTab({ action: 'getStatus' })
  .then(response => { undoBtn.disabled = !response?.hasUndo; })
  .catch(() => { undoBtn.disabled = true; });

const authErrorMessages = {
  EMAIL_NOT_FOUND: 'No account found for that email.',
  INVALID_PASSWORD: 'Incorrect password.',
  INVALID_LOGIN_CREDENTIALS: 'Incorrect email or password.',
  USER_DISABLED: 'This account has been disabled. Contact your administrator.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  NETWORK_ERROR: 'Unable to reach the sign-in service. Check your connection.'
};

function describeLicenceStatus(state) {
  if (!state) return '';
  if (state.status === 'active') return `Licence active until ${new Date(state.expiresAt).toLocaleString()}`;
  if (state.status === 'grace') return `Licence expired — Preview only until ${new Date(state.graceEndsAt).toLocaleString()}`;
  if (state.status === 'unverified') return 'Verify your email to continue — check your inbox for a link from Firebase.';
  return 'Apply disabled. Contact your administrator.';
}

function renderAuthState(authSession, licenceState) {
  const signedIn = !!authSession;
  authSignedOut.hidden = signedIn;
  authSignedIn.hidden = !signedIn;
  if (signedIn) {
    authEmailLabel.textContent = authSession.email || '';
    licenceStatusLabel.textContent = describeLicenceStatus(licenceState);
  }
}

chrome.storage.local.get(['authSession', 'licenceState'], result => {
  renderAuthState(result.authSession, result.licenceState);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.authSession && !changes.licenceState) return;
  chrome.storage.local.get(['authSession', 'licenceState'], result => {
    renderAuthState(result.authSession, result.licenceState);
  });
});

authSignInBtn.addEventListener('click', () => {
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value;
  if (!email || !password) {
    showStatus('Enter both email and password', 'warning');
    return;
  }
  authSignInBtn.disabled = true;
  authSignInBtn.textContent = 'Signing in...';
  chrome.runtime.sendMessage({ action: 'authSignIn', email, password }, response => {
    authSignInBtn.disabled = false;
    authSignInBtn.textContent = 'Sign In';
    if (!response?.success) {
      showStatus(authErrorMessages[response?.error] || 'Sign-in failed. Try again.', 'error');
      return;
    }
    authPasswordInput.value = '';
    showStatus(
      response.requiresEmailVerification ? 'Signed in. Verify your email to continue.' : 'Signed in',
      response.requiresEmailVerification ? 'warning' : 'success'
    );
  });
});

authSignOutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'authSignOut' }, () => {
    authEmailInput.value = '';
    authPasswordInput.value = '';
    showStatus('Signed out', 'info');
  });
});

authRecheckBtn.addEventListener('click', () => {
  authRecheckBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'authRefreshLicence' }, response => {
    authRecheckBtn.disabled = false;
    showStatus(response?.success ? 'Licence rechecked' : 'Unable to recheck licence', response?.success ? 'success' : 'error');
  });
});

// Handle toggle change
toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;

  // Save to storage
  chrome.storage.sync.set({ autoFillEnabled: enabled });

  // Send message to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    chrome.tabs.sendMessage(tab.id, {
      action: 'toggleAutoFill',
      enabled: enabled
    }, () => {
      if (chrome.runtime.lastError) {
        showStatus('Please refresh the page for changes to take effect', 'warning');
        return;
      }
      showStatus(enabled ? 'Claim tools enabled' : 'Claim tools disabled', 'success');
    });
  } catch (error) {
    showStatus('Please refresh the page', 'warning');
  }
});

// Handle audit mode change (content script picks it up via storage.onChanged)
auditModeSelect.addEventListener('change', () => {
  const mode = auditModeSelect.value;
  chrome.storage.sync.set({ auditMode: mode });
  const labels = {
    off: 'Audit disabled',
    flag: 'Audit: flag-only mode',
    deduct: 'Audit: auto-deduct enabled for allowlisted rules'
  };
  showStatus(`${labels[mode]}. Applies on the next fill.`, mode === 'deduct' ? 'warning' : 'success');
});

function describeCounts(response) {
  const parts = [
    `${response?.approvedCount || 0} amount(s)`,
    `${response?.remarksCount || 0} remark(s)`
  ];
  if (response?.auditDeducted) parts.push(`${response.auditDeducted} audit deduction(s)`);
  if (response?.auditFlagged) parts.push(`${response.auditFlagged} audit flag(s)`);
  return parts.join(', ');
}

function blockedMessage(reason) {
  const messages = {
    'autofill-disabled': 'Claim Extension is OFF. Turn it on, then preview again.',
    'unsupported-layout': 'Unsupported RGHS portal layout. No fields were changed.',
    'invalid-rule-set': 'Audit rule validation failed. Reload a verified build.',
    'signed-out': 'Sign in to Claim Spark to apply changes.',
    'licence-unverified': 'Verify your email to continue — check your inbox for a link from Firebase.',
    'licence-apply-blocked': 'Your licence does not currently allow Apply. Preview remains available if allowed.',
    'licence-preview-blocked': 'Your licence does not currently allow Preview. Contact your administrator.'
  };
  return messages[reason] || 'Apply was blocked because the preview is stale or unsafe. Preview again.';
}

// Handle Fill Now button
fillNowBtn.addEventListener('click', async () => {
  fillNowBtn.disabled = true;
  fillNowBtn.textContent = previewCount > 0 ? 'Applying...' : 'Previewing...';

  try {
    if (previewCount === 0) {
      const response = await sendToActiveTab({ action: 'preview' });
      if (response?.blocked) {
        setFillButton();
        showStatus(blockedMessage(response.blockReason), 'error');
        return;
      }
      const proposals = response?.proposals || [];
      const hasHighRisk = proposals.some(proposal => proposal.risk === 'high');
      previewCount = hasHighRisk ? 0 : proposals.length;
      previewToken = hasHighRisk ? null : response?.token;
      previewRowKeys = hasHighRisk ? [] : proposals.map(proposal => proposal.key);
      if (hasHighRisk) {
        setFillButton();
        showStatus('High-risk findings require per-row review in Claim Spark.', 'warning');
        return;
      }
      if (previewCount > 0) {
        setFillButton(`Apply ${previewCount} Change${previewCount === 1 ? '' : 's'}`);
        showStatus(describeCounts(response), 'info');
      } else {
        setFillButton();
        undoBtn.disabled = !response?.hasUndo;
        showStatus(
          response?.hasUndo ? 'The previous manual fill can be undone.' : 'No eligible empty fields found',
          response?.hasUndo ? 'success' : 'info'
        );
      }
    } else {
      const response = await sendToActiveTab({
        action: 'fillNow',
        token: previewToken,
        selectedRowKeys: previewRowKeys,
        acknowledgedHighRisk: false
      });
      if (response?.blocked) {
        previewCount = 0;
        previewToken = null;
        previewRowKeys = [];
        setFillButton();
        showStatus(blockedMessage(response.blockReason), 'error');
        return;
      }
      previewCount = 0;
      previewToken = null;
      previewRowKeys = [];
      setFillButton();
      undoBtn.disabled = !response?.count;
      showStatus(`Applied: ${describeCounts(response)}`, 'success');
    }
  } catch (error) {
    previewCount = 0;
    previewToken = null;
    previewRowKeys = [];
    setFillButton();
    showStatus('Open an RGHS claim page, then refresh and try again', 'error');
  }
});

undoBtn.addEventListener('click', async () => {
  undoBtn.disabled = true;
  try {
    const response = await sendToActiveTab({ action: 'undo' });
    showStatus(response?.count ? `Restored ${response.count} field(s)` : 'Nothing to undo', response?.count ? 'success' : 'info');
  } catch (error) {
    showStatus('Unable to undo on this page', 'error');
  }
});

// Export the audit log as CSV (no downloads permission needed: blob + anchor)
exportLogBtn.addEventListener('click', () => {
  chrome.storage.local.get(['rghsAuditLog'], result => {
    const log = Array.isArray(result.rghsAuditLog) ? result.rghsAuditLog : [];
    if (log.length === 0) {
      showStatus('Audit log is empty', 'info');
      return;
    }
    const csv = AuditCore.auditLogToCsv(log);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rghs-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${log.length} audit entr${log.length === 1 ? 'y' : 'ies'}`, 'success');
  });
});

exportActivityBtn.addEventListener('click', () => {
  chrome.storage.local.get(['claimActivityLog'], result => {
    const log = Array.isArray(result.claimActivityLog) ? result.claimActivityLog : [];
    if (!log.length) {
      showStatus('Claim activity log is empty', 'info');
      return;
    }
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `claim-activity-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${log.length} privacy-safe activity event(s)`, 'success');
  });
});

// Two-step clear (popup windows cannot show confirm dialogs reliably)
clearLogBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearLogBtn.textContent = 'Really clear?';
    showStatus('Click again to permanently clear both local logs', 'warning');
    setTimeout(() => {
      clearArmed = false;
      clearLogBtn.textContent = 'Clear Log';
    }, 4000);
    return;
  }
  clearArmed = false;
  clearLogBtn.textContent = 'Clear Log';
  chrome.storage.local.set({ rghsAuditLog: [], claimActivityLog: [] }, () => {
    showStatus('Local audit and activity logs cleared', 'success');
  });
});

// Open the options page: per-rule statistics and auto-deduct promotion toggles
rulesStatsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Show status message
function showStatus(message, type = 'info') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.style.display = 'block';

  if (statusHideTimer !== null) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => {
    statusMessage.style.display = 'none';
    statusHideTimer = null;
  }, 3000);
}
