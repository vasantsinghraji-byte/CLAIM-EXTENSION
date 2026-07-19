const test = require('node:test');
const assert = require('node:assert/strict');
const AuditCore = require('../audit-core');
const AuditRules = require('../audit-rules');

test('generated audit rules satisfy the versioned schema', () => {
  assert.deepEqual(AuditCore.validateRuleSet(AuditRules), { ok: true, errors: [] });
  const invalid = JSON.parse(JSON.stringify(AuditRules));
  invalid.bundles[1].ruleId = invalid.bundles[0].ruleId;
  assert.equal(AuditCore.validateRuleSet(invalid).ok, false);
  assert.match(AuditCore.validateRuleSet(invalid).errors.join(' '), /duplicate ruleId/);
});

test('every documentation-dependent upcoding trigger produces a review finding', () => {
  assert.equal(AuditRules.reviewTriggers.length, 8);
  for (const rule of AuditRules.reviewTriggers) {
    const code = rule.entity.codes[0];
    const findings = AuditCore.analyzeClaim([
      line(1, `${code} (${rule.label})`, 'Procedure', '1000')
    ], AuditRules);
    const finding = findings.find(item => item.ruleId === rule.ruleId);
    assert.ok(finding, `${rule.ruleId} did not trigger for ${code}`);
    assert.equal(finding.type, 'UPCODING_REVIEW');
    const { rowActions } = AuditCore.planAuditActions([finding], [line(1, `${code} (${rule.label})`, 'Procedure', '1000')], { mode: 'flag', settings: AuditRules.settings });
    assert.equal(rowActions.length, 1);
    assert.equal(rowActions[0].setApproved, null);
  }
});

test('multiple positive-value major procedures trigger cross-cutting review on every involved row', () => {
  const lines = [
    line(1, '1001 (Major procedure A)', 'Procedure', '10000'),
    line(2, '1002 (Major surgery B)', 'Surgery', '12000')
  ];
  const finding = AuditCore.analyzeClaim(lines, AuditRules).find(item => item.ruleId === 'MULTI-MAJOR');
  assert.ok(finding);
  assert.deepEqual(finding.rows, [1, 2]);
  const { rowActions } = AuditCore.planAuditActions([finding], lines, { mode: 'flag', settings: AuditRules.settings });
  assert.deepEqual(rowActions.map(action => action.rowIndex), [1, 2]);
});

test('every generated matrix rule family is executable from representative coded lines', () => {
  const entityText = entity => {
    const code = entity.codes?.[0];
    if (code) return `${code} (${entity.label || 'Matrix service'})`;
    if (entity.label) return entity.label;
    return String(entity.patterns?.[0] || 'Matrix service')
      .replace(/\\b/g, '')
      .replace(/\.\*/g, ' ')
      .replace(/[()[\]?+^$]/g, '');
  };
  for (const rule of AuditRules.bundles) {
    const lines = [
      line(1, entityText(rule.bundle), 'Procedure', '10000'),
      line(2, entityText(rule.components[0]), 'Procedure', '1000')
    ];
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === rule.ruleId), `${rule.ruleId} bundle rule is unreachable`);
  }
  for (const rule of AuditRules.mutuallyExclusive) {
    const lines = rule.groups.map((group, index) => line(index + 1, entityText(group), 'Procedure', '1000'));
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === rule.ruleId), `${rule.ruleId} mutually-exclusive rule is unreachable`);
  }
  for (const rule of AuditRules.addOnDependencies) {
    const lines = [line(1, entityText(rule.addOn), 'Procedure', '1000')];
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === rule.ruleId), `${rule.ruleId} add-on rule is unreachable`);
  }
  for (const rule of AuditRules.combinedAvailable) {
    const lines = rule.components.map((component, index) => line(index + 1, entityText(component), 'Procedure', '1000'));
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === rule.ruleId), `${rule.ruleId} combined-package rule is unreachable`);
  }
  for (const rule of AuditRules.adjunctClusters) {
    const lines = rule.members.slice(0, rule.minDistinct || 2).map((member, index) => line(index + 1, entityText(member), 'Procedure', '1000'));
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === rule.ruleId), `${rule.ruleId} adjunct rule is unreachable`);
  }
  for (const group of AuditRules.duplicateMMGroups) {
    const lines = group.codes.slice(0, 2).map((code, index) => line(index + 1, `${code} (${group.name})`, 'Medical Management Package', '1000'));
    assert.ok(AuditCore.analyzeClaim(lines, AuditRules).some(item => item.ruleId === 'MM-DUP'), `MM-DUP group is unreachable: ${group.name}`);
  }
});

