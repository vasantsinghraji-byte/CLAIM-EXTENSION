(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RGHSAuditCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LEGACY_REMARK_PREFIX = '[RGHS-AUDIT]';
  const DEFAULT_EXCEPTION_KEYWORDS = ['repeat', 'follow up', 'follow-up'];
  const LATERALITY_REGEX = /\b(bilateral|b\/l|left|right|both (sides|eyes|limbs|ears))\b/i;
  const STRUCTURED_CODE_PATTERNS = [
    /\bCM-\d{4}\b/g,
    /\b\d{3,4}-[A-Z]{2}\d{2,5}[A-Z]{0,3}\b/g,
    /\bIMPCRD\d{3}\b/g
  ];
  const compiledEntityCache = new WeakMap();

  function normalizeText(value) {
    return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function parseAmount(value) {
    const normalized = String(value ?? '')
      .trim()
      .replace(/[,₹\s]/g, '')
      .replace(/[^0-9.-]/g, '');
    if (!normalized || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  function isEmptyApprovedValue(value) {
    const text = String(value ?? '').trim();
    if (!text) return true;
    return parseAmount(text) === 0;
  }

  function extractCodes(text, knownBareCodes) {
    const upper = String(text ?? '').toUpperCase();
    const found = new Set();
    for (const pattern of STRUCTURED_CODE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of upper.matchAll(pattern)) found.add(match[0]);
    }
    // Bare 3-4 digit tokens are only treated as codes when the rule set knows them,
    // so quantities, rates and years never match.
    for (const match of upper.matchAll(/(?<![\dA-Z.-])(\d{3,4})(?![\dA-Z.-])/g)) {
      if (knownBareCodes && knownBareCodes.has(match[1])) found.add(match[1]);
    }
    return found;
  }

  function compileEntity(entity) {
    const cached = compiledEntityCache.get(entity);
    if (cached) return cached;
    const codes = entity.codes || [];
    const patterns = entity.patterns || [];
    const compiled = {
      label: entity.label || '',
      codes: new Set(codes.map(code => String(code).toUpperCase())),
      regexes: patterns.map(pattern => new RegExp(pattern, 'i'))
    };
    compiledEntityCache.set(entity, compiled);
    return compiled;
  }

  function collectKnownBareCodes(rules) {
    const known = new Set();
    const take = entity => {
      for (const code of entity.codes || []) {
        const upper = String(code).toUpperCase();
        if (/^\d{3,4}$/.test(upper)) known.add(upper);
      }
    };
    for (const rule of rules.bundles || []) {
      take(rule.bundle);
      (rule.components || []).forEach(take);
    }
    for (const rule of rules.mutuallyExclusive || []) (rule.groups || []).forEach(take);
    for (const rule of rules.addOnDependencies || []) {
      take(rule.addOn);
      take(rule.requiresBase);
    }
    for (const rule of rules.combinedAvailable || []) {
      (rule.components || []).forEach(take);
      take(rule.combined);
    }
    for (const rule of rules.adjunctClusters || []) (rule.members || []).forEach(take);
    for (const rule of rules.reviewTriggers || []) take(rule.entity);
    return known;
  }

  function matchEntity(line, compiled) {
    for (const code of compiled.codes) {
      if (line.codes.has(code)) return { via: 'code', code };
    }
    for (const regex of compiled.regexes) {
      if (regex.test(line.text)) return { via: 'name', code: null };
    }
    return null;
  }

  // lines: [{ index, particularText, packageText, claimValue, approvedValue, remarksValue,
  //           rateValue?, unitValue?, dateValue? }]
  function prepareLines(lines, knownBareCodes) {
    return lines.map(line => {
      const rawText = `${line.packageText ?? ''} ${line.particularText ?? ''}`;
      return {
        ...line,
        text: normalizeText(rawText),
        codes: extractCodes(rawText, knownBareCodes),
        claimAmount: parseAmount(line.claimValue),
        rateAmount: parseAmount(line.rateValue),
        unitAmount: parseAmount(line.unitValue),
        dateText: normalizeText(line.dateValue)
      };
    });
  }

  function datesConflict(lineA, lineB) {
    return Boolean(lineA.dateText && lineB.dateText && lineA.dateText !== lineB.dateText);
  }

  function hasExceptionKeyword(line, rule) {
    const keywords = [...DEFAULT_EXCEPTION_KEYWORDS, ...(rule.exceptionKeywords || [])];
    const haystack = `${line.text} ${normalizeText(line.remarksValue)}`;
    return keywords.some(keyword => haystack.includes(normalizeText(keyword)));
  }

  function analyzeBundles(prepared, rules, findings) {
    for (const rule of rules.bundles || []) {
      const bundleEntity = compileEntity(rule.bundle);
      const bundleHits = [];
      for (const line of prepared) {
        const match = matchEntity(line, bundleEntity);
        if (match) bundleHits.push({ line, match });
      }
      if (bundleHits.length === 0) continue;

      // Prefer a code-confirmed bundle line as the anchor.
      const anchor = bundleHits.find(hit => hit.match.via === 'code') || bundleHits[0];
      const bundleLineIndexes = new Set(bundleHits.map(hit => hit.line.index));
      const componentHits = [];
      const claimedComponentRows = new Set();

      for (const component of rule.components || []) {
        const compEntity = compileEntity(component);
        for (const line of prepared) {
          if (bundleLineIndexes.has(line.index) || claimedComponentRows.has(line.index)) continue;
          const match = matchEntity(line, compEntity);
          if (!match) continue;
          claimedComponentRows.add(line.index);
          componentHits.push({ line, match, label: component.label });
        }
      }
      if (componentHits.length === 0) continue;

      if (rule.fixedDeduction) {
        findings.push({
          type: 'UNBUNDLING_FIXED',
          ruleId: rule.ruleId,
          risk: rule.risk,
          category: rule.category,
          action: rule.action,
          autoDeductEligible: rule.autoDeductEligible === true,
          fixedDeduction: rule.fixedDeduction,
          bundleRow: {
            index: anchor.line.index,
            label: rule.bundle.label,
            code: anchor.match.code,
            via: anchor.match.via,
            claimValue: anchor.line.claimValue,
            approvedValue: anchor.line.approvedValue,
            claimAmount: anchor.line.claimAmount
          },
          components: componentHits.map(hit => ({
            index: hit.line.index,
            label: hit.label,
            code: hit.match.code,
            via: hit.match.via
          })),
          exceptionHit: hasExceptionKeyword(anchor.line, rule) ||
            componentHits.some(hit => hasExceptionKeyword(hit.line, rule) || datesConflict(anchor.line, hit.line)),
          remarkReason: rule.remarkReason,
          reference: rule.reference
        });
        continue;
      }

      for (const hit of componentHits) {
        findings.push({
          type: 'UNBUNDLING',
          ruleId: rule.ruleId,
          risk: rule.risk,
          category: rule.category,
          action: rule.action,
          autoDeductEligible: rule.autoDeductEligible === true,
          bundleRow: {
            index: anchor.line.index,
            label: rule.bundle.label,
            code: anchor.match.code,
            via: anchor.match.via,
            claimAmount: anchor.line.claimAmount
          },
          componentRow: {
            index: hit.line.index,
            label: hit.label,
            code: hit.match.code,
            via: hit.match.via,
            claimValue: hit.line.claimValue,
            approvedValue: hit.line.approvedValue,
            claimAmount: hit.line.claimAmount
          },
          // A component on a different service date than its bundle is plausibly a
          // legitimate separate service - downgrade to a review flag.
          exceptionHit: hasExceptionKeyword(hit.line, rule) || datesConflict(anchor.line, hit.line),
          remarkReason: rule.remarkReason,
          reference: rule.reference
        });
      }
    }
  }

  function analyzeDuplicates(prepared, rules, findings) {
    const byCode = new Map();
    for (const line of prepared) {
      for (const code of line.codes) {
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(line);
      }
    }
    for (const [code, lines] of byCode) {
      if (lines.length < 2) continue;
      const amounts = lines.map(line => line.claimAmount);
      const identicalAmounts = amounts.every(amount => amount !== null && amount === amounts[0]);
      // Medical-management (CM-) packages are per-day rates that legitimately split
      // into multiple lines when a stay spans ward types (general ward vs ICU) -
      // same code, different rates/amounts. Only identical amounts are suspicious.
      if (code.startsWith('CM-') && !identicalAmounts) continue;
      // Bilateral/left+right wording means a repeated code can be two genuine sides.
      const lateralityHit = lines.some(line => LATERALITY_REGEX.test(line.text));
      findings.push({
        type: 'DUPLICATE',
        ruleId: 'DUP-CODE',
        risk: 'High',
        category: 'Cross-cutting',
        action: 'deduct-eligible',
        autoDeductEligible: !lateralityHit && (rules.settings || {}).duplicateAutoDeductEligible === true,
        exceptionHit: lateralityHit,
        code,
        firstRow: { index: lines[0].index },
        duplicateRows: lines.slice(1).map(line => ({
          index: line.index,
          claimValue: line.claimValue,
          approvedValue: line.approvedValue,
          claimAmount: line.claimAmount
        })),
        remarkReason: `Package/investigation code ${code} appears ${lines.length} times on this sheet${identicalAmounts ? ' with identical amounts' : ''}${lateralityHit ? ' (laterality wording present - verify sides)' : ''}`,
        reference: 'Audit Rules: Exact duplicate'
      });
    }
  }

  // Claimed amount must not EXCEED rate x units (1-rupee rounding tolerance).
  // Claiming below rate x units is routine on RGHS sheets (admissible-rate caps,
  // ward-wise percentages), so only the over-claim direction is flagged.
  function analyzeAmountConsistency(prepared, findings) {
    for (const line of prepared) {
      if (line.rateAmount === null || line.unitAmount === null || line.claimAmount === null) continue;
      if (line.rateAmount <= 0 || line.unitAmount <= 0) continue;
      const expected = line.rateAmount * line.unitAmount;
      if (line.claimAmount <= expected + 1) continue;
      findings.push({
        type: 'AMOUNT_MISMATCH',
        ruleId: 'AMT-CALC',
        risk: 'Medium',
        category: 'Arithmetic consistency',
        action: 'review-only',
        autoDeductEligible: false,
        rows: [line.index],
        remarkReason: `Claimed ${line.claimAmount} exceeds rate ${line.rateAmount} x ${line.unitAmount} unit(s) = ${expected}`,
        reference: 'Derived check: claimed amount vs rate x units'
      });
    }
  }

  function analyzeMutuallyExclusive(prepared, rules, findings) {
    for (const rule of rules.mutuallyExclusive || []) {
      const groupHits = (rule.groups || []).map(group => {
        const entity = compileEntity(group);
        return prepared.filter(line => matchEntity(line, entity));
      });
      const hitGroups = groupHits.filter(hits => hits.length > 0);
      if (hitGroups.length < 2) continue;
      const rows = [...new Set(hitGroups.flat().map(line => line.index))];
      findings.push({
        type: 'MUTUALLY_EXCLUSIVE',
        ruleId: rule.ruleId,
        risk: rule.risk,
        category: 'Mutually exclusive variants',
        action: 'review-only',
        autoDeductEligible: false,
        rows,
        remarkReason: `${rule.label} billed together - variants are mutually exclusive`,
        reference: rule.reference
      });
    }
  }

  function analyzeAddOns(prepared, rules, findings) {
    for (const rule of rules.addOnDependencies || []) {
      const addOnEntity = compileEntity(rule.addOn);
      const baseEntity = compileEntity(rule.requiresBase);
      const addOnHits = prepared.filter(line => matchEntity(line, addOnEntity));
      if (addOnHits.length === 0) continue;
      const baseHits = prepared.filter(line =>
        !addOnHits.includes(line) && matchEntity(line, baseEntity));
      if (baseHits.length > 0) continue;
      findings.push({
        type: 'ADDON_NO_BASE',
        ruleId: rule.ruleId,
        risk: rule.risk,
        category: 'Add-on dependency',
        action: 'review-only',
        autoDeductEligible: false,
        rows: addOnHits.map(line => line.index),
        remarkReason: `${rule.label} - no qualifying base package found on this sheet`,
        reference: rule.reference
      });
    }
  }

  function analyzeCombinedAvailable(prepared, rules, findings) {
    for (const rule of rules.combinedAvailable || []) {
      const combinedEntity = compileEntity(rule.combined);
      if (prepared.some(line => matchEntity(line, combinedEntity))) continue;
      const groupHits = (rule.components || []).map(group => {
        const entity = compileEntity(group);
        return prepared.filter(line => matchEntity(line, entity));
      });
      // Most combined-package rules require every listed component present.
      // Lab panels set minComponents lower since one component (e.g. Albumin)
      // is often folded into another test's report and never billed as its own line.
      const matchedGroups = groupHits.filter(hits => hits.length > 0);
      const required = rule.minComponents ?? groupHits.length;
      if (matchedGroups.length < required) continue;
      const rows = [...new Set(matchedGroups.flat().map(line => line.index))];
      if (rows.length < 2) continue; // one line matching every group is likely the combined itself
      findings.push({
        type: 'COMBINED_AVAILABLE',
        ruleId: rule.ruleId,
        risk: rule.risk,
        category: 'Combined package available',
        action: 'review-only',
        autoDeductEligible: false,
        rows,
        remarkReason: `${rule.label} - use the combined package or apply the multiple-procedure rule`,
        reference: rule.reference
      });
    }
  }

  function analyzeAdjunctClusters(prepared, rules, findings) {
    for (const rule of rules.adjunctClusters || []) {
      const matchedMembers = [];
      for (const member of rule.members || []) {
        const entity = compileEntity(member);
        const hits = prepared.filter(line => matchEntity(line, entity));
        if (hits.length > 0) matchedMembers.push({ label: member.label, hits });
      }
      if (matchedMembers.length < (rule.minDistinct || 2)) continue;
      const rows = [...new Set(matchedMembers.flatMap(m => m.hits.map(line => line.index)))];
      findings.push({
        type: 'ADJUNCT_CLUSTER',
        ruleId: rule.ruleId,
        risk: rule.risk,
        category: 'Multiple adjuncts',
        action: 'review-only',
        autoDeductEligible: false,
        rows,
        remarkReason: `${rule.label}: ${matchedMembers.map(m => m.label).join(' + ')} - require lesion-specific evidence for each`,
        reference: rule.reference
      });
    }
  }

  function analyzeDuplicateMM(prepared, rules, findings) {
    for (const group of rules.duplicateMMGroups || []) {
      const hits = [];
      for (const code of group.codes || []) {
        const upper = String(code).toUpperCase();
        for (const line of prepared) {
          if (line.codes.has(upper)) hits.push({ code: upper, index: line.index });
        }
      }
      const distinctCodes = [...new Set(hits.map(hit => hit.code))];
      if (distinctCodes.length < 2) continue;
      findings.push({
        type: 'DUPLICATE_MM',
        ruleId: 'MM-DUP',
        risk: group.risk || 'Medium',
        category: 'Medical management',
        action: 'review-only',
        autoDeductEligible: false,
        rows: [...new Set(hits.map(hit => hit.index))],
        remarkReason: `Same diagnosis "${group.name}" billed under multiple specialty codes (${distinctCodes.join(', ')}) - one principal package per continuous admission unless a documented transfer exists`,
        reference: 'Duplicate MM Codes sheet'
      });
    }
  }

  function analyzeReviewTriggers(prepared, rules, findings) {
    for (const rule of rules.reviewTriggers || []) {
      const entity = compileEntity(rule.entity);
      for (const line of prepared) {
        if (!matchEntity(line, entity)) continue;
        findings.push({
          type: 'UPCODING_REVIEW',
          ruleId: rule.ruleId,
          risk: rule.risk,
          category: rule.category || 'Upcoding review',
          action: 'review-only',
          autoDeductEligible: false,
          rows: [line.index],
          remarkReason: `${rule.label} - ${rule.reason}`,
          reference: rule.reference
        });
      }
    }
  }

  function analyzeMultipleMajorProcedures(prepared, findings) {
    const rows = prepared
      .filter(line => line.claimAmount > 0 && /\b(procedure|surgery|operation)\b/.test(line.text))
      .map(line => line.index);
    if (rows.length < 2) return;
    findings.push({
      type: 'MULTIPLE_MAJOR',
      ruleId: 'MULTI-MAJOR',
      risk: 'High',
      category: 'Cross-cutting',
      action: 'review-only',
      autoDeductEligible: false,
      rows,
      remarkReason: 'Multiple positive-value major procedure/surgery lines require combined-package, incidental-service and multiple-procedure review',
      reference: 'Risk Matrix row 51: Multiple major surgeries in the same admission'
    });
  }

  function analyzeClaim(lines, rules) {
    const knownBareCodes = collectKnownBareCodes(rules);
    const prepared = prepareLines(lines, knownBareCodes);
    const findings = [];
    analyzeBundles(prepared, rules, findings);
    analyzeDuplicates(prepared, rules, findings);
    analyzeAmountConsistency(prepared, findings);
    analyzeMutuallyExclusive(prepared, rules, findings);
    analyzeAddOns(prepared, rules, findings);
    analyzeCombinedAvailable(prepared, rules, findings);
    analyzeAdjunctClusters(prepared, rules, findings);
    analyzeDuplicateMM(prepared, rules, findings);
    analyzeReviewTriggers(prepared, rules, findings);
    analyzeMultipleMajorProcedures(prepared, findings);
    return findings;
  }

  function describeCode(label, code) {
    return code ? `${label} (${code})` : label;
  }

  function formatRemark(finding, disposition, rowIndex = null) {
    if (disposition === 'deduct') {
      if (finding.type === 'UNBUNDLING_FIXED') {
        const components = finding.components.map(c => describeCode(c.label, c.code)).join(', ');
        return `${components} is included in ${describeCode(finding.bundleRow.label, finding.bundleRow.code)}. Rs.${finding.fixedDeduction.amount} deducted from the main package as per package terms.`;
      }
      if (finding.type === 'DUPLICATE') {
        return `The same package/procedure code appears more than once in this claim. Duplicate line kept at nil; verify the number of procedures/devices from the supporting documents.`;
      }
      return `${describeCode(finding.componentRow.label, finding.componentRow.code)} is included in ${describeCode(finding.bundleRow.label, finding.bundleRow.code)} and has not been allowed separately.`;
    }
    if (finding.type === 'DUPLICATE') {
      return `The same package/procedure code appears more than once in this claim. Verify the number of procedures/devices and supporting invoices before approval.`;
    }
    if (finding.type === 'UNBUNDLING_FIXED') {
      const isBundleRow = rowIndex === finding.bundleRow.index;
      const components = finding.components.map(c => describeCode(c.label, c.code)).join(', ');
      return isBundleRow
        ? `${components} is shown separately although it is included in this main package. Verify the admissible main-package amount before approval.`
        : `${components} is included in ${describeCode(finding.bundleRow.label, finding.bundleRow.code)} and should not ordinarily be allowed separately. Verify before approval.`;
    }
    if (finding.type === 'UNBUNDLING') {
      return rowIndex === finding.bundleRow.index
        ? `${describeCode(finding.componentRow.label, finding.componentRow.code)} is shown separately although it is included in this main package. Verify the admissible main-package amount before approval.`
        : `${describeCode(finding.componentRow.label, finding.componentRow.code)} is included in ${describeCode(finding.bundleRow.label, finding.bundleRow.code)} and should not ordinarily be allowed separately. Verify before approval.`;
    }
    return `${finding.remarkReason}. Verify the supporting documents before approval.`;
  }

  function remarkAlreadyPresent(remarksValue, ruleId, generatedRemark = '') {
    const remarks = String(remarksValue ?? '');
    return remarks.includes(`Rule ${ruleId}`) || (generatedRemark && remarks.includes(generatedRemark));
  }

  function findingTargets(finding) {
    if (finding.type === 'UNBUNDLING') {
      return [finding.bundleRow.index, finding.componentRow.index];
    }
    // The deduction is calculated against the bundle, but every separately
    // billed component must remain reserved from ordinary autofill.
    if (finding.type === 'UNBUNDLING_FIXED') {
      return [finding.bundleRow.index, ...finding.components.map(component => component.index)];
    }
    if (finding.type === 'DUPLICATE') {
      return [finding.firstRow.index, ...finding.duplicateRows.map(row => row.index)];
    }
    return finding.rows || [];
  }

  // Decide, for each finding, whether it becomes an automatic deduction or a flag.
  // Returns { rowActions: [{rowIndex, setApproved, remark, highlight, ruleId, finding, deductionAmount}], summary }
  function planAuditActions(findings, lines, options = {}) {
    const mode = options.mode || 'flag';
    const settings = options.settings || {};
    const maxTotal = settings.maxAutoDeductionTotal ?? 10000;
    const maxLines = settings.maxAutoDeductionLines ?? 5;
    const rowActions = [];
    if (mode === 'off') return { rowActions, summary: { flagged: 0, deducted: 0 } };

    const lineByIndex = new Map(lines.map(line => [line.index, line]));

    for (const finding of findings) {
      let deduct = false;
      let setApproved = null;
      let deductionAmount = 0;
      let targetRow = null;
      let downgradeReason = null;

      if (mode === 'deduct' && finding.autoDeductEligible && finding.action === 'deduct-eligible' && !finding.exceptionHit) {
        if (finding.type === 'UNBUNDLING') {
          const comp = finding.componentRow;
          const codeConfirmed = finding.bundleRow.via === 'code' && comp.via === 'code';
          const sane = comp.claimAmount !== null &&
            (finding.bundleRow.claimAmount === null || comp.claimAmount < finding.bundleRow.claimAmount);
          if (!codeConfirmed) downgradeReason = 'name-only-match';
          else if (!isEmptyApprovedValue(comp.approvedValue)) downgradeReason = 'approved-already-set';
          else if (!sane) downgradeReason = 'component-exceeds-bundle';
          else {
            deduct = true;
            setApproved = '0';
            deductionAmount = comp.claimAmount;
            targetRow = comp.index;
          }
        } else if (finding.type === 'UNBUNDLING_FIXED') {
          const bundle = finding.bundleRow;
          const codeConfirmed = bundle.via === 'code' && finding.components.every(c => c.via === 'code');
          if (!codeConfirmed) downgradeReason = 'name-only-match';
          else if (!isEmptyApprovedValue(bundle.approvedValue)) downgradeReason = 'approved-already-set';
          else if (bundle.claimAmount === null || bundle.claimAmount < finding.fixedDeduction.amount) downgradeReason = 'claim-below-fixed-deduction';
          else {
            deduct = true;
            setApproved = String(bundle.claimAmount - finding.fixedDeduction.amount);
            deductionAmount = finding.fixedDeduction.amount;
            targetRow = bundle.index;
          }
        } else if (finding.type === 'DUPLICATE') {
          // Zero every duplicate occurrence after the first (each is its own action below).
          deduct = true;
        }
      } else if (mode === 'deduct' && finding.action === 'deduct-eligible' && !finding.autoDeductEligible) {
        downgradeReason = 'rule-not-yet-allowlisted';
      } else if (finding.exceptionHit) {
        downgradeReason = 'exception-keyword';
      }

      const targets = findingTargets(finding);
      for (const rowIndex of targets) {
        const line = lineByIndex.get(rowIndex);
        const disposition = deduct && finding.type === 'DUPLICATE' &&
          finding.duplicateRows.some(row => row.index === rowIndex) ? 'deduct' : 'flag';
        const generatedRemark = formatRemark(finding, disposition, rowIndex);
        const appendRemark = !(line && remarkAlreadyPresent(line.remarksValue, finding.ruleId, generatedRemark));

        if (deduct && finding.type === 'DUPLICATE') {
          const dupRow = finding.duplicateRows.find(row => row.index === rowIndex);
          const canZero = dupRow && dupRow.claimAmount !== null && isEmptyApprovedValue(dupRow.approvedValue);
          rowActions.push({
            rowIndex,
            ruleId: finding.ruleId,
            setApproved: canZero ? '0' : null,
            deductionAmount: canZero ? dupRow.claimAmount : 0,
            remark: formatRemark(finding, canZero ? 'deduct' : 'flag', rowIndex),
            highlight: canZero ? 'deduct' : 'review',
            downgradeReason: canZero ? null : 'approved-already-set',
            appendRemark,
            finding
          });
          continue;
        }

        const isDeductRow = deduct && rowIndex === targetRow;
        rowActions.push({
          rowIndex,
          ruleId: finding.ruleId,
          setApproved: isDeductRow ? setApproved : null,
          deductionAmount: isDeductRow ? deductionAmount : 0,
          remark: formatRemark(finding, isDeductRow ? 'deduct' : 'flag', rowIndex),
          highlight: isDeductRow ? 'deduct' : (finding.action === 'deduct-eligible' ? 'candidate' : 'review'),
          downgradeReason: isDeductRow ? null : downgradeReason,
          appendRemark,
          finding
        });
      }
    }

    // Per-sheet safety cap: too much or too many automatic deductions -> everything
    // downgrades to a flag for manual handling.
    const deductActions = rowActions.filter(action => action.setApproved !== null);
    const total = deductActions.reduce((sum, action) => sum + action.deductionAmount, 0);
    if (deductActions.length > maxLines || total > maxTotal) {
      for (const action of deductActions) {
        action.setApproved = null;
        action.downgradeReason = 'safety-cap';
        action.highlight = 'candidate';
        action.remark = formatRemark(action.finding, 'flag', action.rowIndex);
      }
    }

    const deducted = rowActions.filter(action => action.setApproved !== null).length;
    return {
      rowActions,
      summary: {
        flagged: rowActions.length - deducted,
        deducted,
        reviewRows: [...new Set(rowActions.filter(a => a.setApproved === null).map(a => a.rowIndex))]
      }
    };
  }

  const AUDIT_LOG_COLUMNS = [
    'timestamp', 'url', 'tid', 'mode', 'ruleId', 'findingType', 'risk', 'action',
    'bundleCode', 'bundleLabel', 'componentCode', 'componentLabel', 'rowNumber',
    'claimAmount', 'amountBefore', 'amountAfter', 'deductionAmount', 'reason', 'matchConfidence', 'reference'
  ];

  function buildAuditEntry(action, context = {}) {
    const finding = action.finding;
    const comp = finding.componentRow || (finding.duplicateRows && finding.duplicateRows[0]) || null;
    return {
      timestamp: context.timestamp || new Date().toISOString(),
      url: context.url || '',
      tid: context.tid || '',
      mode: context.mode || '',
      ruleId: finding.ruleId,
      findingType: finding.type,
      risk: finding.risk || '',
      action: action.setApproved !== null ? 'deducted' : 'flagged',
      bundleCode: finding.bundleRow ? finding.bundleRow.code || '' : '',
      bundleLabel: finding.bundleRow ? finding.bundleRow.label || '' : '',
      componentCode: comp ? comp.code || finding.code || '' : finding.code || '',
      componentLabel: comp ? comp.label || '' : '',
      rowNumber: action.rowIndex,
      claimAmount: comp && comp.claimAmount != null ? comp.claimAmount : '',
      amountBefore: context.amountBefore ?? '',
      amountAfter: action.setApproved !== null ? action.setApproved : '',
      deductionAmount: action.deductionAmount || 0,
      reason: action.downgradeReason ? `${finding.remarkReason} [${action.downgradeReason}]` : finding.remarkReason,
      matchConfidence: finding.bundleRow && finding.bundleRow.via === 'code' ? 'code' : 'name',
      reference: finding.reference || ''
    };
  }

  // Merge user allowlist overrides (chrome.storage) over the generated rules.
  // Only autoDeductEligible may be overridden, and only on deduct-eligible rules.
  function applyRuleOverrides(rules, overrides) {
    if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return rules;
    const bundles = (rules.bundles || []).map(rule => {
      const override = overrides[rule.ruleId];
      if (!override || rule.action !== 'deduct-eligible') return rule;
      return { ...rule, autoDeductEligible: override.autoDeductEligible === true };
    });
    return { ...rules, bundles };
  }

  // Remove a legacy branded rule segment from remarks. New portal remarks contain
  // no extension or rule identifiers and are therefore left as ordinary remarks.
  function stripAuditRemark(remarksValue, ruleId) {
    return String(remarksValue ?? '')
      .split('; ')
      .filter(segment => !(segment.includes(LEGACY_REMARK_PREFIX) && segment.includes(`Rule ${ruleId}`)))
      .join('; ')
      .trim();
  }

  function logEntryKey(entry) {
    return [entry.url, entry.tid, entry.ruleId, entry.rowNumber, entry.findingType, entry.action].join('|');
  }

  // Drop incoming entries already recorded for the same claim/rule/row/action,
  // so re-running the fill on the same sheet does not inflate the log.
  function dedupeLogEntries(existing, incoming) {
    const seen = new Set(existing.map(logEntryKey));
    return incoming.filter(entry => {
      const key = logEntryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Per-rule statistics from the audit log plus auditor feedback, for the
  // promotion decision: a rule earns auto-deduct only with a low dismissal rate.
  function summarizeAudit(logEntries = [], feedbackEntries = []) {
    const stats = new Map();
    const get = ruleId => {
      if (!stats.has(ruleId)) {
        stats.set(ruleId, { ruleId, flagged: 0, deducted: 0, confirmed: 0, dismissed: 0 });
      }
      return stats.get(ruleId);
    };
    for (const entry of logEntries) {
      const stat = get(entry.ruleId);
      if (entry.action === 'deducted') stat.deducted++;
      else stat.flagged++;
    }
    for (const feedback of feedbackEntries) {
      const stat = get(feedback.ruleId);
      if (feedback.verdict === 'confirmed') stat.confirmed++;
      else if (feedback.verdict === 'dismissed') stat.dismissed++;
    }
    return [...stats.values()].map(stat => ({
      ...stat,
      falsePositiveRate: (stat.confirmed + stat.dismissed) > 0
        ? stat.dismissed / (stat.confirmed + stat.dismissed)
        : null
    }));
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function auditLogToCsv(entries) {
    const header = AUDIT_LOG_COLUMNS.join(',');
    const rows = entries.map(entry =>
      AUDIT_LOG_COLUMNS.map(column => csvEscape(entry[column])).join(','));
    return [header, ...rows].join('\r\n');
  }

  function validateRuleSet(rules) {
    const errors = [];
    if (!rules || typeof rules !== 'object') return { ok: false, errors: ['rule set must be an object'] };
    if (rules.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rules.version || ''))) errors.push('version must be YYYY-MM-DD');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rules.effectiveDate || ''))) errors.push('effectiveDate must be YYYY-MM-DD');
    if (!rules.settings || typeof rules.settings !== 'object' || Array.isArray(rules.settings)) errors.push('settings must be an object');

    const seen = new Set();
    const collections = ['bundles', 'mutuallyExclusive', 'addOnDependencies', 'combinedAvailable', 'adjunctClusters', 'reviewTriggers'];
    for (const collection of collections) {
      if (!Array.isArray(rules[collection])) {
        errors.push(`${collection} must be an array`);
        continue;
      }
      for (const rule of rules[collection]) {
        const id = String(rule?.ruleId || '').trim();
        if (!id) errors.push(`${collection} contains a rule without ruleId`);
        else if (seen.has(id)) errors.push(`duplicate ruleId: ${id}`);
        else seen.add(id);
        if (!['low', 'medium', 'high'].includes(String(rule?.risk || '').toLowerCase())) {
          errors.push(`${id || collection} has invalid risk`);
        }
        if (rule?.action && !['flag', 'review-only', 'deduct-eligible'].includes(rule.action)) {
          errors.push(`${id || collection} has invalid action`);
        }
        if (rule?.fixedDeduction && (!Number.isFinite(rule.fixedDeduction.amount) || rule.fixedDeduction.amount < 0)) {
          errors.push(`${id || collection} has invalid fixed deduction`);
        }
      }
    }
    if (!Array.isArray(rules.duplicateMMGroups)) errors.push('duplicateMMGroups must be an array');
    return { ok: errors.length === 0, errors };
  }

  return {
    REMARK_PREFIX: LEGACY_REMARK_PREFIX,
    AUDIT_LOG_COLUMNS,
    normalizeText,
    parseAmount,
    isEmptyApprovedValue,
    extractCodes,
    collectKnownBareCodes,
    analyzeClaim,
    planAuditActions,
    formatRemark,
    remarkAlreadyPresent,
    buildAuditEntry,
    auditLogToCsv,
    applyRuleOverrides,
    stripAuditRemark,
    dedupeLogEntries,
    summarizeAudit,
    validateRuleSet
  };
});
