// Background service worker: per-tab badge with the count of open audit findings.

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request && request.action === 'setAuditBadge' && sender.tab && sender.tab.id !== undefined) {
    chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: request.count > 0 ? String(request.count) : ''
    });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#c0392b' });
  }
});
