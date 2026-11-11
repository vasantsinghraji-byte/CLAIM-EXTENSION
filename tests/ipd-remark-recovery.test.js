'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../claim-core');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));

function setup() {
  const target = { id: 'remark', value: 'Existing note', dataset: {}, isConnected: true };
  const c = vm.createContext({ Core, isMainIpdClaimPage: () => true, isAutoFillEnabled: true,
    licenceState: { status: 'active', applyAllowed: true }, refreshProcessingRules: async () => ({ ok: true }), findTid: () => 'CLAIM-A',
    location: { href: 'https://example.invalid/RGHS/tpaClaimSettle/CLAIM-A', pathname: '/RGHS/tpaClaimSettle/CLAIM-A' },
    findIpdActionTextBox: () => target, getElementValue: e => e.value, setElementValue: (e, v) => { e.value = v; },
    setCellValue: (e, value, batch) => { batch.push({ element: e, value: e.value, after: value }); e.value = value; },
    undoBatch: [], recoveryOk: true, persistRecoverySnapshot: async () => c.recoveryOk, appendClaimActivity: () => {} });
  vm.runInContext(section('function evaluateLicenceGate(', '// Fill all approved amounts')
    + section('function currentClaimContext(', 'function persistRecoverySnapshot(')
    + section('async function appendIpdActionRemarks(', 'function getReviewDocuments(')
    + section('async function finalizeRecovery(', 'function getMatchingRecoverySnapshot(')
    + section('function restoreFillBatch(', 'globalThis.ClaimAutoFillActions'), c);
  return { c, target };
}

test('IPD remark edits save recovery and Undo restores the original text', async () => {
  const { c, target } = setup();
  const result = await c.appendIpdActionRemarks('query', ['New query']);
  assert.equal(result.ok, true); assert.equal(result.recoverySaved, true);
  assert.equal(target.value, 'Existing note\nNew query');
  assert.equal(c.undoLastFill(), 1); assert.equal(target.value, 'Existing note');
});

test('IPD remarks roll back on storage failure and refuse disabled or signed-out edits', async () => {
  const { c, target } = setup(); c.recoveryOk = false;
  assert.equal((await c.appendIpdActionRemarks('query', ['New query'])).ok, false);
  assert.equal(target.value, 'Existing note');
  c.licenceState = null;
  assert.equal((await c.appendIpdActionRemarks('query', ['New query'])).blockReason, 'signed-out');
  c.isAutoFillEnabled = false;
  assert.equal((await c.appendIpdActionRemarks('query', ['New query'])).blockReason, 'autofill-disabled');
  assert.equal(target.value, 'Existing note');
});
