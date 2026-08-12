'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 2;
const AREAS = new Set(['ALL', 'OPD', 'PHARMACY', 'IPD']);
const ENFORCEMENT = new Set(['advisory', 'mandatory', 'blocking', 'manualReview']);
const CONDITION_OPERATORS = new Set([
  'all', 'any', 'not', 'packagePresent', 'packageAbsent', 'packageCombinationPresent',
  'packageCombinationAbsent', 'packageCodeEquals', 'processingOutcomeEquals',
  'claimedAmountGreaterThan', 'claimedAmountLessThan', 'approvedAmountGreaterThan',
  'deductionGreaterThan'
]);
const ACTION_TYPES = new Set([
  'warn', 'blockProcessing', 'excludePackage', 'applyDeduction', 'writeRemark', 'requireValidation'
]);
const COLUMN_KEYS = new Set(['remarks', 'deductionRemarks', 'pharmacyRemarks', 'validationRemarks']);
const TEMPLATE_TOKENS = new Set(['rule_id', 'rule_name', 'package_code', 'deduction', 'deduction_percent', 'reason']);
const FEEDBACK_CATEGORIES = Object.freeze([
  'rule_not_triggered', 'rule_triggered_incorrectly', 'incorrect_deduction', 'incorrect_remark',
  'incorrect_target_column', 'missing_package_combination', 'unexpected_block', 'additional_validation_needed'
]);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function keys(value, allowed, required, name) {
  const source = object(value, name);
  const unknown = Object.keys(source).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`${name}.${unknown} is not allowed`);
  const missing = required.find(key => !Object.prototype.hasOwnProperty.call(source, key));
  if (missing) throw new Error(`${name}.${missing} is required`);
  return source;
}

function text(value, name, maximum = 500) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function codes(value, name, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) throw new Error(`${name} is invalid`);
  const normalized = [...new Set(value.map((item, index) => text(item, `${name}[${index}]`, 80).toUpperCase()))];
  if (normalized.length < minimum) throw new Error(`${name} is invalid`);
  return normalized;
}

