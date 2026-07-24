const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, reconcile, validateApply, groupProposals, decisionForGroup } = require('../review-core');

const rows = [
  { key: 'r1', claimAmount: 1000, beforeApproved: 0, proposedApproved: 1000, beforeRemarks: '', proposedRemarks: null, risk: 'low', reason: 'Standard copy' },
  { key: 'r2', claimAmount: 1000, beforeApproved: 0, proposedApproved: 880, beforeRemarks: '', proposedRemarks: '12% deduction', risk: 'medium', reason: 'Medicine deduction' },
  { key: 'r3', claimAmount: 6000, beforeApproved: 6000, proposedApproved: 0, beforeRemarks: '', proposedRemarks: 'Unbundled', risk: 'high', reason: 'Audit deduction' }
];

test('fingerprint is stable across proposal order and changes when values change', () => {
  assert.equal(fingerprint(rows), fingerprint([...rows].reverse()));
  assert.notEqual(fingerprint(rows), fingerprint(rows.map(row => row.key === 'r1' ? { ...row, beforeApproved: 1 } : row)));
});

test('reconciliation returns selected before/after totals and deductions', () => {
  assert.deepEqual(reconcile(rows, ['r1', 'r2']), {
    rowCount: 2,
    claimTotal: 2000,
    beforeApprovedTotal: 0,
    proposedApprovedTotal: 1880,
    deductionTotal: 120,
    highRiskCount: 0,
    mediumRiskCount: 1,
    balanced: true
  });
});

test('stale, expired, empty, and unacknowledged high-risk previews are blocked', () => {
  const token = fingerprint(rows);
  const base = { previewToken: token, currentToken: token, createdAt: 1000, now: 2000, selectedProposals: rows, acknowledgedHighRisk: true };
  assert.equal(validateApply({ ...base, currentToken: 'changed' }).reason, 'stale');
  assert.equal(validateApply({ ...base, now: 700000 }).reason, 'expired');
  assert.equal(validateApply({ ...base, selectedProposals: [] }).reason, 'empty-selection');
  assert.equal(validateApply({ ...base, acknowledgedHighRisk: false }).reason, 'high-risk-unacknowledged');
  assert.equal(validateApply(base).ok, true);
});

test('related findings become one decision group with calculated safe and override outcomes', () => {
  const proposals = [
    { key: 'ptca', groupId: 'CA-01', ruleIds: ['CA-01'], risk: 'high', decisionRole: 'main', decisionMethod: 'inclusive-components', claimAmount: 97865, recommendedApproved: 97865, recommendedDeductionCap: null },
    { key: 'cag', groupId: 'CA-01', ruleIds: ['CA-01'], risk: 'high', decisionRole: 'component', decisionMethod: 'inclusive-components', claimAmount: 6325, recommendedApproved: 0, recommendedDeductionCap: null }
  ];
  const [group] = groupProposals(proposals);
  assert.equal(group.id, 'CA-01');
  assert.deepEqual(decisionForGroup(group, 'recommended'), {
    selectedKeys: ['ptca', 'cag'],
    approvedOverrides: { ptca: 97865, cag: 0 },
    remarkDispositions: { ptca: 'approved', cag: 'deducted' },
    acknowledgementRequired: false
  });
  assert.deepEqual(decisionForGroup(group, 'approve-all'), {
    selectedKeys: ['ptca', 'cag'],
    approvedOverrides: { ptca: 97865, cag: 6325 },
    remarkDispositions: { ptca: 'approved', cag: 'approved' },
    acknowledgementRequired: true
  });
  assert.deepEqual(decisionForGroup(group, 'main-only').approvedOverrides, { ptca: 97865, cag: 0 });
  assert.deepEqual(decisionForGroup(group, 'hold').selectedKeys, []);
});

test('fixed-deduction recommendations cannot combine package and component deductions', () => {
  const unsafe = { id: 'FIXED', proposals: [
    { key: 'main', risk: 'high', decisionRole: 'main', decisionMethod: 'fixed-main-adjustment', claimAmount: 97865, recommendedApproved: 91865, recommendedDeductionCap: 6000 },
    { key: 'component', risk: 'high', decisionRole: 'component', decisionMethod: 'fixed-main-adjustment', claimAmount: 6325, recommendedApproved: 0, recommendedDeductionCap: 6000 }
  ] };
  assert.equal(decisionForGroup(unsafe, 'recommended').invalidReason, 'recommended-method-conflict');
});

test('inclusive and duplicate recommendations cannot deduct their retained row', () => {
  const unsafeInclusive = { id: 'BUNDLE', proposals: [
    { key: 'bundle', risk: 'high', decisionRole: 'main', decisionMethod: 'inclusive-components', claimAmount: 500, recommendedApproved: 400 },
    { key: 'component', risk: 'high', decisionRole: 'component', decisionMethod: 'inclusive-components', claimAmount: 100, recommendedApproved: 0 }
  ] };
  const unsafeDuplicate = { id: 'DUP', proposals: [
    { key: 'first', risk: 'high', decisionRole: 'primary', decisionMethod: 'duplicate-after-first', claimAmount: 100, recommendedApproved: 0 },
    { key: 'repeat', risk: 'high', decisionRole: 'component', decisionMethod: 'duplicate-after-first', claimAmount: 100, recommendedApproved: 0 }
  ] };
  assert.equal(decisionForGroup(unsafeInclusive, 'recommended').invalidReason, 'recommended-method-conflict');
  assert.equal(decisionForGroup(unsafeDuplicate, 'recommended').invalidReason, 'recommended-method-conflict');
});
