'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../claim-core');
const Review = require('../review-core');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

function setup() {
  const cell = (id, value) => ({ id, value, isConnected: true, dataset: {} });
  const row = {
    index: 0, label: 'INV-01', expected: 4, rate: 100, claimAmount: 400,
    approvedCell: cell('packageFinalAmount_0', '400'), remarksCell: cell('packageremarks_0', 'Keep this remark'), rowEl: {}
  };
  const context = vm.createContext({
    Core, Review, Date, Map, console, row,
    isAutoFillEnabled: true, licenceState: { status: 'active', applyAllowed: true, previewAllowed: true },
    processingRuleSet: { mode: 'bundled' }, investigationChecklistPreview: null,
    investigationApplyInFlight: false, undoBatch: [], refreshOk: true, recoveryOk: true, tid: 'synthetic-test',
    raw: { proposals: [], rowElements: new Map() },
    getInvestigationChecklist: () => [{ ...row }],
    getCellValue: element => element.value,
    getElementValue: element => element.value,
    setElementValue: (element, value) => { element.value = value; },
    setCellValue: (element, value, batch) => {
      batch.push({ element, value: element.value, after: String(value) });
      element.value = String(value);
    },
    appendClaimActivity: () => {}, getMatchingRecoverySnapshot: () => {},
    window: { dispatchEvent: () => {} }, CustomEvent: class {},
    findTid: () => context.tid,
    fillAllApprovedAmounts: () => context.raw,
    refreshProcessingRules: async () => ({ ok: context.refreshOk }),
    persistRecoverySnapshot: async () => context.recoveryOk
  });
  vm.runInContext([
    section('function evaluateLicenceGate(', '// Fill all approved amounts'),
    section('function currentClaimContext(', 'function persistRecoverySnapshot('),
    section('function investigationRuleIdentity()', 'function findIpdActionSelect()'),
    section('async function finalizeRecovery(', 'function getMatchingRecoverySnapshot('),
    section('function restoreFillBatch(', 'function undoLastFill(')
  ].join('\n'), context);
  const preview = counts => context.previewInvestigationVerification(counts || [{ index: 0, found: '3' }]);
  const apply = token => context.applyInvestigationVerification(token, { acknowledgedHighRisk: true });
  return { context, row, preview, apply };
}

test('investigation Apply requires explicit reduction acknowledgement and persists both fields', async () => {
  const { context, row, preview, apply } = setup();
  const result = preview();
  assert.equal((await context.applyInvestigationVerification(result.token)).blockReason, 'high-risk-unacknowledged');
  assert.equal(row.approvedCell.value, '400');
  const applied = await apply(result.token);
  assert.equal(applied.blocked, false);
  assert.equal(applied.recoverySaved, true);
  assert.equal(row.approvedCell.value, '300');
  assert.match(row.remarksCell.value, /^Keep this remark; Investigation verification: 3 of 4/);
  assert.equal(row.approvedCell.dataset.claimExtensionInvestigationVerified, 'true');
});

test('investigation Apply blocks disabled, signed-out and unlicensed states', async () => {
  for (const state of ['disabled', 'signed-out', 'suspended']) {
    const { context, row, preview, apply } = setup();
    const result = preview();
    if (state === 'disabled') context.isAutoFillEnabled = false;
    else context.licenceState = state === 'signed-out' ? null : { status: state, applyAllowed: false };
    assert.equal((await apply(result.token)).blocked, true, state);
    assert.equal(row.approvedCell.value, '400');
  }
});

test('investigation Apply rejects changed values, metadata, controls, claim and expired previews', async () => {
  const changes = [
    ({ row }) => { row.approvedCell.value = '350'; },
    ({ row }) => { row.remarksCell.value = 'New processor remark'; },
    ({ row }) => { row.rate = 110; },
    ({ row }) => { row.expected = 5; },
    ({ row }) => { row.approvedCell = { ...row.approvedCell }; },
    ({ row }) => { row.approvedCell.isConnected = false; },
    ({ context }) => { context.tid = 'another-synthetic-claim'; },
    ({ context }) => { context.investigationChecklistPreview.createdAt -= 11 * 60 * 1000; }
  ];
  for (const change of changes) {
    const fixture = setup();
    const result = fixture.preview();
    change(fixture);
    assert.equal((await fixture.apply(result.token)).blocked, true);
  }
});