function number(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function condition(value, path = 'conditions', depth = 0) {
  if (depth > 6) throw new Error(`${path} is too deeply nested`);
  const source = object(value, path);
  const operator = text(source.operator, `${path}.operator`, 50);
  if (!CONDITION_OPERATORS.has(operator)) throw new Error(`${path}.operator is invalid`);
  if (operator === 'all' || operator === 'any') {
    keys(source, ['operator', 'conditions'], ['operator', 'conditions'], path);
    if (!Array.isArray(source.conditions) || !source.conditions.length || source.conditions.length > 50) {
      throw new Error(`${path}.conditions is invalid`);
    }
    return { operator, conditions: source.conditions.map((item, index) => condition(item, `${path}.conditions[${index}]`, depth + 1)) };
  }
  if (operator === 'not') {
    keys(source, ['operator', 'condition'], ['operator', 'condition'], path);
    return { operator, condition: condition(source.condition, `${path}.condition`, depth + 1) };
  }
  if (['packagePresent', 'packageAbsent', 'packageCombinationPresent', 'packageCombinationAbsent', 'packageCodeEquals'].includes(operator)) {
    keys(source, ['operator', 'packageCodes'], ['operator', 'packageCodes'], path);
    return { operator, packageCodes: codes(source.packageCodes, `${path}.packageCodes`, operator.startsWith('packageCombination') ? 2 : 1) };
  }
  if (operator === 'processingOutcomeEquals') {
    keys(source, ['operator', 'value'], ['operator', 'value'], path);
    return { operator, value: text(source.value, `${path}.value`, 40) };
  }
  keys(source, ['operator', 'value', 'packageCodes'], ['operator', 'value'], path);
  return {
    operator,
    value: number(source.value, `${path}.value`),
    packageCodes: source.packageCodes === undefined ? [] : codes(source.packageCodes, `${path}.packageCodes`)
  };
}

function template(value, path) {
  const normalized = text(value, path, 1000);
  for (const match of normalized.matchAll(/\{([^{}]+)\}/g)) {
    if (!TEMPLATE_TOKENS.has(match[1])) throw new Error(`${path} uses an unknown token`);
  }
  return normalized;
}

function action(value, path) {
  const source = object(value, path);
  const type = text(source.type, `${path}.type`, 50);
  if (!ACTION_TYPES.has(type)) throw new Error(`${path}.type is invalid`);
  if (type === 'warn' || type === 'blockProcessing') {
    keys(source, ['type', 'message'], ['type', 'message'], path);
    return { type, message: text(source.message, `${path}.message`) };
  }
  if (type === 'requireValidation') {
    keys(source, ['type', 'validationCode', 'message'], ['type', 'validationCode', 'message'], path);
    const validationCode = text(source.validationCode, `${path}.validationCode`, 80).toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{2,79}$/.test(validationCode)) throw new Error(`${path}.validationCode is invalid`);
    return { type, validationCode, message: text(source.message, `${path}.message`) };
  }
  if (type === 'excludePackage') {
    keys(source, ['type', 'targetPackageCodes'], ['type', 'targetPackageCodes'], path);
    return { type, targetPackageCodes: codes(source.targetPackageCodes, `${path}.targetPackageCodes`) };
  }
  if (type === 'applyDeduction') {
    keys(source, ['type', 'targetPackageCodes', 'calculation', 'cumulative'], ['type', 'targetPackageCodes', 'calculation'], path);
    const calculation = keys(source.calculation, ['method', 'basis', 'value'], ['method'], `${path}.calculation`);
    const method = text(calculation.method, `${path}.calculation.method`, 40);
    if (!['fixedAmount', 'percentage', 'minimumAmount', 'fullAmount'].includes(method)) throw new Error(`${path}.calculation.method is invalid`);
    const basis = calculation.basis === undefined ? 'claimedAmount' : text(calculation.basis, `${path}.calculation.basis`, 40);
    if (!['claimedAmount', 'currentApprovedAmount'].includes(basis)) throw new Error(`${path}.calculation.basis is invalid`);
    const numericValue = method === 'fullAmount' ? 100 : number(calculation.value, `${path}.calculation.value`, 0, method === 'percentage' ? 100 : Number.MAX_SAFE_INTEGER);
    return {
      type,
      targetPackageCodes: codes(source.targetPackageCodes, `${path}.targetPackageCodes`),
      calculation: { method, basis, value: numericValue },
      cumulative: source.cumulative === true
    };
  }
  keys(source, ['type', 'targetPackageCodes', 'target', 'writeMode', 'template'], ['type', 'target', 'template'], path);
  const target = keys(source.target, ['sheet', 'columnKey'], ['sheet', 'columnKey'], `${path}.target`);
  const sheet = text(target.sheet, `${path}.target.sheet`, 20).toUpperCase();
  const columnKey = text(target.columnKey, `${path}.target.columnKey`, 50);
  const writeMode = source.writeMode === undefined ? 'append' : text(source.writeMode, `${path}.writeMode`, 20);
  if (!AREAS.has(sheet) || sheet === 'ALL') throw new Error(`${path}.target.sheet is invalid`);
  if (!COLUMN_KEYS.has(columnKey)) throw new Error(`${path}.target.columnKey is invalid`);
  if (!['append', 'replace'].includes(writeMode)) throw new Error(`${path}.writeMode is invalid`);
  return {
    type,
    targetPackageCodes: source.targetPackageCodes === undefined ? [] : codes(source.targetPackageCodes, `${path}.targetPackageCodes`),
    target: { sheet, columnKey },
    writeMode,
    template: template(source.template, `${path}.template`)
  };
}

