const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ProcessingRules = require('../processing-rules');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rule(overrides = {}) {
  return {
    ruleId: 'IPD-X-10',
    name: 'Package X mandatory deduction',
    processingArea: 'IPD',
    enabled: true,
    priority: 300,
    enforcement: 'mandatory',
    conditions: { operator: 'packagePresent', packageCodes: ['pkg-x'] },
    actions: [{
      type: 'applyDeduction',
      targetPackageCodes: ['pkg-x'],
      calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 }
    }, {
      type: 'writeRemark',
      targetPackageCodes: ['pkg-x'],
      target: { sheet: 'IPD', columnKey: 'remarks' },
      writeMode: 'append',
      template: 'Mandatory {deduction_percent}% deduction for {package_code}.'
    }],
    ...overrides
  };
}

test('schema v2 normalizes package codes and evaluates mandatory deductions deterministically', () => {
  const set = { schemaVersion: 2, versionId: 'v1', rules: [rule()] };
  const result = ProcessingRules.evaluate(set, [
    { index: 1, packageText: 'PKG-X Main package', claimValue: '1000', approvedValue: '' }
  ], 'IPD');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.matchedRuleIds, ['IPD-X-10']);
  assert.equal(result.rowActions[0].proposedApproved, 900);
  assert.equal(result.rowActions[0].enforcement, 'mandatory');
  assert.equal(result.rowActions[0].remarks.remarks, 'Mandatory 10% deduction for PKG-X.');
});

test('combination restrictions block every processor using the same active rule set', () => {
  const set = { schemaVersion: 2, rules: [rule({
    ruleId: 'IPD-X-Y-BLOCK',
    name: 'X and Y are mutually exclusive',
    priority: 200,
    enforcement: 'blocking',
    conditions: { operator: 'packageCombinationPresent', packageCodes: ['X', 'Y'] },
    actions: [{ type: 'blockProcessing', message: 'Packages X and Y cannot be processed together.' }]
  })] };
  const result = ProcessingRules.evaluate(set, [
    { index: 1, packageText: 'X', claimValue: 100 },
    { index: 2, packageText: 'Y', claimValue: 200 }
  ], 'IPD');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockMessages, [{ ruleId: 'IPD-X-Y-BLOCK', message: 'Packages X and Y cannot be processed together.' }]);
});

test('rule order is priority then rule ID and conflicting mandatory targets are rejected', () => {
  const normalized = ProcessingRules.normalizeRuleSet({ schemaVersion: 2, rules: [
    rule({ ruleId: 'RULE-B', priority: 301 }),
    rule({ ruleId: 'RULE-A', priority: 301 })
  ] });
  assert.deepEqual(normalized.rules.map(item => item.ruleId), ['RULE-A', 'RULE-B']);
  assert.match(normalized.errors.join(' | '), /ambiguous mandatory target/);
});

test('unknown actions, unsafe template tokens, and unsupported columns prevent publication', () => {
  const result = ProcessingRules.validateRule(rule({
    actions: [{
      type: 'writeRemark',
      targetPackageCodes: ['PKG-X'],
      target: { sheet: 'IPD', columnKey: 'arbitrarySelector' },
      template: 'Patient {patient_name}'
    }]
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /columnKey is invalid/);
  assert.match(result.errors.join(' | '), /unknown token/);
});

test('manual-review validations block automatic processing without changing claim amounts', () => {
  const result = ProcessingRules.evaluate({ schemaVersion: 2, rules: [rule({
    ruleId: 'IPD-X-DOCS',
    enforcement: 'manualReview',
    conditions: { operator: 'packagePresent', packageCodes: ['PKG-X'] },
    actions: [{
      type: 'requireValidation',
      validationCode: 'PACKAGE_DOCUMENTATION_CHECK',
      message: 'Verify required package documentation.'
    }]
  })] }, [{ index: 1, packageText: 'PKG-X', claimValue: 500 }], 'IPD');
  assert.equal(result.blocked, true);
  assert.equal(result.rowActions.length, 0);
  assert.equal(result.validations[0].validationCode, 'PACKAGE_DOCUMENTATION_CHECK');
});

test('later remark rules can use the deterministic outcome produced by deduction rules', () => {
  const deduction = rule({ actions: [rule().actions[0]] });
  const remark = rule({
    ruleId: 'IPD-X-REMARK',
    priority: 400,
    conditions: { operator: 'processingOutcomeEquals', value: 'deducted' },
    actions: [{
      type: 'writeRemark',
      targetPackageCodes: ['PKG-X'],
      target: { sheet: 'IPD', columnKey: 'remarks' },
      writeMode: 'replace',
      template: 'Standard deduction: {deduction}.'
    }]
  });
  const result = ProcessingRules.evaluate({ schemaVersion: 2, rules: [remark, deduction] }, [
    { index: 1, packageText: 'PKG-X', claimValue: 1000 }
  ], 'IPD');
  assert.equal(result.rowActions[0].proposedApproved, 900);
  assert.equal(result.rowActions[0].remarks.remarks, 'Standard deduction: 100.');
});

test('non-cumulative deductions choose the most restrictive result instead of stacking', () => {
  const result = ProcessingRules.evaluate({ schemaVersion: 2, rules: [
    rule({ ruleId: 'IPD-X-10', priority: 300 }),
    rule({
      ruleId: 'IPD-X-20',
      priority: 301,
      actions: [{
        type: 'applyDeduction', targetPackageCodes: ['PKG-X'],
        calculation: { method: 'percentage', basis: 'claimedAmount', value: 20 }, cumulative: false
      }]
    })
  ] }, [{ index: 1, packageText: 'PKG-X', claimValue: 1000 }], 'IPD');
  assert.equal(result.rowActions[0].proposedApproved, 800);
});

test('description text cannot impersonate a package code', () => {
  const result = ProcessingRules.evaluate({ schemaVersion: 2, rules: [rule({
    conditions: { operator: 'packagePresent', packageCodes: ['2026'] },
    actions: [{
      type: 'applyDeduction', targetPackageCodes: ['2026'],
      calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 }
    }]
  })] }, [{
    index: 1,
    packageText: 'PKG-X',
    particularText: 'Procedure performed in 2026',
    claimValue: 1000
  }], 'IPD');
  assert.equal(result.rowActions.length, 0);
});

test('published central rules are accepted only when their checksum matches', async () => {
  const published = { schemaVersion: 2, rules: [rule()], bundledFallbackEnabled: false };
  const digest = crypto.createHash('sha256')
    .update(canonicalJson({ schemaVersion: published.schemaVersion, rules: published.rules }))
    .digest('hex');
  published.checksum = `sha256:${digest}:central`;
  assert.equal(await ProcessingRules.verifyPublishedRuleSet(published), true);
  published.rules[0].priority++;
  assert.equal(await ProcessingRules.verifyPublishedRuleSet(published), false);
});