function line(index, packageText, particularText, claimValue, approvedValue = '', remarksValue = '') {
  return { index, packageText, particularText, claimValue, approvedValue, remarksValue };
}

function rulesWith(overrides) {
  const rules = JSON.parse(JSON.stringify(AuditRules));
  for (const [ruleId, patch] of Object.entries(overrides || {})) {
    const rule = rules.bundles.find(r => r.ruleId === ruleId);
    Object.assign(rule, patch);
  }
  return rules;
}

test('CBC bundle with ESR and peripheral smear yields two unbundling findings', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (Erythrocyte Sedimentation Rate (ESR))', 'Investigation', '80'),
    line(3, 'Peripheral Smear Examination', 'Investigation', '120')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules).filter(f => f.ruleId === 'BI-01');
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(f => f.componentRow.index).sort(), [2, 3]);
  assert.equal(findings[0].type, 'UNBUNDLING');
  assert.equal(findings.find(f => f.componentRow.index === 2).componentRow.via, 'code');
  assert.equal(findings.find(f => f.componentRow.index === 3).componentRow.via, 'name');
});

test('HbA1c is not treated as ordinary haemoglobin included in CBC', () => {
  const findings = AuditCore.analyzeClaim([
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '460'),
    line(2, '1510 (Glycosylated Haemoglobin (HbA1c))', 'Investigation', '150')
  ], AuditRules);
  assert.equal(findings.filter(f => f.ruleId === 'BI-01').length, 0);
});

test('bundle alone or component alone produces no unbundling finding', () => {
  for (const fixture of [
    [line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350')],
    [line(1, '1392 (ESR)', 'Investigation', '80')]
  ]) {
    const findings = AuditCore.analyzeClaim(fixture, AuditRules);
    assert.equal(findings.filter(f => f.type === 'UNBUNDLING').length, 0);
  }
});

test('flag mode writes remarks but never touches approved amounts', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (ESR)', 'Investigation', '80')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const { rowActions, summary } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  assert.ok(rowActions.length >= 1);
  assert.ok(rowActions.every(action => action.setApproved === null));
  assert.equal(summary.deducted, 0);
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.match(esrAction.remark, /included in CBC/);
  assert.doesNotMatch(esrAction.remark, /RGHS-AUDIT|Rule BI-01/);
  assert.ok(rowActions.some(action => action.rowIndex === 1), 'the main package must also be highlighted');
});

test('deduct mode without allowlisting still only flags (staged rollout default)', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (ESR)', 'Investigation', '80')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: AuditRules.settings });
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.equal(esrAction.setApproved, null);
  assert.equal(esrAction.downgradeReason, 'rule-not-yet-allowlisted');
});

test('allowlisted code-confirmed unbundling zeroes the component and logs a deduction', () => {
  const rules = rulesWith({ 'BI-01': { autoDeductEligible: true } });
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (ESR)', 'Investigation', '80')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const { rowActions, summary } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.equal(esrAction.setApproved, '0');
  assert.equal(esrAction.deductionAmount, 80);
  assert.match(esrAction.remark, /has not been allowed separately/);
  assert.doesNotMatch(esrAction.remark, /RGHS-AUDIT|Rule BI-01/);
  assert.equal(summary.deducted, 1);
  const entry = AuditCore.buildAuditEntry(esrAction, { mode: 'deduct', tid: 'T123' });
  assert.equal(entry.action, 'deducted');
  assert.equal(entry.amountAfter, '0');
  assert.equal(entry.ruleId, 'BI-01');
});