test('investigation Apply blocks rule changes, unavailable rules and mandatory policy bypasses', async () => {
  for (const condition of ['version', 'unavailable', 'mandatory', 'audited-row']) {
    const { context, row, preview, apply } = setup();
    const result = preview();
    if (condition === 'version') context.processingRuleSet.versionId = 'new-policy';
    if (condition === 'unavailable') context.refreshOk = false;
    if (condition === 'mandatory') context.raw.proposals = [{ key: 'mandatory', mandatory: true }];
    if (condition === 'audited-row') {
      context.raw.proposals = [{ key: 'audit', ruleIds: ['BUNDLED-TEST'] }];
      context.raw.rowElements.set('audit', row.rowEl);
    }
    assert.equal((await apply(result.token)).blocked, true, condition);
    assert.equal(row.approvedCell.value, '400');
  }
});

test('investigation counts reject partial invalid input and cap approval at the claimed amount', () => {
  const { row, preview } = setup();
  for (const found of ['', '-1', '1.5', '1.0', '5', 'not-a-count', '1e0', '1,0', '0,3', '₹3', '1oops', true, null]) {
    assert.equal(preview([{ index: 0, found }]).blocked, true, found);
  }
  assert.equal(preview([{ index: 0, found: 1 }, { index: 0, found: 2 }]).blocked, true);
  assert.equal(preview([{ index: 99, found: 1 }]).blocked, true);
  row.claimAmount = 250;
  assert.equal(preview().proposals[0].proposedApproved, 250);
});

test('report-count scientific notation cannot become a different approved quantity', () => {
  const { row, preview } = setup();
  row.expected = 20; row.claimAmount = 2000;
  assert.equal(preview([{ index: 0, found: '1e1' }]).blockReason, 'invalid-investigation-counts');
  assert.equal(preview([{ index: 0, found: '10' }]).proposals[0].proposedApproved, 1000);
});

test('invalid checklist row indices and malformed entries cannot select a different investigation', () => {
  const { row, preview } = setup();
  for (const index of ['', ' ', null, undefined, false, true, '0.0', '0e0', '0oops', [], -1, 0.5, 9007199254740992]) {
    assert.equal(preview([{ index, found: '1' }]).blockReason, 'invalid-investigation-counts', String(index));
  }
  for (const item of [null, undefined, true, {}, 'not-an-entry']) {
    assert.equal(preview([item]).blockReason, 'invalid-investigation-counts');
  }
  assert.equal(row.approvedCell.value, '400');
  assert.equal(preview([{ index: '0', found: '0' }]).proposals[0].proposedApproved, 0);
});

test('invalid counts in any submitted row cancel the preview and invalidate the old Apply token', async () => {
  const { row, preview, apply } = setup();
  const valid = preview([{ index: 0, found: '3' }]);
  assert.equal(preview([{ index: 0, found: '3' }, { index: 99, found: '1e1' }]).blockReason, 'invalid-investigation-counts');
  assert.equal((await apply(valid.token)).blocked, true);
  assert.equal(row.approvedCell.value, '400');
  assert.equal(row.remarksCell.value, 'Keep this remark');
});

test('investigation recovery failures restore both fields and never mark them verified', async () => {
  for (const rejects of [false, true]) {
    const { context, row, preview, apply } = setup();
    if (rejects) context.persistRecoverySnapshot = async () => { throw new Error('storage unavailable'); };
    else context.recoveryOk = false;
    const result = await apply(preview().token);
    assert.equal(result.blockReason, 'recovery-save-failed');
    assert.equal(row.approvedCell.value, '400');
    assert.equal(row.remarksCell.value, 'Keep this remark');
    assert.equal(row.approvedCell.dataset.claimExtensionInvestigationVerified, undefined);
  }
});

test('investigation Undo clears the verified marker so normal processing can resume', async () => {
  const { context, row, preview, apply } = setup();
  await apply(preview().token);
  assert.equal(context.restoreFillBatch(context.undoBatch, { removeRecovery: false }), 2);
  assert.equal(row.approvedCell.value, '400');
  assert.equal(row.approvedCell.dataset.claimExtensionInvestigationVerified, undefined);
});
