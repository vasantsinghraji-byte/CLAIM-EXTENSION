const test = require('node:test');
const assert = require('node:assert/strict');
const CustomRules = require('../custom-rules');
const AuditCore = require('../audit-core');
const AuditRules = require('../audit-rules');

const unbundling = {
  ruleId: 'CUSTOM-001',
  type: 'unbundling',
  risk: 'High',
  main: { label: 'Main package', codes: ['CM-9001'], patterns: [] },
  components: [{ label: 'Included service', codes: ['CM-9002'], patterns: [] }],
  reason: 'Included service billed separately',
  reference: 'Local package master',
  remarks: { deducted: '{component} is included in {main_package}.', hold: '{reason}. Check {reference}.' }
};

test('custom rule validation rejects duplicate ids, invalid regex and unknown remark tokens', () => {
  const result = CustomRules.validateCustomRule({
    ...unbundling,
    ruleId: 'BI-01',
    main: { ...unbundling.main, patterns: ['[broken'] },
    remarks: { hold: 'Check {patient_name}' }
  }, CustomRules.collectRuleIds(AuditRules));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' | '), /duplicate ruleId/);
  assert.match(result.errors.join(' | '), /invalid regular expression/);
  assert.match(result.errors.join(' | '), /unknown token/);
});

test('engine-generated rule IDs and potentially unsafe regexes are reserved', () => {
  const reserved = CustomRules.validateCustomRule({ ...unbundling, ruleId: 'DUP-CODE' }, CustomRules.collectRuleIds(AuditRules));
  assert.match(reserved.errors.join(' '), /duplicate ruleId/);
  const unsafe = CustomRules.validateCustomRule({
    ...unbundling,
    ruleId: 'CUSTOM-UNSAFE',
    main: { label: 'Unsafe', codes: [], patterns: ['(a+)+'] }
  });
  assert.match(unsafe.errors.join(' '), /potentially unsafe/);
});

test('custom unbundling rules merge as review-only and execute through the existing engine', () => {
  const config = CustomRules.normalizeConfig({ rules: [unbundling] }, CustomRules.collectRuleIds(AuditRules));
  assert.deepEqual(config.errors, []);
  const merged = CustomRules.mergeRuleSet(AuditRules, config);
  const custom = merged.bundles.find(rule => rule.ruleId === 'CUSTOM-001');
  assert.equal(custom.action, 'review-only');
  assert.equal(custom.autoDeductEligible, false);
  const lines = [
    { index: 1, packageText: 'CM-9001 Main package', particularText: 'Procedure', claimValue: '1000', approvedValue: '' },
    { index: 2, packageText: 'CM-9002 Included service', particularText: 'Procedure', claimValue: '200', approvedValue: '' }
  ];
  const finding = AuditCore.analyzeClaim(lines, merged).find(item => item.ruleId === 'CUSTOM-001');
  assert.ok(finding);
  const actions = AuditCore.planAuditActions([finding], lines, { mode: 'deduct', settings: merged.settings }).rowActions;
  assert.ok(actions.every(action => action.setApproved === null));
  assert.match(actions[0].remark, /Included service billed separately/);
});

test('decision-specific templates produce plain portal remarks and preserve numeric-only approvals', () => {
  const merged = CustomRules.mergeRuleSet(AuditRules, {
    rules: [unbundling],
    remarkTemplates: CustomRules.DEFAULT_REMARK_TEMPLATES
  });
  const finding = AuditCore.analyzeClaim([
    { index: 1, packageText: 'CM-9001 Main package', particularText: 'Procedure', claimValue: '1000', approvedValue: '' },
    { index: 2, packageText: 'CM-9002 Included service', particularText: 'Procedure', claimValue: '200', approvedValue: '' }
  ], merged).find(item => item.ruleId === 'CUSTOM-001');
  assert.equal(AuditCore.formatRemark(finding, 'approved', 1), '');
  assert.equal(AuditCore.formatRemark(finding, 'deduct', 2), 'Included service is included in Main package.');
  assert.match(AuditCore.formatRemark(finding, 'flag', 2), /Check Local package master/);
  assert.doesNotMatch(AuditCore.formatRemark(finding, 'deduct', 2), /RGHS-AUDIT|CUSTOM-001/);
});

test('custom upcoding triggers are review-only and may be disabled', () => {
  const upcoding = {
    ruleId: 'CUSTOM-UP-001', type: 'upcoding', enabled: true, risk: 'High',
    main: { label: 'Higher package', codes: ['CM-9003'], patterns: [] },
    reason: 'Verify documented procedure', reference: 'Local finding'
  };
  const enabled = CustomRules.mergeRuleSet(AuditRules, { rules: [upcoding] });
  assert.ok(AuditCore.analyzeClaim([
    { index: 1, packageText: 'CM-9003 Higher package', particularText: 'Procedure', claimValue: '5000' }
  ], enabled).some(item => item.ruleId === 'CUSTOM-UP-001'));
  const disabled = CustomRules.mergeRuleSet(AuditRules, { rules: [{ ...upcoding, enabled: false }] });
  assert.equal(AuditCore.analyzeClaim([
    { index: 1, packageText: 'CM-9003 Higher package', particularText: 'Procedure', claimValue: '5000' }
  ], disabled).some(item => item.ruleId === 'CUSTOM-UP-001'), false);
});

test('per-built-in-rule remark overrides affect only the selected rule', () => {
  const merged = CustomRules.mergeRuleSet(AuditRules, {
    builtInRemarkOverrides: {
      'CA-01': {
        deducted: 'Separate {component} ({component_code}) is not payable with {main_package} ({main_code}).'
      }
    }
  });
  const caFinding = AuditCore.analyzeClaim([
    { index: 1, packageText: '544 PTCA package', particularText: 'Procedure', claimValue: '97865', approvedValue: '' },
    { index: 2, packageText: '601 Coronary angiography', particularText: 'Investigation', claimValue: '6325', approvedValue: '' }
  ], merged).find(item => item.ruleId === 'CA-01');
  assert.equal(
    AuditCore.formatRemark(caFinding, 'deduct', 2),
    'Separate Coronary angiography (601) is not payable with PTCA package (inclusive of diagnostic angiogram) (544).'
  );

  const cbcFinding = AuditCore.analyzeClaim([
    { index: 1, packageText: '1394 CBC', particularText: 'Investigation', claimValue: '460', approvedValue: '' },
    { index: 2, packageText: '1392 ESR', particularText: 'Investigation', claimValue: '80', approvedValue: '' }
  ], merged).find(item => item.ruleId === 'BI-01');
  assert.match(AuditCore.formatRemark(cbcFinding, 'deduct', 2), /has not been allowed separately/);
});

test('per-rule overrides reject unknown built-in IDs and unsafe template tokens', () => {
  const config = CustomRules.normalizeConfig({
    builtInRemarkOverrides: {
      'NOT-A-RULE': { deducted: 'No' },
      'CA-01': { deducted: 'Invalid {patient_name}' }
    }
  }, CustomRules.collectRuleIds(AuditRules));
  assert.match(config.errors.join(' | '), /unknown built-in ruleId/);
  assert.match(config.errors.join(' | '), /unknown token/);
});