function scenario(value, path) {
  const source = keys(value,
    ['scenarioId', 'name', 'processingArea', 'outcome', 'lines', 'expected'],
    ['scenarioId', 'name', 'processingArea', 'lines', 'expected'], path);
  const scenarioId = text(source.scenarioId, `${path}.scenarioId`, 80).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,79}$/.test(scenarioId)) throw new Error(`${path}.scenarioId is invalid`);
  const processingArea = text(source.processingArea, `${path}.processingArea`, 20).toUpperCase();
  if (!AREAS.has(processingArea) || processingArea === 'ALL') throw new Error(`${path}.processingArea is invalid`);
  if (!Array.isArray(source.lines) || !source.lines.length || source.lines.length > 50) throw new Error(`${path}.lines is invalid`);
  const lines = source.lines.map((line, index) => {
    const linePath = `${path}.lines[${index}]`;
    const item = keys(line, ['packageCodes', 'claimAmount', 'approvedAmount'], ['packageCodes', 'claimAmount'], linePath);
    return {
      index,
      packageCodes: codes(item.packageCodes, `${linePath}.packageCodes`),
      claimAmount: number(item.claimAmount, `${linePath}.claimAmount`),
      approvedAmount: item.approvedAmount === undefined
        ? number(item.claimAmount, `${linePath}.claimAmount`)
        : number(item.approvedAmount, `${linePath}.approvedAmount`)
    };
  });
  const expected = keys(source.expected,
    ['matchedRuleIds', 'blocked', 'approvedAmounts'], ['matchedRuleIds', 'blocked'], `${path}.expected`);
  if (typeof expected.blocked !== 'boolean') throw new Error(`${path}.expected.blocked must be boolean`);
  const matchedRuleIds = codes(expected.matchedRuleIds, `${path}.expected.matchedRuleIds`, 0);
  const approvedAmounts = expected.approvedAmounts === undefined ? {} : object(expected.approvedAmounts, `${path}.expected.approvedAmounts`);
  const normalizedAmounts = {};
  for (const [packageCode, amount] of Object.entries(approvedAmounts)) {
    const normalizedCode = text(packageCode, `${path}.expected.approvedAmounts key`, 80).toUpperCase();
    normalizedAmounts[normalizedCode] = number(amount, `${path}.expected.approvedAmounts.${normalizedCode}`);
  }
  return {
    scenarioId,
    name: text(source.name, `${path}.name`, 160),
    processingArea,
    outcome: source.outcome === undefined ? '' : text(source.outcome, `${path}.outcome`, 40),
    lines,
    expected: { matchedRuleIds, blocked: expected.blocked, approvedAmounts: normalizedAmounts }
  };
}

function normalizeRule(value) {
  const source = keys(value,
    ['ruleId', 'name', 'description', 'schemaVersion', 'processingArea', 'enabled', 'priority', 'enforcement', 'conditions', 'actions', 'scenarios'],
    ['ruleId', 'name', 'processingArea', 'enabled', 'priority', 'enforcement', 'conditions', 'actions'], 'rule');
  const ruleId = text(source.ruleId, 'rule.ruleId', 80).toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{2,79}$/.test(ruleId)) throw new Error('rule.ruleId is invalid');
  const processingArea = text(source.processingArea, 'rule.processingArea', 20).toUpperCase();
  if (!AREAS.has(processingArea)) throw new Error('rule.processingArea is invalid');
  const enforcement = text(source.enforcement, 'rule.enforcement', 30);
  if (!ENFORCEMENT.has(enforcement)) throw new Error('rule.enforcement is invalid');
  if (typeof source.enabled !== 'boolean') throw new Error('rule.enabled must be boolean');
  const priority = number(source.priority, 'rule.priority', 1, 9999);
  if (!Number.isSafeInteger(priority)) throw new Error('rule.priority must be an integer');
  if (!Array.isArray(source.actions) || !source.actions.length || source.actions.length > 20) throw new Error('rule.actions is invalid');
  const actions = source.actions.map((item, index) => action(item, `rule.actions[${index}]`));
  if (source.scenarios !== undefined && (!Array.isArray(source.scenarios) || source.scenarios.length > 20)) {
    throw new Error('rule.scenarios is invalid');
  }
  const scenarios = (source.scenarios || []).map((item, index) => scenario(item, `rule.scenarios[${index}]`));
  if (new Set(scenarios.map(item => item.scenarioId)).size !== scenarios.length) throw new Error('rule.scenarios contains duplicate IDs');
  if (enforcement === 'blocking' && !actions.some(item => item.type === 'blockProcessing')) throw new Error('blocking rule requires blockProcessing');
  if (enforcement === 'manualReview' && !actions.some(item => item.type === 'requireValidation')) throw new Error('manualReview rule requires requireValidation');
  return {
    ruleId,
    name: text(source.name, 'rule.name', 160),
    description: source.description ? text(source.description, 'rule.description', 500) : '',
    schemaVersion: SCHEMA_VERSION,
    processingArea,
    enabled: source.enabled,
    priority,
    enforcement,
    conditions: condition(source.conditions),
    actions,
    scenarios
  };
}

