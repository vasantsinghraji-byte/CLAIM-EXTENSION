const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

test('portal submission is never intercepted or replayed by the extension', () => {
  assert.doesNotMatch(content, /addEventListener\(['"]submit['"]/);
  assert.doesNotMatch(content, /claim-extension-submit-guard/);
  assert.doesNotMatch(content, /(?:requestSubmit|submitArmedUntil|resumePortalSubmission|showSubmissionInterlock)/);
  assert.doesNotMatch(content, /submit-(?:blocked|acknowledged)/);
});

test('privacy-safe activity entries exclude patient clinical and free-text fields', () => {
  const activityStart = content.indexOf('function appendClaimActivity');
  const activityFunction = content.slice(activityStart, content.indexOf('// Auditor feedback buttons', activityStart));
  assert.match(activityFunction, /appendStorageEntries\('claimActivityLog', \[entry\]\)/);
  assert.doesNotMatch(activityFunction, /chrome\.storage\.local\.(?:get|set)/);
  assert.doesNotMatch(activityFunction, /\b(?:patientName|diagnosis|treatment|remarks?|rowLabel|packageLabel)\s*:/i);
});

test('real RGHS process sheets are preflighted before any fill processing', () => {
  const fillStart = content.slice(content.indexOf('function fillAllApprovedAmounts'), content.indexOf("console.log('[Claim Auto-Fill] Starting"));
  assert.match(fillStart, /inspectPortalLayout\(\)/);
  assert.match(fillStart, /unsupported-layout/);
  assert.match(fillStart, /invalid-rule-set/);
});

test('licence gate blocks Apply when signed out or unlicensed, but never blocks a signed-out Preview', () => {
  const gateSource = content.slice(
    content.indexOf('function evaluateLicenceGate'),
    content.indexOf('function blockedFillResult')
  ).trim();
  const evaluateLicenceGate = Function(`return (${gateSource})`)();

  assert.deepEqual(evaluateLicenceGate(null, false), { blocked: false });
  assert.deepEqual(evaluateLicenceGate(null, true), { blocked: true, reason: 'signed-out' });
  assert.deepEqual(
    evaluateLicenceGate({ status: 'active', previewAllowed: true, applyAllowed: true }, true),
    { blocked: false }
  );
  assert.deepEqual(
    evaluateLicenceGate({ status: 'expired', previewAllowed: false, applyAllowed: false }, true),
    { blocked: true, reason: 'licence-apply-blocked' }
  );
  assert.deepEqual(
    evaluateLicenceGate({ status: 'unverified', previewAllowed: false, applyAllowed: false }, true),
    { blocked: true, reason: 'licence-unverified' }
  );
  assert.deepEqual(
    evaluateLicenceGate({ status: 'expired', previewAllowed: false, applyAllowed: false }, false),
    { blocked: true, reason: 'licence-preview-blocked' }
  );
  assert.deepEqual(
    evaluateLicenceGate({ status: 'grace', previewAllowed: true, applyAllowed: false }, false),
    { blocked: false }
  );
});
