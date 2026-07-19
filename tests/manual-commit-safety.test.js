const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('page load and storage initialization never apply claim changes', () => {
  const initialization = source.slice(
    source.indexOf("chrome.storage.sync.get"),
    source.indexOf('// Listen for messages from popup')
  );
  assert.doesNotMatch(initialization, /fillAllApprovedAmounts\s*\(/);
  assert.match(source, /new MutationObserver[\s\S]*?schedulePassiveAudit\(addedNodes\)/);
  assert.match(source, /function refreshPassiveAuditHighlights\(\)[\s\S]*?fillAllApprovedAmounts\(\{ apply: false \}\)/);
  assert.doesNotMatch(source, /function refreshPassiveAuditHighlights\(\)[\s\S]*?fillAllApprovedAmounts\(\{ apply: true \}\)/);
});

test('enabling claim tools never applies claim changes', () => {
  const toggleBranch = source.slice(
    source.indexOf("request.action === 'toggleAutoFill'"),
    source.indexOf("request.action === 'fillNow'")
  );
  assert.doesNotMatch(toggleBranch, /fillAllApprovedAmounts\s*\(/);
});

test('writes remain behind explicit fillNow and Apply actions', () => {
  assert.match(source, /request\.action === 'fillNow'[\s\S]*?applyReviewedPreview\(request\)/);
  assert.match(source, /apply\(options\)\s*{[\s\S]*?applyReviewedPreview\(options\)/);
  assert.match(source, /function applyReviewedPreview[\s\S]*?fillAllApprovedAmounts\(\{\s*apply: true/);
});

test('explicitly selected review rows receive an approved amount while unselected rows remain untouched', () => {
  assert.match(source, /const reviewedApproval = deductAction \? null : Core\.planRowUpdate/);
  assert.match(source, /if \(apply && selectedRowKeys && !selectedRowKeys\.has\(key\)\) continue;[\s\S]*?const approvedOverride =[\s\S]*?setCellValue\(record\.approvedCell, approvedOverride, batch\)/);
});

test('exception-only workflow applies safe rows separately and validates decision overrides', () => {
  assert.match(source, /approvedOverrides = \{\}/);
  assert.match(source, /blockReason: 'invalid-decision'/);
  assert.match(source, /fillAllApprovedAmounts\(\{[\s\S]*?approvedOverrides/);
});

test('group decisions keep approved and deducted portal rows visibly distinct', () => {
  assert.match(source, /rghs-decision-approve/);
  assert.match(source, /rghs-decision-deduct/);
  assert.match(source, /function highlightDecisionRows\(approvedByKey = \{\}\)/);
});

test('audit rows are highlighted read-only as soon as the process sheet loads', () => {
  assert.match(source, /rghs-audit-passive/);
  assert.match(source, /installPassiveAuditObserver\(\);/);
  assert.match(source, /proposal\.risk !== 'high'/);
});

test('failed persistent recovery keeps the only saved snapshot', () => {
  const recovery = source.slice(
    source.indexOf('function restorePersistentSnapshot'),
    source.indexOf('function hasPersistentRecovery')
  );
  assert.match(recovery, /if \(!element\?\.isConnected\) continue;/);
  assert.match(recovery, /if \(count === 0\) return resolve\(\{ count: 0, hasRecovery: true \}\);/);
  assert.ok(
    recovery.indexOf('count === 0') < recovery.indexOf("action: 'removeRecoverySnapshot'"),
    'the zero-restore guard must run before snapshot removal'
  );
  assert.match(recovery, /const fullyRestored = count === snapshot\.entries\.length;/);
  assert.match(recovery, /resolve\(\{ count, hasRecovery: !fullyRestored \}\)/);
});

test('session undo restores only connected controls and preserves recovery after partial failure', () => {
  const undo = source.slice(
    source.indexOf('function undoLastFill'),
    source.indexOf('globalThis.ClaimAutoFillActions')
  );
  assert.match(undo, /if \(!element\?\.isConnected\) continue;/);
  assert.match(undo, /appendClaimActivity\('undo', \{ fieldCount: count \}\)/);
  assert.match(undo, /if \(count === batch\.length\)[\s\S]*?removeRecoverySnapshot/);
  assert.match(undo, /return count;/);
});

test('fallback input matching participates in preview and reviewed apply', () => {
  const fallback = source.slice(
    source.indexOf('// Fallback: Find by input name/id attributes'),
    source.indexOf('if (apply && batch.length > 0) undoBatch = batch')
  );
  assert.match(fallback, /if \(proposals\.length === 0\)/);
  assert.match(fallback, /const key = `fallback-\$\{inputIndex\}-\$\{siblingIndex\}`/);
  assert.match(fallback, /proposals\.push\(\{[\s\S]*?proposedApproved: amount,[\s\S]*?risk: 'low'/);
  assert.match(fallback, /rowElements\.set\(key, parent\)/);
  assert.match(fallback, /if \(apply && selectedRowKeys && !selectedRowKeys\.has\(key\)\) continue;/);
});

test('fallback preview counts only emitted proposals and never performs a write', () => {
  const fallback = source.slice(
    source.indexOf('// Fallback: Find by input name/id attributes'),
    source.indexOf('if (apply && batch.length > 0) undoBatch = batch')
  );
  assert.ok(fallback.indexOf('proposals.push') < fallback.indexOf('approvedCount++'));
  assert.match(fallback, /if \(apply\) \{[\s\S]*?setElementValue\(sib, approvedValue\);[\s\S]*?\}\s*approvedCount\+\+/);
  assert.match(fallback, /: String\(amount\);/);
  assert.doesNotMatch(fallback, /: claimVal;/);
});

test('disabled apply returns a complete blocked result and cannot record an applied summary', () => {
  const blockedResult = source.slice(
    source.indexOf('function blockedFillResult'),
    source.indexOf('// Fill all approved amounts')
  );
  assert.match(blockedResult, /changedFieldCount: 0/);
  assert.match(source, /if \(!isAutoFillEnabled && apply\) \{\s*return blockedFillResult\('autofill-disabled'\);/);

  const reviewedApply = source.slice(
    source.indexOf('function applyReviewedPreview'),
    source.indexOf('function clearDecisionHighlights')
  );
  assert.ok(
    reviewedApply.indexOf('if (result.blocked)') < reviewedApply.indexOf('lastAppliedSummary ='),
    'a disabled apply must return before persisting an applied summary'
  );
});

test('findTid retries an early SPA miss and caches only a successful match', () => {
  const findTidSource = source.slice(
    source.indexOf('function findTid()'),
    source.indexOf('let localStorageMutationChain')
  ).trim();
  let bodyText = 'Process sheet is loading';
  const documentFixture = {
    title: 'RGHS Process Sheet',
    body: { get textContent() { return bodyText; } }
  };
  const findTid = Function(
    'document',
    `let cachedTid; return (${findTidSource});`
  )(documentFixture);

  assert.equal(findTid(), '', 'an early miss should return empty without becoming permanent');
  bodyText = 'Claim details TID: RGHS/2026/12345';
  assert.equal(findTid(), 'RGHS/2026/12345', 'a later SPA render should be discovered');
  bodyText = 'Claim details TID: DIFFERENT/9999';
  assert.equal(findTid(), 'RGHS/2026/12345', 'a successful TID may remain cached for the page');
});

test('nested tables and their rows have exactly one scan owner', () => {
  const collectionSource = source.slice(
    source.indexOf('function collectTables'),
    source.indexOf('function collectInputs')
  );
  const makeCollectors = Function(
    'Node',
    'document',
    `${collectionSource}; return { collectTables, getDirectTableRows, getDirectRowCells };`
  );
  const documentFixture = { nodeType: 9 };
  const outer = {
    parentElement: null,
    matches: () => false,
    closest: () => null
  };
  const inner = {
    parentElement: { closest: selector => selector === 'table' ? outer : null },
    matches: () => false,
    closest: () => outer
  };
  documentFixture.querySelectorAll = selector => selector === 'table' ? [outer, inner] : [];
  const collectors = makeCollectors({ ELEMENT_NODE: 1 }, documentFixture);

  assert.deepEqual(collectors.collectTables([documentFixture]), [outer]);

  let tableSelector = '';
  const directRows = [{ id: 'outer-header' }, { id: 'outer-data' }];
  assert.deepEqual(collectors.getDirectTableRows({
    querySelectorAll(selector) { tableSelector = selector; return directRows; }
  }), directRows);
  assert.match(tableSelector, /:scope > tbody > tr/);

  let cellSelector = '';
  collectors.getDirectRowCells({ querySelectorAll(selector) { cellSelector = selector; return []; } });
  assert.equal(cellSelector, ':scope > th, :scope > td');

  const fillScan = source.slice(
    source.indexOf('tables.forEach((table, tableIndex)'),
    source.indexOf('// Second pass: audit')
  );
  assert.match(fillScan, /const allRows = getDirectTableRows\(table\)/);
  assert.doesNotMatch(fillScan, /table\.querySelectorAll\('tr'\)/);
  assert.doesNotMatch(fillScan, /row\.querySelectorAll\(['"](?:th, td|td, th)['"]\)/);
});

test('passive audit logging and badge updates are deduplicated', () => {
  const badgeSource = source.slice(
    source.indexOf('function updateAuditBadge'),
    source.indexOf('function formatPreview')
  );
  const sent = [];
  const chromeFixture = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) { sent.push(message); callback(); }
    }
  };
  const updateAuditBadge = Function(
    'chrome',
    `let lastAuditBadgeCount = null; return (${badgeSource});`
  )(chromeFixture);

  updateAuditBadge(3);
  updateAuditBadge(3);
  updateAuditBadge(4);
  assert.deepEqual(sent.map(message => message.count), [3, 4]);

  const fill = source.slice(
    source.indexOf('function fillAllApprovedAmounts'),
    source.indexOf('function formatPreview')
  );
  assert.doesNotMatch(fill, /console\.log/);
  assert.match(source, /function debugLog\(\.\.\.args\) \{\s*if \(DEBUG\) console\.log\(\.\.\.args\);/);
});