function lineHasCode(line, packageCodes) {
  const available = new Set(line.packageCodes || []);
  return packageCodes.some(code => available.has(code));
}

function relevantLines(context, packageCodes = []) {
  return packageCodes.length ? context.lines.filter(line => lineHasCode(line, packageCodes)) : context.lines;
}

function conditionMatches(item, context) {
  if (item.operator === 'all') return item.conditions.every(child => conditionMatches(child, context));
  if (item.operator === 'any') return item.conditions.some(child => conditionMatches(child, context));
  if (item.operator === 'not') return !conditionMatches(item.condition, context);
  if (item.operator === 'packagePresent' || item.operator === 'packageCodeEquals') return item.packageCodes.some(code => context.packageCodes.has(code));
  if (item.operator === 'packageAbsent') return item.packageCodes.every(code => !context.packageCodes.has(code));
  if (item.operator === 'packageCombinationPresent') return item.packageCodes.every(code => context.packageCodes.has(code));
  if (item.operator === 'packageCombinationAbsent') return !item.packageCodes.every(code => context.packageCodes.has(code));
  if (item.operator === 'processingOutcomeEquals') return context.outcome === item.value;
  const lines = relevantLines(context, item.packageCodes || []);
  if (item.operator === 'claimedAmountGreaterThan') return lines.some(line => line.claimAmount > item.value);
  if (item.operator === 'claimedAmountLessThan') return lines.some(line => line.claimAmount < item.value);
  if (item.operator === 'approvedAmountGreaterThan') return lines.some(line => line.approvedAmount > item.value);
  return lines.some(line => Math.max(0, line.claimAmount - line.approvedAmount) > item.value);
}

function deductionFor(item, line) {
  const base = item.calculation.basis === 'currentApprovedAmount' ? line.approvedAmount : line.claimAmount;
  if (item.calculation.method === 'fullAmount') return item.cumulative ? line.approvedAmount : line.claimAmount;
  if (item.calculation.method === 'percentage') return base * item.calculation.value / 100;
  if (item.calculation.method === 'minimumAmount') {
    const existing = Math.max(0, line.claimAmount - line.approvedAmount);
    return item.cumulative ? Math.max(0, item.calculation.value - existing) : Math.max(existing, item.calculation.value);
  }
  return item.calculation.value;
}

