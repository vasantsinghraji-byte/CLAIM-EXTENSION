const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'floating-widget.js'), 'utf8');

test('stale floating widget guards Chrome API calls after extension reload', () => {
  assert.match(source, /function hasValidExtensionContext\(\)/);
  assert.match(source, /Refresh this process-sheet page to reconnect Claim Spark Review/);
  assert.match(source, /withValidExtensionContext\(\(\) => chrome\.storage\.local\.set/);
  assert.match(source, /withValidExtensionContext\(\(\) => renderPreview\(actions\.preview\(\)\)\)/);
  assert.match(source, /withValidExtensionContext\(\(\) => \{ result = actions\.undo\(\); \}\)/);
  assert.match(source, /if \(!hasValidExtensionContext\(\)\) \{[\s\S]*?invalidateStaleWidget\(\);[\s\S]*?setOpen\(panel\.hidden\)/);
  assert.match(source, /withValidExtensionContext\(\(\) => chrome\.storage\.local\.get/);
  assert.match(source, /withValidExtensionContext\(\(\) => \{[\s\S]*?actions\.hasRecovery/);
});

test('floating widget exposes safe-row automation and grouped decision controls', () => {
  assert.match(source, /Apply Safe Rows Now/);
  assert.match(source, /Review\.groupProposals\(result\.proposals\)/);
  assert.match(source, /Approve both\/all/);
  assert.match(source, /Approve main only/);
  assert.match(source, /Apply package deduction/);
  assert.match(source, /exceptionalGroups\.size === 0 \|\| ackCheck\.checked/);
  assert.match(source, /actions\.highlightDecisionRows\(approvedOverrides\)/);
});
