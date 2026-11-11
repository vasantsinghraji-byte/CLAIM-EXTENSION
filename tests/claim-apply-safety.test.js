'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../claim-core');
const Review = require('../review-core');
const ProcessingRules = require('../processing-rules');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
function section(start, end) {
  assert.ok(source.indexOf(start) >= 0 && source.indexOf(end) > source.indexOf(start));
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function centralRule({ enforcement = 'mandatory', actions } = {}) {
  return {
    ruleId: 'SYN-10', name: 'Synthetic package check', processingArea: 'ALL', enabled: true, priority: 100,
    enforcement, conditions: { operator: 'packagePresent', packageCodes: ['PKG-X'] },
    actions: actions || [{ type: 'applyDeduction', targetPackageCodes: ['PKG-X'],
      calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 } }]
  };
}

const remarkAction = {
  type: 'writeRemark', targetPackageCodes: ['PKG-X'], target: { sheet: 'IPD', columnKey: 'remarks' },
  writeMode: 'append', template: 'Synthetic review remark'
};

// Run the production Preview/Apply/Undo functions with a small synthetic table.
// Only DOM primitives, storage and transport are substituted; calculations and
// selection, claim/control binding and write decisions all use production code.
function setup({ rules = [centralRule()], mode = 'remote-required', area = 'IPD',
  claim = '1000', approved = '', remarks = '' } = {}) {
  const snapshots = [];
  const context = vm.createContext({
    Core, Review, ProcessingRules, document: {}, console,
    isAutoFillEnabled: true, licenceState: { status: 'active', previewAllowed: true, applyAllowed: true },
    processingRuleSet: { schemaVersion: 2, mode, versionId: 'synthetic-v1', rules, bundledFallbackEnabled: false },
    ruleSetValidation: { ok: true }, auditMode: 'off', Audit: null, AuditRules: null,
    ipdClaimDetailContext: {}, APPROVED_CONTROL_SELECTOR: 'approved', REMARKS_CONTROL_SELECTOR: 'remarks',
    lastPreview: null, previewRowElements: new Map(), previewControlBindings: new Map(), undoBatch: [],
    location: { pathname: area === 'PHARMACY' ? '/RGHS/tpaPharmacy' : '/RGHS/processSheetSearch/SYN-A/',
      href: area === 'PHARMACY' ? 'https://example.invalid/RGHS/tpaPharmacy' : 'https://example.invalid/RGHS/processSheetSearch/SYN-A/' },
    tid: 'SYN-A', tables: [], recoveryOk: true,
    debugLog: () => {}, inspectPortalLayout: () => ({ ok: true }),
    configuredColumnKey: text => text === 'remarks' ? 'remarks' : text === 'deduction remarks' ? 'deductionRemarks' : null,
    getDirectTableRows: table => table.rows, getDirectRowCells: row => row.cells,
    findEditableElement: cell => cell,
    getCellValue: cell => cell.value, getElementValue: cell => cell.value,
    setElementValue: (element, value) => { element.value = String(value); },
    setCellValue: (element, value, batch) => {
      batch.push({ element, value: element.value, after: String(value) });
      element.value = String(value);
    },
    appendClaimActivity: () => {}, updateAuditBadge: () => {}, attachFeedbackControls: () => {},
    collectInputs: () => [], refreshProcessingRules: async () => ({ ok: true }),
    getMatchingRecoverySnapshot: callback => callback(null)
  });
  context.findTid = () => context.tid;
  context.processingAreaForPage = () => area;
  context.collectTables = () => context.tables;
  context.persistRecoverySnapshot = async batch => {
    if (context.recoveryOk) snapshots.push(batch.map(item => ({ before: item.value, after: item.after })));
    return context.recoveryOk;
  };
  const cell = (value, id = '') => ({
    textContent: String(value), value: String(value), id, dataset: {}, isConnected: true, contains: () => false
  });
  const table = { rows: [{ cells: ['Particular', 'Package Code', 'Claim Total Amount', 'Approved Amount', 'P25', 'Quantity', 'Remarks', 'Deduction Remarks'].map(value => cell(value)) }] };
  context.tables = [table];
  function addRow({ claim: rowClaim = claim, approved: rowApproved = approved, remarks: rowRemarks = remarks, code = 'PKG-X' } = {}) {
    const index = table.rows.length;
    const cells = [cell('Synthetic procedure'), cell(code), cell(rowClaim), cell(rowApproved, `approved-${index}`),
      cell('1000'), cell('1'), cell(rowRemarks, `remarks-${index}`), cell('', `deduction-remarks-${index}`)];
    const row = { cells, querySelector: () => null, isConnected: true };
    table.rows.push(row);
    return { row, claim: cells[2], approved: cells[3], remarks: cells[6], deductionRemarks: cells[7] };
  }
  const first = addRow();
  vm.runInContext([
    section('function evaluateLicenceGate(', '// Fill all approved amounts'),
    section('function currentClaimContext(', 'function persistRecoverySnapshot('),
    section('function fillAllApprovedAmounts(', '// Best-effort tab badge'),
    section('function formatPreview(', '// --- RGHS audit helpers ---'),
    section('async function applyFreshPreview(', '// Helper to find any editable element'),
    section('async function finalizeRecovery(', 'function getMatchingRecoverySnapshot('),
    section('function restoreFillBatch(', 'globalThis.ClaimAutoFillActions')
  ].join('\n'), context);
  const preview = () => context.createReviewedPreview();
  const apply = (prepared, overrides = {}) => context.applyFreshPreview({
    token: prepared.token, selectedRowKeys: prepared.proposals.map(item => item.key), acknowledgedHighRisk: true,
    ...overrides
  });
  return { context, first, table, addRow, snapshots, preview, apply };
}

