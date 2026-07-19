// Popup script for controlling the extension

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
    }, (response) => {
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

// Handle Fill Now button
fillNowBtn.addEventListener('click', async () => {
  fillNowBtn.disabled = true;
  fillNowBtn.textContent = previewCount > 0 ? 'Applying...' : 'Previewing...';

  try {
    if (previewCount === 0) {
      const response = await sendToActiveTab({ action: 'preview' });
      if (response?.blocked) {
        setFillButton();
        const reason = response.blockReason === 'unsupported-layout'
          ? 'Unsupported RGHS portal layout. No fields were changed.'
          : 'Audit rule validation failed. Reload a verified build.';
        showStatus(reason, 'error');
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
        showStatus('Apply blocked because the preview is stale or unsafe. Preview again.', 'error');
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
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
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

  // Hide after 3 seconds
  setTimeout(() => {
    statusMessage.style.display = 'none';
  }, 3000);
}