function evaluateRuleSet(rules, scenarioValue) {
  const lines = scenarioValue.lines.map(line => ({ ...line }));
  const context = {
    lines,
    packageCodes: new Set(lines.flatMap(line => line.packageCodes)),
    outcome: scenarioValue.outcome
  };
  const amounts = new Map(lines.map(line => [line.index, line.approvedAmount]));
  const matchedRuleIds = [];
  let blocked = false;
  for (const rule of rules) {
    if (!rule.enabled || !['ALL', scenarioValue.processingArea].includes(rule.processingArea) || !conditionMatches(rule.conditions, context)) continue;
    matchedRuleIds.push(rule.ruleId);
    for (const item of rule.actions) {
      if (item.type === 'blockProcessing' || (item.type === 'requireValidation' && rule.enforcement === 'manualReview')) blocked = true;
      for (const line of relevantLines(context, item.targetPackageCodes || [])) {
        const current = amounts.get(line.index);
        if (item.type === 'excludePackage') amounts.set(line.index, 0);
        if (item.type === 'applyDeduction' && current > 0) {
          const deduction = Math.min(current, Math.max(0, deductionFor(item, { ...line, approvedAmount: current })));
          const next = item.cumulative ? current - deduction : Math.min(current, line.claimAmount - deduction);
          amounts.set(line.index, Math.max(0, Math.round(next * 100) / 100));
        }
      }
    }
    context.outcome = blocked ? 'blocked' : lines.some(line => amounts.get(line.index) < line.claimAmount) ? 'deducted' : 'approved';
  }
  const approvedAmounts = {};
  for (const line of lines) for (const code of line.packageCodes) approvedAmounts[code] = amounts.get(line.index);
  return { matchedRuleIds: [...new Set(matchedRuleIds)], blocked, approvedAmounts };
}

function runScenarios(rules) {
  const results = [];
  for (const ownerRule of rules) {
    for (const item of ownerRule.scenarios || []) {
      const actual = evaluateRuleSet(rules, item);
      const errors = [];
      const actualIds = new Set(actual.matchedRuleIds);
      for (const expectedId of item.expected.matchedRuleIds) if (!actualIds.has(expectedId)) errors.push(`expected rule ${expectedId} to match`);
      if (actual.blocked !== item.expected.blocked) errors.push(`expected blocked=${item.expected.blocked}`);
      for (const [code, amount] of Object.entries(item.expected.approvedAmounts)) {
        if (actual.approvedAmounts[code] !== amount) errors.push(`expected ${code} approved amount ${amount}, received ${actual.approvedAmounts[code]}`);
      }
      results.push({ ruleId: ownerRule.ruleId, scenarioId: item.scenarioId, name: item.name, passed: errors.length === 0, errors, actual });
    }
  }
  return { passed: results.every(item => item.passed), total: results.length, failed: results.filter(item => !item.passed).length, results };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeRuleSet(values) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error('rules is invalid');
  const rules = values.map(normalizeRule).sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.ruleId)) throw new Error(`duplicate ruleId: ${rule.ruleId}`);
    ids.add(rule.ruleId);
  }
  const targets = new Map();
  for (const rule of rules.filter(item => item.enabled && item.enforcement !== 'advisory')) {
    for (const item of rule.actions) {
      let target = '';
      const packages = (item.targetPackageCodes || []).slice().sort().join(',');
      if (item.type === 'writeRemark' && item.writeMode === 'replace') {
        target = `${rule.processingArea}:${item.target.columnKey}:${packages || '*'}`;
      } else if (['applyDeduction', 'excludePackage'].includes(item.type)) {
        target = `${rule.processingArea}:amount:${packages}`;
      }
      if (!target) continue;
      const key = `${rule.priority}:${target}`;
      if (targets.has(key)) throw new Error(`rules ${targets.get(key)} and ${rule.ruleId} have an ambiguous mandatory target`);
      targets.set(key, rule.ruleId);
    }
  }
  const payload = { schemaVersion: SCHEMA_VERSION, rules };
  const serialized = canonicalJson(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 750000) throw new Error('published rule set is too large');
  return { ...payload, checksum: `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}` };
}

module.exports = {
  FEEDBACK_CATEGORIES,
  SCHEMA_VERSION,
  normalizeRule,
  normalizeRuleSet,
  runScenarios
};
