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
  assert.doesNotMatch(source, /MutationObserver/);
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
