'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRule, normalizeRuleSet, runScenarios } = require('../lib/processing-rules');

const validRule = {
  ruleId: 'IPD-X-10',
  name: 'Package X deduction',
  description: '',
  schemaVersion: 2,
  processingArea: 'IPD',
  enabled: true,
  priority: 300,
  enforcement: 'mandatory',
  conditions: { operator: 'packagePresent', packageCodes: ['pkg-x'] },
  actions: [{
    type: 'applyDeduction',
    targetPackageCodes: ['pkg-x'],
    calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 },
    cumulative: false
  }]
};

test('server normalizes centrally governed rules and creates stable checksums', () => {
  const normalized = normalizeRule(validRule);
  assert.equal(normalized.ruleId, 'IPD-X-10');
  assert.deepEqual(normalized.actions[0].targetPackageCodes, ['PKG-X']);
  assert.equal(normalizeRuleSet([validRule]).checksum, normalizeRuleSet([validRule]).checksum);
});

test('server rejects executable or unrecognized rule fields', () => {
  assert.throws(() => normalizeRule({ ...validRule, script: 'alert(1)' }), /not allowed/);
  assert.throws(() => normalizeRule({
    ...validRule,
    actions: [{
      type: 'writeRemark',
      target: { sheet: 'IPD', columnKey: 'remarks' },
      template: 'Patient {patient_name}'
    }]
  }), /unknown token/);
});

test('server rejects ambiguous mandatory amount actions at the same priority', () => {
  assert.throws(() => normalizeRuleSet([
    validRule,
    { ...validRule, ruleId: 'IPD-X-OTHER' }
  ]), /ambiguous mandatory target/);
});

test('server executes synthetic high-impact scenarios deterministically', () => {
  const rule = normalizeRule({
    ...validRule,
    scenarios: [{
      scenarioId: 'PKG-X-10-PERCENT',
      name: 'Applies ten percent deduction',
      processingArea: 'IPD',
      lines: [{ packageCodes: ['pkg-x'], claimAmount: 1000, approvedAmount: 1000 }],
      expected: { matchedRuleIds: ['IPD-X-10'], blocked: false, approvedAmounts: { 'PKG-X': 900 } }
    }]
  });
  const report = runScenarios([rule]);
  assert.equal(report.passed, true);
  assert.equal(report.total, 1);
  assert.equal(report.results[0].actual.approvedAmounts['PKG-X'], 900);
});

test('server reports failed synthetic expectations without publishing side effects', () => {
  const rule = normalizeRule({
    ...validRule,
    scenarios: [{
      scenarioId: 'WRONG-EXPECTED-AMOUNT',
      name: 'Detects an incorrect expectation',
      processingArea: 'IPD',
      lines: [{ packageCodes: ['PKG-X'], claimAmount: 1000 }],
      expected: { matchedRuleIds: ['IPD-X-10'], blocked: false, approvedAmounts: { 'PKG-X': 950 } }
    }]
  });
  const report = runScenarios([rule]);
  assert.equal(report.passed, false);
  assert.match(report.results[0].errors[0], /expected PKG-X approved amount 950/);
});