test('formatted central claim amounts write the reviewed approval and Undo restores the original', async () => {
  const f = setup({ claim: '₹ 1,000.00' });
  const preview = f.preview();
  assert.equal(preview.proposals[0].proposedApproved, 900);
  const result = await f.apply(preview);
  assert.equal(result.blocked, false);
  assert.equal(result.reconciliation.proposedApprovedTotal, 900);
  assert.equal(f.first.approved.value, '900');
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.context.undoLastFill(), 1);
  assert.equal(f.first.approved.value, '');
});

test('malformed central money blocks Preview and Apply without writes or snapshots', async () => {
  for (const options of [{ claim: '1,00' }, { claim: '1000oops' }, { approved: 'invalid' }]) {
    const f = setup(options);
    const preview = f.preview();
    assert.equal(preview.blocked, true);
    assert.equal((await f.apply(preview)).blocked, true);
    assert.equal(f.first.approved.value, options.approved || '');
    assert.equal(f.snapshots.length, 0);
  }
});

test('central full deductions correctly clear partial approvals and recover the prior amount', async () => {
  const f = setup({ approved: '400', rules: [centralRule({ actions: [{ type: 'applyDeduction', targetPackageCodes: ['PKG-X'],
    calculation: { method: 'fullAmount', basis: 'claimedAmount', value: 100 } }] })] });
  const result = await f.apply(f.preview());
  assert.equal(result.blocked, false);
  assert.equal(f.first.approved.value, '0');
  assert.equal(f.context.undoLastFill(), 1);
  assert.equal(f.first.approved.value, '400');
});

test('remark-only mandatory rules preserve both explicit zero and blank approvals', async () => {
  for (const approved of ['0', '']) {
    const f = setup({ approved, remarks: 'Keep this note', rules: [centralRule({ actions: [remarkAction] })] });
    const preview = f.preview();
    assert.equal(preview.proposals[0].proposedApproved, null);
    const result = await f.apply(preview);
    assert.equal(result.blocked, false);
    assert.equal(f.first.approved.value, approved);
    assert.equal(f.first.remarks.value, 'Keep this note; Synthetic review remark');
    assert.equal(f.snapshots[0].length, 1);
    assert.equal(f.context.undoLastFill(), 1);
    assert.equal(f.first.remarks.value, 'Keep this note');
  }
});

