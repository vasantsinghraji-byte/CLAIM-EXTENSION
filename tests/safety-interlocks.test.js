const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('submission interlock blocks without acknowledgement and never clicks Submit', () => {
  assert.match(content, /event\.preventDefault\(\)[\s\S]*?showSubmissionInterlock\(\)/);
  assert.match(content, /Allow next Submit click/);
  assert.match(content, /submitArmedUntil = Date\.now\(\) \+ 2 \* 60 \* 1000/);
  assert.doesNotMatch(content, /\.click\(\)[^;]*submit/i);
  assert.doesNotMatch(content, /requestSubmit\s*\(/);
});

test('privacy-safe activity entries exclude patient clinical and free-text fields', () => {
  const activityFunction = content.slice(
    content.indexOf('function appendClaimActivity'),
    content.indexOf('function clearAppliedSummary')
  );
  assert.match(activityFunction, /claimActivityLog/);
  assert.match(activityFunction, /slice\(-500\)/);
  assert.match(activityFunction, /30 \* 24 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(activityFunction, /\b(?:patientName|diagnosis|treatment|remarks?|rowLabel|packageLabel)\s*:/i);
});

test('real RGHS process sheets are preflighted before any fill processing', () => {
  const fillStart = content.slice(content.indexOf('function fillAllApprovedAmounts'), content.indexOf("console.log('[Claim Auto-Fill] Starting"));
  assert.match(fillStart, /inspectPortalLayout\(\)/);
  assert.match(fillStart, /unsupported-layout/);
  assert.match(fillStart, /invalid-rule-set/);
});