test('name-only matches never auto-deduct even when allowlisted', () => {
  const rules = rulesWith({ 'BI-01': { autoDeductEligible: true } });
  const lines = [
    line(1, 'Complete Haemogram CBC package', 'Investigation', '350'),
    line(2, '1392 (ESR)', 'Investigation', '80')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.equal(esrAction.setApproved, null);
  assert.equal(esrAction.downgradeReason, 'name-only-match');
});

test('PTCA + separately booked CAG applies the fixed Rs.6000 deduction to the package', () => {
  const rules = rulesWith({ 'CA-01': { autoDeductEligible: true } });
  const lines = [
    line(1, '2831-MC011A (PTCA, inclusive of diagnostic angiogram)', 'Procedure', '40000'),
    line(2, '601 (Coronary angiography)', 'Procedure', '6000')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const fixed = findings.find(f => f.type === 'UNBUNDLING_FIXED');
  assert.equal(fixed.ruleId, 'CA-01');
  assert.equal(fixed.bundleRow.index, 1);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const bundleAction = rowActions.find(action => action.rowIndex === 1 && action.ruleId === 'CA-01');
  assert.equal(bundleAction.setApproved, '34000');
  assert.equal(bundleAction.deductionAmount, 6000);
  assert.match(bundleAction.remark, /Rs\.6000 deducted from the main package/);
  const cagAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'CA-01');
  assert.ok(cagAction, 'the separately billed CAG row must remain reserved from ordinary autofill');
  assert.equal(cagAction.setApproved, null);
  assert.match(cagAction.remark, /included in PTCA package/);
  assert.doesNotMatch(cagAction.remark, /RGHS-AUDIT|Rule CA-01/);
});

test('live PTCA 544 plus CAG 601 flags and reserves both rows in review mode', () => {
  const lines = [
    line(1, '544 (Balloon coronary angioplasty/PTCA with VCD)', 'Procedure', '85100'),
    line(2, '601 (Coronary angiography)', 'Investigation', '6325')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules).filter(finding => finding.ruleId === 'CA-01');
  assert.equal(findings.length, 1);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  assert.deepEqual(rowActions.map(action => action.rowIndex), [1, 2]);
  assert.ok(rowActions.every(action => action.setApproved === null));
  assert.ok(rowActions.every(action => action.highlight === 'candidate'));
});

test('exception keyword on the component row downgrades deduction to a flag', () => {
  const rules = rulesWith({ 'BI-01': { autoDeductEligible: true } });
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (ESR) - repeat sample', 'Investigation', '80')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  assert.equal(findings.find(f => f.ruleId === 'BI-01').exceptionHit, true);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.equal(esrAction.setApproved, null);
});

test('already-adjudicated approved amount is never overwritten', () => {
  const rules = rulesWith({ 'BI-01': { autoDeductEligible: true } });
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1392 (ESR)', 'Investigation', '80', '75')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const esrAction = rowActions.find(action => action.rowIndex === 2 && action.ruleId === 'BI-01');
  assert.equal(esrAction.setApproved, null);
  assert.equal(esrAction.downgradeReason, 'approved-already-set');
});

test('safety cap downgrades all deductions when the total is too large', () => {
  const rules = rulesWith({ 'BI-02': { autoDeductEligible: true } });
  const lines = [
    line(1, '1512 (Kidney Function Test)', 'Investigation', '20000'),
    line(2, '1447 (Serum Creatinine)', 'Investigation', '9000'),
    line(3, '1446 (Blood Urea Nitrogen)', 'Investigation', '8000')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const { rowActions, summary } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  const actions = rowActions.filter(action => action.ruleId === 'BI-02');
  const componentActions = actions.filter(action => action.rowIndex !== 1);
  assert.equal(componentActions.length, 2);
  assert.ok(componentActions.every(action => action.setApproved === null));
  assert.ok(componentActions.every(action => action.downgradeReason === 'safety-cap'));
  assert.equal(summary.deducted, 0);
});

test('exact duplicate package code reserves and highlights every occurrence', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1394 (Complete Haemogram/CBC)', 'Investigation', '350')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const dup = findings.find(f => f.type === 'DUPLICATE');
  assert.equal(dup.code, '1394');
  assert.deepEqual(dup.duplicateRows.map(row => row.index), [2]);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  assert.deepEqual(rowActions.map(action => action.rowIndex), [1, 2]);
  assert.ok(rowActions.every(action => action.highlight === 'candidate'));
  assert.ok(rowActions.every(action => !action.remark.includes('[RGHS-AUDIT]')));
  assert.ok(rowActions.every(action => !action.remark.includes('DUP-CODE')));
});

test('same MM code split across ward types (different amounts) is NOT a duplicate', () => {
  // Real case: CM-0078 Febrile illness billed as ICU days (4563 x 6 = 21378)
  // plus general-ward days (2700) - same per-day package code, different ward
  // rates. Must not flag.
  const lines = [
    line(1, 'CM-0078 (Febrile illness)', 'Medical Management Package', '21378'),
    line(2, 'CM-0078 (Febrile illness)', 'Medical Management Package', '2700')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  assert.equal(findings.filter(f => f.type === 'DUPLICATE').length, 0);
  // And with no findings, nothing blocks auto-fill of either row.
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  assert.equal(rowActions.length, 0);
});

test('same MM code repeated with identical amounts is still flagged as duplicate', () => {
  const lines = [
    line(1, 'CM-0078 (Febrile illness)', 'Medical Management Package', '21378'),
    line(2, 'CM-0078 (Febrile illness)', 'Medical Management Package', '21378')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const dup = findings.find(f => f.type === 'DUPLICATE');
  assert.equal(dup.code, 'CM-0078');
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  const action = rowActions.find(a => a.ruleId === 'DUP-CODE');
  assert.match(action.remark, /same package\/procedure code appears more than once/);
  assert.doesNotMatch(action.remark, /RGHS-AUDIT|DUP-CODE/);
});

test('non-MM duplicate codes with different amounts still flag for review', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350'),
    line(2, '1394 (Complete Haemogram/CBC)', 'Investigation', '300')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  assert.equal(findings.filter(f => f.type === 'DUPLICATE').length, 1);
});

test('mutually exclusive PTCA with/without VCD variants are flagged for review', () => {
  const lines = [
    line(1, '544 (Balloon coronary angioplasty/PTCA with VCD)', 'Procedure', '35000'),
    line(2, '545 (Balloon coronary angioplasty/PTCA without VCD)', 'Procedure', '32000')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const me = findings.find(f => f.type === 'MUTUALLY_EXCLUSIVE');
  assert.equal(me.ruleId, 'ME-01');
  assert.deepEqual(me.rows.sort(), [1, 2]);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: AuditRules.settings });
  assert.ok(rowActions.filter(a => a.ruleId === 'ME-01').every(a => a.setApproved === null));
});

test('FFR add-on without a qualifying base is flagged; with base it is not', () => {
  const without = AuditCore.analyzeClaim(
    [line(1, '585 (Fractional flow reserve)', 'Procedure', '15000')], AuditRules);
  const addon = without.find(f => f.type === 'ADDON_NO_BASE');
  assert.equal(addon.ruleId, 'AD-01');
  const withBase = AuditCore.analyzeClaim([
    line(1, '585 (Fractional flow reserve)', 'Procedure', '15000'),
    line(2, '601 (Coronary angiography)', 'Procedure', '6000')
  ], AuditRules);
  assert.equal(withBase.filter(f => f.ruleId === 'AD-01').length, 0);
});

test('caesarean + hysterectomy billed separately flags the available combined package', () => {
  const separate = AuditCore.analyzeClaim([
    line(1, '1838-SO057A (Caesarean Delivery)', 'Procedure', '25000'),
    line(2, '1838-SO010A (Abdominal Hysterectomy)', 'Procedure', '30000')
  ], AuditRules);
  const cb = separate.find(f => f.ruleId === 'CB-03');
  assert.equal(cb.type, 'COMBINED_AVAILABLE');
  assert.deepEqual(cb.rows.sort(), [1, 2]);

  const withCombined = AuditCore.analyzeClaim([
    line(1, '1838-SO011A (Caesarean hysterectomy)', 'Procedure', '45000'),
    line(2, '1838-SO057A (Caesarean Delivery)', 'Procedure', '25000'),
    line(3, '1838-SO010A (Abdominal Hysterectomy)', 'Procedure', '30000')
  ], AuditRules);
  assert.equal(withCombined.filter(f => f.ruleId === 'CB-03').length, 0);
});

test('two intracoronary adjuncts in one claim trigger the cluster review', () => {
  const findings = AuditCore.analyzeClaim([
    line(1, '584 (Intravascular ultrasound (IVUS))', 'Procedure', '25000'),
    line(2, '585 (Fractional flow reserve)', 'Procedure', '15000'),
    line(3, '601 (Coronary angiography)', 'Procedure', '6000')
  ], AuditRules);
  const cluster = findings.find(f => f.type === 'ADJUNCT_CLUSTER');
  assert.equal(cluster.ruleId, 'AJ-01');
  assert.match(cluster.remarkReason, /IVUS \+ FFR/);
});

test('same diagnosis under two medical-management specialty codes is flagged', () => {
  const findings = AuditCore.analyzeClaim([
    line(1, 'CM-0004 (Systemic Thrombolysis for MI - Cardiology)', 'Medical management', '20000'),
    line(2, 'CM-0044 (Systemic Thrombolysis for MI - General Medicine)', 'Medical management', '18000')
  ], AuditRules);
  const mm = findings.find(f => f.type === 'DUPLICATE_MM');
  assert.equal(mm.ruleId, 'MM-DUP');
  assert.deepEqual(mm.rows.sort(), [1, 2]);
  assert.match(mm.remarkReason, /CM-0004, CM-0044/);
});

test('existing rule remarks are not duplicated but rows remain protected on re-runs', () => {
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC)', 'Investigation', '350', '',
      '[RGHS-AUDIT] UNBUNDLING SUSPECTED | Component expressly included in composite CBC package | Rule BI-01 | Verify documentation before approval'),
    line(2, '1392 (ESR)', 'Investigation', '80', '',
      '[RGHS-AUDIT] UNBUNDLING SUSPECTED | Component expressly included in composite CBC package | Rule BI-01 | Verify documentation before approval')
  ];
  const findings = AuditCore.analyzeClaim(lines, AuditRules);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'flag', settings: AuditRules.settings });
  const actions = rowActions.filter(action => action.ruleId === 'BI-01');
  assert.deepEqual(actions.map(action => action.rowIndex), [1, 2]);
  assert.ok(actions.every(action => action.appendRemark === false));
  assert.ok(actions.every(action => action.setApproved === null));
});