test('central advisory Apply honors the reviewed amount and remark without touching unselected rows', async () => {
  const f = setup({ rules: [centralRule({ enforcement: 'advisory', actions: [centralRule().actions[0], remarkAction] })] });
  const unselected = f.addRow({ code: 'PKG-Y' });
  const preview = f.preview();
  const proposal = preview.proposals.find(item => item.ruleIds.includes('SYN-10'));
  const decision = Review.decisionForGroup({ proposals: [proposal] }, 'approve-all');
  const result = await f.apply(preview, { selectedRowKeys: decision.selectedKeys, approvedOverrides: decision.approvedOverrides,
    remarkOverrides: { [proposal.key]: 'Approved after explicit review.' } });
  assert.equal(result.blocked, false);
  assert.equal(result.reconciliation.proposedApprovedTotal, 1000);
  assert.equal(f.first.approved.value, '1000');
  assert.equal(f.first.remarks.value, 'Approved after explicit review.');
  assert.equal(unselected.approved.value, '');
  assert.equal(f.context.undoLastFill(), 2);
  assert.equal(f.first.approved.value, '');
  assert.equal(f.first.remarks.value, '');
});

test('central mandatory amounts and remarks cannot be overridden, including invalid numeric values', async () => {
  for (const value of [1000, NaN, Infinity, '', null, true]) {
    const f = setup();
    const preview = f.preview();
    assert.equal((await f.apply(preview, { approvedOverrides: { [preview.proposals[0].key]: value } })).blocked, true);
    assert.equal(f.first.approved.value, '');
    assert.equal(f.snapshots.length, 0);
  }
  const f = setup({ rules: [centralRule({ actions: [remarkAction] })] });
  const preview = f.preview();
  assert.equal((await f.apply(preview, { approvedOverrides: { [preview.proposals[0].key]: 0 } })).blocked, true);
  assert.equal((await f.apply(preview, { remarkOverrides: { [preview.proposals[0].key]: 'Bypass' } })).blockReason, 'mandatory-action-override');
  assert.equal(f.first.remarks.value, '');
});

test('same-route Pharmacy claim switches invalidate previews in bundled and central modes', async () => {
  for (const mode of ['bundled', 'remote-required']) {
    const f = setup({ area: 'PHARMACY', mode });
    const preview = f.preview();
    assert.ok(preview.proposals.length);
    f.context.tid = 'SYN-B';
    const result = await f.apply(preview);
    assert.equal(result.blockReason, 'stale');
    assert.equal(f.first.approved.value, '');
    assert.equal(f.snapshots.length, 0);
  }
});

test('replaced controls, changed secondary remark values and changed labels require a new preview', async () => {
  const changes = [
    f => { f.first.row.cells[3] = { ...f.first.approved }; },
    f => { f.first.deductionRemarks.value = 'Manually updated'; },
    f => { f.first.row.cells[0].textContent = 'Different procedure'; },
    f => { f.context.location.href += '?different-route=1'; }
  ];
  for (const change of changes) {
    const f = setup();
    const preview = f.preview();
    change(f);
    assert.equal((await f.apply(preview)).blockReason, 'stale');
    assert.equal(f.first.row.cells[3].value, '');
    assert.equal(f.snapshots.length, 0);
  }
});

test('missing claim identity blocks Apply and a new preview permits the current identified claim', async () => {
  const f = setup({ area: 'PHARMACY', mode: 'bundled' });
  f.context.tid = '';
  assert.equal((await f.apply(f.preview())).blockReason, 'claim-unavailable');
  f.context.tid = 'SYN-B';
  assert.equal((await f.apply(f.preview())).blocked, false);
  assert.equal(f.first.approved.value, '1000');
});

