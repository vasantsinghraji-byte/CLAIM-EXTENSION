'use strict';

const container = document.getElementById('items');
const actions = document.getElementById('actions');
const previewButton = document.getElementById('preview');
const applyButton = document.getElementById('apply');
const copyButton = document.getElementById('copy');
const discardButton = document.getElementById('discard');
const status = document.getElementById('status');
const reconnectButton = document.getElementById('reconnect');
let companionTid = '';
let previewToken = '';
let processPort = null;
let requestSequence = 0;
const pendingRequests = new Map();

function savedCountsKey() {
  return `investigationCompanionCounts:${companionTid}`;
}

function getSavedCounts() {
  return new Promise(resolve => chrome.storage.session.get(savedCountsKey(), saved => {
    resolve(chrome.runtime.lastError ? {} : saved[savedCountsKey()] || {});
  }));
}

function saveCounts() {
  if (!companionTid) return;
  const counts = Object.fromEntries([...container.querySelectorAll('input[data-index]')]
    .map(input => [input.dataset.index, input.value]));
  chrome.storage.session.set({ [savedCountsKey()]: counts }, () => { void chrome.runtime.lastError; });
}

function clearSavedCounts() {
  return new Promise(resolve => chrome.storage.session.remove(savedCountsKey(), () => resolve()));
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

function queryTabs() {
  return new Promise((resolve, reject) => chrome.tabs.query({}, tabs => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(tabs);
  }));
}

function requestProcessSheet(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!processPort) return reject(new Error('Matching process sheet is unavailable.'));
    const id = ++requestSequence;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('The process sheet did not respond.'));
    }, 10000);
    pendingRequests.set(id, { resolve, reject, timeout });
    processPort.postMessage({ id, action, ...payload });
  });
}

async function connectProcessSheet() {
  const tabs = await queryTabs();
  const sheet = tabs.find(tab => tab.url?.includes(`/RGHS/processSheetSearch/${companionTid}/`));
  if (!sheet?.id) throw new Error('Matching process sheet is unavailable. Open the matching process sheet first.');
  processPort = chrome.tabs.connect(sheet.id, { name: 'investigation-checklist' });
  processPort.onDisconnect.addListener(() => {
    processPort = null;
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process-sheet connection was closed.'));
    }
    pendingRequests.clear();
  });
  processPort.onMessage.addListener(message => {
    const pending = pendingRequests.get(message?.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.success === false) pending.reject(new Error(message.error || 'Process-sheet request failed.'));
    else pending.resolve(message);
  });
  return requestProcessSheet('getChecklist');
}

async function renderItems(items) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No investigation rows with expected quantities were found on the matching process sheet.';
    container.appendChild(empty);
    return;
  }
  const savedCounts = await getSavedCounts();
  for (const item of items) {
    const row = document.createElement('label');
    row.className = 'item';
    const label = document.createElement('span');
    label.textContent = `${item.label} — expected: ${item.expected}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(item.expected);
    const saved = savedCounts[String(item.index)];
    const savedValue = Number(saved);
    input.value = Number.isFinite(savedValue) && savedValue >= 0 && savedValue <= item.expected
      ? String(savedValue) : String(item.expected);
    input.dataset.index = String(item.index);
    input.setAttribute('aria-label', `${item.label}: reports found`);
    input.addEventListener('input', () => {
      previewToken = '';
      applyButton.disabled = true;
      saveCounts();
    });
    row.append(label, input);
    container.appendChild(row);
  }
  actions.hidden = false;
  status.textContent = 'Connected directly to the matching process sheet.';
}

function showConnectionError(error) {
  status.textContent = String(error?.message || error);
  reconnectButton.hidden = false;
}

chrome.storage.session.get('investigationCompanion', ({ investigationCompanion }) => {
  companionTid = String(investigationCompanion?.tid || '');
  if (!companionTid) return showConnectionError('Claim identifier is unavailable. Reopen the Investigation Report from the IPD main page.');
  connectProcessSheet().then(result => renderItems(result.items || [])).catch(showConnectionError);
});

previewButton.addEventListener('click', async () => {
  const verifiedCounts = [...container.querySelectorAll('input')]
    .map(input => ({ index: Number(input.dataset.index), found: input.value }));
  previewButton.disabled = true;
  status.textContent = 'Preparing process-sheet changes…';
  try {
    const result = await requestProcessSheet('preview', { verifiedCounts });
    if (!result.proposals?.length) throw new Error('Enter valid report counts before previewing.');
    previewToken = result.token;
    applyButton.disabled = false;
    status.textContent = `${result.proposals.length} investigation row(s) prepared. Click Apply to update the process sheet.`;
  } catch (error) {
    showConnectionError(error);
  } finally {
    previewButton.disabled = false;
  }
});

applyButton.addEventListener('click', async () => {
  if (!previewToken) return;
  applyButton.disabled = true;
  status.textContent = 'Applying verified quantities to the process sheet…';
  try {
    const result = await requestProcessSheet('apply', { token: previewToken });
    if (result.blocked) throw new Error('The verification became stale. Preview again.');
    previewToken = '';
    await clearSavedCounts();
    status.textContent = `Applied ${result.changedFieldCount || 0} process-sheet field change(s).`;
  } catch (error) {
    showConnectionError(error);
    applyButton.disabled = false;
  }
});

discardButton.addEventListener('click', async () => {
  await clearSavedCounts();
  previewToken = '';
  applyButton.disabled = true;
  for (const input of container.querySelectorAll('input[data-index]')) {
    input.value = input.max;
  }
  status.textContent = 'Saved investigation counts discarded.';
});

copyButton.addEventListener('click', async () => {
  const lines = [`Investigation verification review — Claim TID: ${companionTid || 'Unavailable'}`];
  for (const row of container.querySelectorAll('.item')) {
    const label = row.querySelector('span')?.textContent || 'Investigation';
    const found = row.querySelector('input')?.value || 'Not entered';
    lines.push(`${label}; reports found: ${found}`);
  }
  try {
    await copyText(lines.join('\n'));
    status.textContent = 'Investigation review summary copied to the clipboard.';
  } catch (error) {
    showConnectionError(error);
  }
});

reconnectButton.addEventListener('click', () => {
  reconnectButton.hidden = true;
  status.textContent = 'Connecting to the matching process sheet…';
  connectProcessSheet().then(result => renderItems(result.items || [])).catch(showConnectionError);
});
