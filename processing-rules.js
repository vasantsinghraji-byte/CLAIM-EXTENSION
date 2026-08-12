(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaimProcessingRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const PROCESSING_AREAS = Object.freeze(['ALL', 'OPD', 'PHARMACY', 'IPD']);
  const ENFORCEMENT_LEVELS = Object.freeze(['advisory', 'mandatory', 'blocking', 'manualReview']);
  const CONDITION_OPERATORS = Object.freeze([
    'all', 'any', 'not', 'packagePresent', 'packageAbsent', 'packageCombinationPresent',
    'packageCombinationAbsent', 'packageCodeEquals', 'processingOutcomeEquals',
    'claimedAmountGreaterThan', 'claimedAmountLessThan', 'approvedAmountGreaterThan',
    'deductionGreaterThan'
  ]);
  const ACTION_TYPES = Object.freeze([
    'warn', 'blockProcessing', 'excludePackage', 'applyDeduction', 'writeRemark', 'requireValidation'
  ]);
  const COLUMN_KEYS = Object.freeze(['remarks', 'deductionRemarks', 'pharmacyRemarks', 'validationRemarks']);
  const FEEDBACK_CATEGORIES = Object.freeze([
    'rule_not_triggered', 'rule_triggered_incorrectly', 'incorrect_deduction', 'incorrect_remark',
    'incorrect_target_column', 'missing_package_combination', 'unexpected_block',
    'additional_validation_needed'
  ]);
  const ALLOWED_TEMPLATE_TOKENS = new Set([
    'rule_id', 'rule_name', 'package_code', 'deduction', 'deduction_percent', 'reason'
  ]);
  const MAX_RULES = 1000;
  const MAX_CONDITION_DEPTH = 6;

  function cleanText(value, maximum = 500) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
  }

  function normalizeCode(value) {
    return cleanText(value, 80).toUpperCase();
  }

  function uniqueCodes(value) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
    return [...new Set(source.map(normalizeCode).filter(Boolean))];
  }

  function finiteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validateTemplate(template, errors, field) {
    const text = cleanText(template, 1000);
    if (String(template ?? '').length > 1000) errors.push(`${field} is too long`);
    for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
      if (!ALLOWED_TEMPLATE_TOKENS.has(match[1])) errors.push(`${field} uses unknown token {${match[1]}}`);
    }
    return text;
  }

  function normalizeCondition(value, errors, path = 'conditions', depth = 0) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const operator = cleanText(source.operator, 50);
    if (!CONDITION_OPERATORS.includes(operator)) errors.push(`${path}.operator is invalid`);
    if (depth > MAX_CONDITION_DEPTH) errors.push(`${path} exceeds maximum nesting depth`);

    if (operator === 'all' || operator === 'any') {
      const children = Array.isArray(source.conditions) ? source.conditions : [];
      if (!children.length) errors.push(`${path}.conditions must not be empty`);
      return {
        operator,
        conditions: children.slice(0, 50).map((child, index) =>
          normalizeCondition(child, errors, `${path}.conditions[${index}]`, depth + 1))
      };
    }
    if (operator === 'not') {
      if (!source.condition) errors.push(`${path}.condition is required`);
      return { operator, condition: normalizeCondition(source.condition, errors, `${path}.condition`, depth + 1) };
    }
    if (['packagePresent', 'packageAbsent', 'packageCombinationPresent', 'packageCombinationAbsent', 'packageCodeEquals']
      .includes(operator)) {
      const packageCodes = uniqueCodes(source.packageCodes);
      const minimum = operator.startsWith('packageCombination') ? 2 : 1;
      if (packageCodes.length < minimum) errors.push(`${path}.packageCodes requires at least ${minimum} code(s)`);
      return { operator, packageCodes };
    }
    if (operator === 'processingOutcomeEquals') {
      const outcome = cleanText(source.value, 40);
      if (!outcome) errors.push(`${path}.value is required`);
      return { operator, value: outcome };
    }
    const amount = finiteNumber(source.value);
    if (amount === null || amount < 0) errors.push(`${path}.value must be a non-negative number`);
    return { operator, value: amount ?? 0, packageCodes: uniqueCodes(source.packageCodes) };
  }

  function normalizeAction(value, errors, path = 'actions[0]') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const type = cleanText(source.type, 50);
    if (!ACTION_TYPES.includes(type)) errors.push(`${path}.type is invalid`);
    const targetPackageCodes = uniqueCodes(source.targetPackageCodes);

    if (type === 'warn' || type === 'blockProcessing') {
      const message = cleanText(source.message, 500);
      if (!message) errors.push(`${path}.message is required`);
      return { type, message };
    }
    if (type === 'requireValidation') {
      const validationCode = cleanText(source.validationCode, 80).toUpperCase();
      const message = cleanText(source.message, 500);
      if (!/^[A-Z][A-Z0-9_-]{2,79}$/.test(validationCode)) errors.push(`${path}.validationCode is invalid`);
      if (!message) errors.push(`${path}.message is required`);
      return { type, validationCode, message };
    }
    if (type === 'excludePackage') {
      if (!targetPackageCodes.length) errors.push(`${path}.targetPackageCodes is required`);
      return { type, targetPackageCodes };
    }
    if (type === 'applyDeduction') {
      const calculation = source.calculation && typeof source.calculation === 'object' ? source.calculation : {};
      const method = cleanText(calculation.method, 40);
      const allowedMethods = ['fixedAmount', 'percentage', 'minimumAmount', 'fullAmount'];
      if (!allowedMethods.includes(method)) errors.push(`${path}.calculation.method is invalid`);
      const numericValue = method === 'fullAmount' ? 100 : finiteNumber(calculation.value);
      if (numericValue === null || numericValue < 0 || (method === 'percentage' && numericValue > 100)) {
        errors.push(`${path}.calculation.value is invalid`);
      }
      const basis = cleanText(calculation.basis || 'claimedAmount', 40);
      if (!['claimedAmount', 'currentApprovedAmount'].includes(basis)) errors.push(`${path}.calculation.basis is invalid`);
      if (!targetPackageCodes.length) errors.push(`${path}.targetPackageCodes is required`);
      return {
        type,
        targetPackageCodes,
        calculation: { method, basis, value: numericValue ?? 0 },
        cumulative: source.cumulative === true
      };
    }
    if (type === 'writeRemark') {
      const target = source.target && typeof source.target === 'object' ? source.target : {};
      const sheet = cleanText(target.sheet, 20).toUpperCase();
      const columnKey = cleanText(target.columnKey, 50);
      const writeMode = cleanText(source.writeMode || 'append', 20);
      if (!PROCESSING_AREAS.includes(sheet) || sheet === 'ALL') errors.push(`${path}.target.sheet is invalid`);
      if (!COLUMN_KEYS.includes(columnKey)) errors.push(`${path}.target.columnKey is invalid`);
      if (!['append', 'replace'].includes(writeMode)) errors.push(`${path}.writeMode is invalid`);
      const template = validateTemplate(source.template, errors, `${path}.template`);
      if (!template) errors.push(`${path}.template is required`);
      return { type, targetPackageCodes, target: { sheet, columnKey }, writeMode, template };
    }
    return { type };
  }

  function validateRule(value, existingIds = []) {
    const errors = [];
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const ruleId = cleanText(source.ruleId, 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{2,79}$/.test(ruleId)) errors.push('ruleId is invalid');
    if (new Set(existingIds.map(item => String(item).toUpperCase())).has(ruleId)) errors.push(`duplicate ruleId: ${ruleId}`);
    const name = cleanText(source.name, 160);
    if (!name) errors.push('name is required');
    const processingArea = cleanText(source.processingArea || 'ALL', 20).toUpperCase();
    if (!PROCESSING_AREAS.includes(processingArea)) errors.push('processingArea is invalid');
    const priority = finiteNumber(source.priority);
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 9999) errors.push('priority must be an integer from 1 to 9999');
    const enforcement = cleanText(source.enforcement || 'advisory', 30);
    if (!ENFORCEMENT_LEVELS.includes(enforcement)) errors.push('enforcement is invalid');
    const conditions = normalizeCondition(source.conditions, errors);
    const actionSource = Array.isArray(source.actions) ? source.actions : [];
    if (!actionSource.length) errors.push('actions must not be empty');
    const actions = actionSource.slice(0, 20).map((action, index) => normalizeAction(action, errors, `actions[${index}]`));
    if (enforcement === 'blocking' && !actions.some(action => action.type === 'blockProcessing')) {
      errors.push('blocking rules require a blockProcessing action');
    }
    if (enforcement === 'manualReview' && !actions.some(action => action.type === 'requireValidation')) {
      errors.push('manualReview rules require a requireValidation action');
    }
    return {
      ok: errors.length === 0,
      errors,
      rule: {
        ruleId,
        name,
        description: cleanText(source.description, 500),
        schemaVersion: SCHEMA_VERSION,
        processingArea,
        enabled: source.enabled !== false,
        priority: Number.isSafeInteger(priority) ? priority : 9999,
        enforcement,
        conditions,
        actions
      }
    };
  }

  function actionTargetKey(rule, action) {
    const targets = (action.targetPackageCodes || []).slice().sort().join(',');
    if (action.type === 'writeRemark') return `${rule.processingArea}:${action.target.columnKey}:${targets || '*'}`;
    if (['applyDeduction', 'excludePackage'].includes(action.type)) return `${rule.processingArea}:amount:${targets}`;
    return '';
  }

  function detectConflicts(rules) {
    const errors = [];
    const seen = new Map();
    for (const rule of rules.filter(item => item.enabled && item.enforcement !== 'advisory')) {
      for (const action of rule.actions) {
        const target = actionTargetKey(rule, action);
        if (!target) continue;
        const key = `${rule.priority}:${target}`;
        const previous = seen.get(key);
        if (previous && (action.type === 'writeRemark' && action.writeMode === 'replace'
          || ['applyDeduction', 'excludePackage'].includes(action.type))) {
          errors.push(`rules ${previous} and ${rule.ruleId} have an ambiguous mandatory target at priority ${rule.priority}`);
        } else {
          seen.set(key, rule.ruleId);
        }
      }
    }
    return errors;
  }

  function normalizeRuleSet(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const errors = [];
    if (source.schemaVersion !== undefined && source.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`schemaVersion must equal ${SCHEMA_VERSION}`);
    }
    const candidates = Array.isArray(source.rules) ? source.rules : [];
    if (candidates.length > MAX_RULES) errors.push(`rules cannot exceed ${MAX_RULES}`);
    const rules = [];
    const ids = [];
    for (const candidate of candidates.slice(0, MAX_RULES)) {
      const result = validateRule(candidate, ids);
      if (!result.ok) errors.push(...result.errors.map(error => `${result.rule.ruleId || 'rule'}: ${error}`));
      rules.push(result.rule);
      ids.push(result.rule.ruleId);
    }
    errors.push(...detectConflicts(rules));
    return {
      schemaVersion: SCHEMA_VERSION,
      versionId: cleanText(source.versionId, 128),
      checksum: cleanText(source.checksum, 128),
      rules: rules.sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId)),
      errors
    };
  }

  function extractLineCodes(line) {
    const explicit = uniqueCodes(line.packageCodes || line.codes || []);
    // Only the portal's designated package-code cell is eligible for inferred
    // codes. Particular/description text can contain dosages, years and other
    // numeric tokens that must never activate a financial rule.
    const text = String(line.packageText || '').toUpperCase();
    const tokens = text.match(/[A-Z0-9]+(?:[-_/][A-Z0-9]+)*/g) || [];
    return new Set([...explicit, ...tokens.map(normalizeCode)]);
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  async function verifyPublishedRuleSet(ruleSet) {
    if (!ruleSet || ruleSet.schemaVersion !== SCHEMA_VERSION || !Array.isArray(ruleSet.rules)) return false;
    const checksum = cleanText(ruleSet.checksum, 128);
    if (!/^sha256:[a-f0-9]{64}:(?:fallback|central)$/i.test(checksum)) return false;
    const bytes = new TextEncoder().encode(canonicalJson({ schemaVersion: SCHEMA_VERSION, rules: ruleSet.rules }));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const mode = ruleSet.bundledFallbackEnabled === false ? 'central' : 'fallback';
    return checksum.toLowerCase() === `sha256:${hex}:${mode}`;
  }

  function lineHasCode(line, codes) {
    const available = line._processingCodes || extractLineCodes(line);
    return codes.some(code => available.has(code));
  }

  function relevantLines(context, packageCodes = []) {
    return packageCodes.length ? context.lines.filter(line => lineHasCode(line, packageCodes)) : context.lines;
  }

  function conditionMatches(condition, context) {
    if (condition.operator === 'all') return condition.conditions.every(item => conditionMatches(item, context));
    if (condition.operator === 'any') return condition.conditions.some(item => conditionMatches(item, context));
    if (condition.operator === 'not') return !conditionMatches(condition.condition, context);
    if (condition.operator === 'packagePresent' || condition.operator === 'packageCodeEquals') {
      return condition.packageCodes.some(code => context.packageCodes.has(code));
    }
    if (condition.operator === 'packageAbsent') return condition.packageCodes.every(code => !context.packageCodes.has(code));
    if (condition.operator === 'packageCombinationPresent') {
      return condition.packageCodes.every(code => context.packageCodes.has(code));
    }
    if (condition.operator === 'packageCombinationAbsent') {
      return !condition.packageCodes.every(code => context.packageCodes.has(code));
    }
    if (condition.operator === 'processingOutcomeEquals') return context.outcome === condition.value;
    const lines = relevantLines(context, condition.packageCodes || []);
    if (condition.operator === 'claimedAmountGreaterThan') return lines.some(line => line.claimAmount > condition.value);
    if (condition.operator === 'claimedAmountLessThan') return lines.some(line => line.claimAmount < condition.value);
    if (condition.operator === 'approvedAmountGreaterThan') return lines.some(line => line.currentApproved > condition.value);
    if (condition.operator === 'deductionGreaterThan') {
      return lines.some(line => Math.max(0, line.claimAmount - line.currentApproved) > condition.value);
    }
    return false;
  }

  function formatTemplate(template, values) {
    return cleanText(String(template || '').replace(/\{([^{}]+)\}/g, (match, key) =>
      ALLOWED_TEMPLATE_TOKENS.has(key) ? cleanText(values[key], 500) : match), 1000);
  }

  function deductionFor(action, line) {
    const { method, basis, value } = action.calculation;
    const calculationBase = basis === 'currentApprovedAmount' ? line.currentApproved : line.claimAmount;
    if (method === 'fullAmount') return action.cumulative ? line.currentApproved : line.claimAmount;
    if (method === 'percentage') return calculationBase * value / 100;
    if (method === 'minimumAmount') {
      const existing = Math.max(0, line.claimAmount - line.currentApproved);
      return action.cumulative ? Math.max(0, value - existing) : Math.max(existing, value);
    }
    return value;
  }

  function evaluate(ruleSetValue, linesValue, processingArea, options = {}) {
    const normalized = normalizeRuleSet(ruleSetValue);
    if (normalized.errors.length) return { ok: false, errors: normalized.errors, blocked: true, rowActions: [] };
    const area = cleanText(processingArea, 20).toUpperCase();
    const lines = (Array.isArray(linesValue) ? linesValue : []).map(line => {
      const claimAmount = Math.max(0, finiteNumber(line.claimAmount ?? line.claimValue) || 0);
      const approved = finiteNumber(line.approvedAmount ?? line.approvedValue);
      return {
        ...line,
        claimAmount,
        currentApproved: approved === null || approved <= 0 ? claimAmount : approved,
        _processingCodes: extractLineCodes(line)
      };
    });
    const context = {
      lines,
      packageCodes: new Set(lines.flatMap(line => [...line._processingCodes])),
      outcome: cleanText(options.outcome, 40)
    };
    const state = new Map(lines.map(line => [line.index, {
      rowIndex: line.index,
      packageCode: [...line._processingCodes][0] || '',
      proposedApproved: line.currentApproved,
      remarks: {},
      remarkModes: {},
      ruleIds: [],
      enforcement: 'advisory',
      excluded: false
    }]));
    const warnings = [];
    const validations = [];
    const matchedRuleIds = [];
    let blocked = false;
    const blockMessages = [];

    for (const rule of normalized.rules) {
      if (!rule.enabled || !['ALL', area].includes(rule.processingArea) || !conditionMatches(rule.conditions, context)) continue;
      matchedRuleIds.push(rule.ruleId);
      for (const action of rule.actions) {
        if (action.type === 'warn') warnings.push({ ruleId: rule.ruleId, message: action.message });
        if (action.type === 'blockProcessing') {
          blocked = true;
          blockMessages.push({ ruleId: rule.ruleId, message: action.message });
        }
        if (action.type === 'requireValidation') {
          validations.push({ ruleId: rule.ruleId, validationCode: action.validationCode, message: action.message });
          if (rule.enforcement === 'manualReview') blocked = true;
        }
        const targets = relevantLines(context, action.targetPackageCodes || []);
        for (const line of targets) {
          const row = state.get(line.index);
          if (!row) continue;
          const matchedTargetCode = (action.targetPackageCodes || []).find(code => line._processingCodes.has(code));
          if (matchedTargetCode) row.packageCode = matchedTargetCode;
          if (action.type === 'excludePackage') {
            row.proposedApproved = 0;
            row.excluded = true;
          } else if (action.type === 'applyDeduction' && !row.excluded) {
            const deduction = Math.min(row.proposedApproved, Math.max(0, deductionFor(action, {
              ...line,
              currentApproved: row.proposedApproved
            })));
            const nextApproved = action.cumulative
              ? row.proposedApproved - deduction
              : Math.min(row.proposedApproved, line.claimAmount - deduction);
            row.proposedApproved = Math.max(0, Math.round(nextApproved * 100) / 100);
          } else if (action.type === 'writeRemark' && action.target.sheet === area) {
            const deduction = Math.max(0, line.claimAmount - row.proposedApproved);
            const remark = formatTemplate(action.template, {
              rule_id: rule.ruleId,
              rule_name: rule.name,
              package_code: row.packageCode,
              deduction,
              deduction_percent: line.claimAmount ? Math.round(deduction / line.claimAmount * 10000) / 100 : 0,
              reason: rule.description
            });
            const existing = row.remarks[action.target.columnKey] || '';
            row.remarks[action.target.columnKey] = action.writeMode === 'replace' || !existing
              ? remark
              : `${existing}; ${remark}`;
            row.remarkModes[action.target.columnKey] = action.writeMode;
          }
          if (['excludePackage', 'applyDeduction', 'writeRemark'].includes(action.type)) {
            row.ruleIds.push(rule.ruleId);
            if (rule.enforcement !== 'advisory') row.enforcement = rule.enforcement;
          }
        }
      }
      const evaluatedRows = lines.map(line => ({ line, row: state.get(line.index) }));
      context.outcome = blocked
        ? 'blocked'
        : evaluatedRows.some(({ row }) => row.excluded)
          ? 'rejected'
          : evaluatedRows.some(({ line, row }) => row.proposedApproved < line.claimAmount)
            ? 'deducted'
            : 'approved';
    }
    return {
      ok: true,
      errors: [],
      blocked,
      blockMessages,
      warnings,
      validations,
      matchedRuleIds: [...new Set(matchedRuleIds)],
      rowActions: [...state.values()].filter(row => row.ruleIds.length)
        .map(row => ({ ...row, ruleIds: [...new Set(row.ruleIds)] }))
    };
  }

  return Object.freeze({
    SCHEMA_VERSION,
    PROCESSING_AREAS,
    ENFORCEMENT_LEVELS,
    CONDITION_OPERATORS,
    ACTION_TYPES,
    COLUMN_KEYS,
    FEEDBACK_CATEGORIES,
    normalizeCode,
    normalizeRuleSet,
    verifyPublishedRuleSet,
    validateRule,
    detectConflicts,
    evaluate,
    formatTemplate
  });
});