test('failed recovery storage rolls back central reviewer overrides', async () => {
  const f = setup({ rules: [centralRule({ enforcement: 'advisory' })] });
  const preview = f.preview();
  f.context.recoveryOk = false;
  const result = await f.apply(preview, { approvedOverrides: { [preview.proposals[0].key]: 1000 } });
  assert.equal(result.blockReason, 'recovery-save-failed');
  assert.equal(f.first.approved.value, '');
  assert.equal(f.snapshots.length, 0);
});

test('compare mode exposes local differences without letting central rules control writes', async () => {
  const f = setup({ mode: 'compare' });
  const preview = f.preview();
  assert.equal(preview.proposals[0].proposedApproved, 1000);
  assert.equal(preview.processingComparison[0].bundledApproved, 1000);
  assert.equal(preview.processingComparison[0].centralApproved, 900);
  assert.equal(f.first.approved.value, '');
  assert.equal((await f.apply(preview)).blocked, false);
  assert.equal(f.first.approved.value, '1000');
  assert.equal(f.context.undoLastFill(), 1);
  assert.equal(f.first.approved.value, '');
});

test('comparison does not report unchanged amounts, remark-only actions or unmatched rules', () => {
  for (const rules of [[], [centralRule({ actions: [remarkAction] })], [centralRule({ actions: [{
    type: 'applyDeduction', targetPackageCodes: ['PKG-X'], calculation: { method: 'percentage', basis: 'claimedAmount', value: 0 }
  }] })], [{ ...centralRule(), conditions: { operator: 'packagePresent', packageCodes: ['NO-MATCH'] } }]]) {
    const f = setup({ mode: 'compare', rules });
    const preview = f.preview();
    assert.equal(preview.blocked, false);
    assert.equal(preview.processingComparison.length, 0);
    assert.equal(preview.proposals[0].proposedApproved, 1000);
    assert.equal(f.first.approved.value, '');
    assert.equal(f.first.remarks.value, '');
  }
});

test('a blocked or invalid central comparison cannot block or modify bundled Apply', async () => {
  const blocking = centralRule({ actions: [{ type: 'blockProcessing', message: 'Synthetic central block' }] });
  for (const rules of [[blocking], [{ ...centralRule(), priority: 0 }]]) {
    const f = setup({ mode: 'compare', rules });
    const preview = f.preview();
    assert.equal(preview.blocked, false);
    assert.match(preview.processingComparison[0].message, /bundled processing remains authoritative/);
    assert.equal((await f.apply(preview)).blocked, false);
    assert.equal(f.first.approved.value, '1000');
  }
});

test('comparison preserves existing approvals when bundled processing has no amount proposal', () => {
  const f = setup({ mode: 'compare', approved: '950' });
  const preview = f.preview();
  assert.equal(preview.proposals.length, 0);
  assert.equal(preview.processingComparison[0].bundledApproved, 950);
  assert.equal(preview.processingComparison[0].centralApproved, 900);
  assert.equal(f.first.approved.value, '950');
});

test('comparison does not change proposals or their Apply fingerprint', () => {
  const bundled = setup({ mode: 'bundled' }).preview();
  const compared = setup({ mode: 'compare' }).preview();
  assert.equal(compared.token, bundled.token);
  assert.equal(JSON.stringify(compared.proposals), JSON.stringify(bundled.proposals));
  assert.equal(JSON.stringify(compared.reconciliation), JSON.stringify(bundled.reconciliation));
});

test('remote-required mode still blocks central policy decisions and exposes their explanations', () => {
  const f = setup({ rules: [centralRule({ actions: [{ type: 'blockProcessing', message: 'Synthetic central block' }] })] });
  const preview = f.preview();
  assert.equal(preview.blockReason, 'processing-rule-blocked');
  assert.match(preview.blockDetails[0], /SYN-10: Synthetic central block/);
  assert.equal(preview.processingComparison.length, 0);
  assert.equal(f.first.approved.value, '');
});
