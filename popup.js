// Popup script for controlling the extension

const toggle = document.getElementById('autoFillToggle');
const fillNowBtn = document.getElementById('fillNowBtn');
const statusMessage = document.getElementById('statusMessage');

// Load initial state
chrome.storage.sync.get(['autoFillEnabled'], (result) => {
  toggle.checked = result.autoFillEnabled !== false; // Default to true
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
    }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus('Please refresh the page for changes to take effect', 'warning');
        return;
      }
      showStatus(enabled ? 'Auto-fill enabled' : 'Auto-fill disabled', 'success');
    });
  } catch (error) {
    showStatus('Please refresh the page', 'warning');
  }
});

// Handle Fill Now button
fillNowBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Disable button temporarily
  fillNowBtn.disabled = true;
  fillNowBtn.textContent = 'Filling...';

  try {
    chrome.tabs.sendMessage(tab.id, {
      action: 'fillNow'
    }, (response) => {
      fillNowBtn.disabled = false;
      fillNowBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M13.5 3.5L6 11L2.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Fill Now
      `;

      if (chrome.runtime.lastError) {
        showStatus('Error: Please refresh the page and try again', 'error');
        return;
      }

      if (response && response.count !== undefined) {
        if (response.count > 0) {
          showStatus(`Successfully filled ${response.count} field(s)`, 'success');
        } else {
          showStatus('No fields to fill. Check console (F12) for details', 'info');
        }
      } else {
        showStatus('Extension loaded. Check console (F12) for details', 'info');
      }
    });
  } catch (error) {
    fillNowBtn.disabled = false;
    fillNowBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M13.5 3.5L6 11L2.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Fill Now
    `;
    showStatus('Error: Please refresh the page', 'error');
  }
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