test('bare numeric tokens that are not known codes never match', () => {
  const findings = AuditCore.analyzeClaim([
    line(1, 'Room rent 1392 hours charge', 'Accommodation for 1394 days', '500')
  ], { ...AuditRules, bundles: [], mutuallyExclusive: [], addOnDependencies: [], combinedAvailable: [], adjunctClusters: [], duplicateMMGroups: [] });
  assert.equal(findings.length, 0);
  const codes = AuditCore.extractCodes('Rate 1394 x 2 = 2788', new Set());
  assert.equal(codes.size, 0);
});

test('over-claim beyond rate x units is flagged; at-or-below is not', () => {
  // Claiming BELOW rate x units is routine (admissible-rate caps): 4563 x 6 =
  // 27378 but the real sheet claimed 21378 - must not flag. Exact match is fine too.
  for (const claimValue of ['21378', '27378']) {
    const findings = AuditCore.analyzeClaim([
      { index: 1, packageText: 'CM-0078 (Febrile illness)', particularText: 'MM', claimValue, approvedValue: '', remarksValue: '', rateValue: '4563', unitValue: '6' }
    ], AuditRules);
    assert.equal(findings.filter(f => f.type === 'AMOUNT_MISMATCH').length, 0);
  }

  const over = AuditCore.analyzeClaim([
    { index: 1, packageText: 'CM-0078 (Febrile illness)', particularText: 'MM', claimValue: '30000', approvedValue: '', remarksValue: '', rateValue: '4563', unitValue: '6' }
  ], AuditRules);
  const mismatch = over.find(f => f.type === 'AMOUNT_MISMATCH');
  assert.equal(mismatch.ruleId, 'AMT-CALC');
  assert.match(mismatch.remarkReason, /exceeds rate 4563 x 6/);
  assert.equal(mismatch.action, 'review-only');
});

