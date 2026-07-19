const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const submitControlSource = content.slice(
  content.indexOf('function isPortalSubmitControl'),
  content.indexOf('function showSubmissionInterlock')
).trim();
const isPortalSubmitControl = Function(`return (${submitControlSource})`)();

function controlFixture({ label = '', value = '', explicitSubmit = false, form = null, computedType = 'button' } = {}) {
  const control = {
    textContent: label,
    value,
    type: computedType,
    form,
    matches(selector) {
      return explicitSubmit && selector === 'input[type="submit"], button[type="submit"]';
    }
  };
  return { closest: () => control };
}

function formFixture({ claim = false, id = '', name = '', action = '' } = {}) {
  return {
    id,
    name,
    getAttribute(attribute) { return attribute === 'action' ? action : null; },
    querySelector() { return claim ? {} : null; }
  };
}

test('submission interlock blocks without acknowledgement and never clicks Submit', () => {
  assert.match(content, /event\.preventDefault\(\)[\s\S]*?showSubmissionInterlock\(\)/);
  assert.match(content, /Allow next Submit click/);
  assert.match(content, /submitArmedUntil = Date\.now\(\) \+ 2 \* 60 \* 1000/);
  assert.doesNotMatch(content, /\.click\(\)[^;]*submit/i);
  assert.doesNotMatch(content, /requestSubmit\s*\(/);
});

test('submission control detection neither blocks default portal buttons nor misses Submit Claim', () => {
  assert.equal(isPortalSubmitControl(controlFixture({ label: 'Search', computedType: 'submit' })), false,
    'a button without a type attribute must not be inferred from its computed submit type');
  assert.equal(isPortalSubmitControl(controlFixture({ value: 'Submit Claim' })), true,
    'an input[type=button] labelled Submit Claim must be guarded');
  assert.equal(isPortalSubmitControl(controlFixture({ label: 'Expand' })), false);
});

test('unlabelled explicit submitters are guarded only when attached to the claim form', () => {
  assert.equal(isPortalSubmitControl(controlFixture({
    explicitSubmit: true,
    computedType: 'submit',
    form: formFixture({ claim: true })
  })), true);
  assert.equal(isPortalSubmitControl(controlFixture({
    explicitSubmit: true,
    computedType: 'submit',
    form: formFixture({ id: 'searchForm' })
  })), false);
});

test('submission summary normalizes spoofed sessionStorage values before use', () => {
  const normalizationSource = content.slice(
    content.indexOf('function normalizeNonnegativeNumber'),
    content.indexOf('function restoreAppliedSummary')
  );
  const normalizeAppliedSummary = Function(
    `${normalizationSource}; return normalizeAppliedSummary;`
  )();
  const normalized = normalizeAppliedSummary({
    createdAt: '1234',
    path: '/RGHS/processSheetSearch/claim',
    selectedRows: '<img src=x onerror=alert(1)>',
    changedFields: '7.9',
    highRiskCount: -4,
    proposedApprovedTotal: '<b>forged</b>',
    deductionTotal: Infinity,
    ruleIds: '<script>bad()</script>'
  });

  assert.deepEqual(normalized, {
    createdAt: 1234,
    path: '/RGHS/processSheetSearch/claim',
    tid: '',
    selectedRows: 0,
    changedFields: 7,
    highRiskCount: 0,
    proposedApprovedTotal: 0,
    deductionTotal: 0,
    ruleIds: []
  });
});

test('submission interlock renders summary values only through textContent', () => {
  const interlock = content.slice(
    content.indexOf('function showSubmissionInterlock'),
    content.indexOf('function installSubmissionInterlock')
  );
  assert.doesNotMatch(interlock, /\$\{summary\.(?:selectedRows|changedFields|proposedApprovedTotal|deductionTotal|highRiskCount)\}/);
  assert.match(interlock, /data-summary="selectedRows"/);
  assert.match(interlock, /\.textContent = prefix \+ String\(value\)/);
});

test('privacy-safe activity entries exclude patient clinical and free-text fields', () => {
  const activityFunction = content.slice(
    content.indexOf('function appendClaimActivity'),
    content.indexOf('function clearAppliedSummary')
  );
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