test('component on a different service date than its bundle downgrades to a flag', () => {
  const rules = rulesWith({ 'BI-01': { autoDeductEligible: true } });
  const lines = [
    { index: 1, packageText: '1394 (Complete Haemogram/CBC)', particularText: 'Investigation', claimValue: '350', approvedValue: '', remarksValue: '', dateValue: '01/07/2026' },
    { index: 2, packageText: '1392 (ESR)', particularText: 'Investigation', claimValue: '80', approvedValue: '', remarksValue: '', dateValue: '03/07/2026' }
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  assert.equal(findings.find(f => f.ruleId === 'BI-01').exceptionHit, true);
  const { rowActions } = AuditCore.planAuditActions(findings, lines, { mode: 'deduct', settings: rules.settings });
  assert.equal(rowActions.find(a => a.ruleId === 'BI-01').setApproved, null);
});

test('laterality wording stops duplicate codes from ever auto-deducting', () => {
  const rules = JSON.parse(JSON.stringify(AuditRules));
  rules.settings.duplicateAutoDeductEligible = true;
  const lines = [
    line(1, '1394 (Complete Haemogram/CBC) - left arm sample', 'Investigation', '350'),
    line(2, '1394 (Complete Haemogram/CBC) - right arm sample', 'Investigation', '350')
  ];
  const findings = AuditCore.analyzeClaim(lines, rules);
  const dup = findings.find(f => f.type === 'DUPLICATE');
  assert.equal(dup.autoDeductEligible, false);
  assert.match(dup.remarkReason, /laterality/);
});

test('applyRuleOverrides flips allowlisting only for deduct-eligible rules', () => {
  const merged = AuditCore.applyRuleOverrides(AuditRules, {
    'BI-01': { autoDeductEligible: true },
    'OB-03': { autoDeductEligible: true }
  });
  assert.equal(merged.bundles.find(r => r.ruleId === 'BI-01').autoDeductEligible, true);
  // OB-03 is review-only; the override must be ignored.
  assert.equal(merged.bundles.find(r => r.ruleId === 'OB-03').autoDeductEligible, false);
  // No overrides -> same object back.
  assert.equal(AuditCore.applyRuleOverrides(AuditRules, {}), AuditRules);
});

test('stripAuditRemark removes only the targeted rule segment', () => {
  const remark = 'Manual note; [RGHS-AUDIT] DUPLICATE SUSPECTED | x | Rule DUP-CODE | y; [RGHS-AUDIT] REVIEW REQUIRED | z | Rule MM-DUP | v';
  const cleaned = AuditCore.stripAuditRemark(remark, 'DUP-CODE');
  assert.equal(cleaned, 'Manual note; [RGHS-AUDIT] REVIEW REQUIRED | z | Rule MM-DUP | v');
  assert.equal(AuditCore.stripAuditRemark(cleaned, 'MM-DUP'), 'Manual note');
});

test('dedupeLogEntries drops entries already logged for the same claim/rule/row', () => {
  const entry = { url: 'u', tid: 'T1', ruleId: 'BI-01', rowNumber: 2, findingType: 'UNBUNDLING', action: 'flagged', timestamp: 'a' };
  const rerun = { ...entry, timestamp: 'b' };
  const escalated = { ...entry, action: 'deducted', timestamp: 'c' };
  assert.deepEqual(AuditCore.dedupeLogEntries([entry], [rerun, escalated]), [escalated]);
  assert.deepEqual(AuditCore.dedupeLogEntries([], [entry, rerun]), [entry]);
});

test('summarizeAudit aggregates log and feedback into per-rule stats', () => {
  const stats = AuditCore.summarizeAudit(
    [
      { ruleId: 'BI-01', action: 'flagged' },
      { ruleId: 'BI-01', action: 'flagged' },
      { ruleId: 'BI-01', action: 'deducted' }
    ],
    [
      { ruleId: 'BI-01', verdict: 'confirmed' },
      { ruleId: 'BI-01', verdict: 'dismissed' },
      { ruleId: 'BI-01', verdict: 'dismissed' },
      { ruleId: 'CA-01', verdict: 'confirmed' }
    ]
  );
  const bi = stats.find(s => s.ruleId === 'BI-01');
  assert.deepEqual(
    { flagged: bi.flagged, deducted: bi.deducted, confirmed: bi.confirmed, dismissed: bi.dismissed },
    { flagged: 2, deducted: 1, confirmed: 1, dismissed: 2 });
  assert.ok(Math.abs(bi.falsePositiveRate - 2 / 3) < 1e-9);
  assert.equal(stats.find(s => s.ruleId === 'CA-01').falsePositiveRate, 0);
});

test('audit log CSV escapes commas and quotes and keeps column order', () => {
  const csv = AuditCore.auditLogToCsv([{
    timestamp: '2026-07-19T10:00:00Z', url: 'https://rghs.rajasthan.gov.in/claim', tid: 'T1',
    mode: 'deduct', ruleId: 'BI-01', findingType: 'UNBUNDLING', risk: 'High', action: 'deducted',
    bundleCode: '1394', bundleLabel: 'CBC / Complete Haemogram package', componentCode: '1392',
    componentLabel: 'ESR', rowNumber: 2, claimAmount: 80, amountBefore: '0', amountAfter: '0',
    deductionAmount: 80, reason: 'Included, per master, "expressly"', matchConfidence: 'code', reference: 'ref'
  }]);
  const rows = csv.split('\r\n');
  assert.equal(rows[0], AuditCore.AUDIT_LOG_COLUMNS.join(','));
  assert.match(rows[1], /"Included, per master, ""expressly"""/);
});
