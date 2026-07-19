(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RGHSCustomRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DEFAULT_REMARK_TEMPLATES = Object.freeze({
    approved: '',
    deducted: '',
    rejected: 'Not admissible under the applicable package terms. Verify supporting documents.',
    hold: ''
  });
  const ALLOWED_TYPES = new Set(['unbundling', 'upcoding']);
  const RESERVED_RULE_IDS = ['DUP-CODE', 'AMT-CALC', 'MM-DUP', 'MULTI-MAJOR'];
  const ALLOWED_TEMPLATE_KEYS = new Set(['approved', 'deducted', 'rejected', 'hold']);
  const ALLOWED_TOKENS = new Set([
    'rule_id', 'main_code', 'main_package', 'component_code', 'component',
    'claimed_amount', 'approved_amount', 'deduction', 'reference', 'reason'
  ]);

  function cleanText(value, maxLength = 500) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function splitList(value) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
    return [...new Set(source.map(item => cleanText(item, 160)).filter(Boolean))];
  }

  function splitPatterns(value) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
    return [...new Set(source.map(item => String(item ?? '').trim().slice(0, 200)).filter(Boolean))];
  }

  function validatePatterns(patterns, errors, field) {
    for (const pattern of patterns) {
      if (pattern.length > 200) errors.push(`${field} pattern is too long`);
      if (/\\[1-9]|\.\*.*\.\*|\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
        errors.push(`${field} contains a potentially unsafe regular expression: ${pattern}`);
      }
      try { new RegExp(pattern, 'i'); } catch { errors.push(`${field} contains an invalid regular expression: ${pattern}`); }
    }
  }

  function validateTemplates(templates, errors) {
    if (!templates || typeof templates !== 'object' || Array.isArray(templates)) return;
    for (const [key, value] of Object.entries(templates)) {
      if (!ALLOWED_TEMPLATE_KEYS.has(key)) errors.push(`unknown remark template: ${key}`);
      if (String(value).length > 1000) errors.push(`${key} remark is too long`);
      for (const match of String(value).matchAll(/\{([^{}]+)\}/g)) {
        if (!ALLOWED_TOKENS.has(match[1])) errors.push(`${key} remark uses unknown token {${match[1]}}`);
      }
    }
  }

  function normalizeEntity(value, fallbackLabel = '') {
    const entity = value && typeof value === 'object' ? value : {};
    return {
      label: cleanText(entity.label || fallbackLabel, 160),
      codes: splitList(entity.codes).map(code => code.toUpperCase()),
      patterns: splitPatterns(entity.patterns)
    };
  }

  function validateCustomRule(value, existingIds = []) {
    const errors = [];
    const source = value && typeof value === 'object' ? value : {};
    const ruleId = cleanText(source.ruleId, 50).toUpperCase();
    const type = cleanText(source.type, 30).toLowerCase();
    if (!/^[A-Z][A-Z0-9_-]{2,49}$/.test(ruleId)) errors.push('ruleId must be 3-50 uppercase letters, numbers, _ or -');
    if (new Set(existingIds.map(id => String(id).toUpperCase())).has(ruleId)) errors.push(`duplicate ruleId: ${ruleId}`);
    if (!ALLOWED_TYPES.has(type)) errors.push('type must be unbundling or upcoding');

    const main = normalizeEntity(source.main || source.reported, '');
    if (!main.label) errors.push('main/reported package label is required');
    if (main.codes.length === 0 && main.patterns.length === 0) errors.push('main/reported package needs at least one code or pattern');
    validatePatterns(main.patterns, errors, 'main');

    const componentSource = type === 'upcoding' ? (source.expected || source.components?.[0]) : source.components?.[0];
    const component = normalizeEntity(componentSource, '');
    if (type === 'unbundling') {
      if (!component.label) errors.push('included component label is required');
      if (component.codes.length === 0 && component.patterns.length === 0) errors.push('included component needs at least one code or pattern');
      validatePatterns(component.patterns, errors, 'component');
    }
    const remarks = {};
    for (const key of ALLOWED_TEMPLATE_KEYS) {
      if (source.remarks && Object.prototype.hasOwnProperty.call(source.remarks, key)) remarks[key] = cleanText(source.remarks[key], 1000);
    }
    validateTemplates(remarks, errors);
    if (!cleanText(source.reason || source.remarkReason, 500)) errors.push('finding reason is required');

    const normalized = {
      ruleId,
      type,
      enabled: source.enabled !== false,
      risk: ['Low', 'Medium', 'High'].includes(source.risk) ? source.risk : 'High',
      main,
      reason: cleanText(source.reason || source.remarkReason, 500),
      reference: cleanText(source.reference, 500),
      remarks
    };
    if (type === 'unbundling') normalized.components = [component];
    if (type === 'upcoding') normalized.expected = component;
    return { ok: errors.length === 0, errors, rule: normalized };
  }

  function normalizeConfig(value, builtInIds = []) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const errors = [];
    if (source.schemaVersion !== undefined && source.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`schemaVersion must equal ${SCHEMA_VERSION}`);
    }
    const rules = [];
    const seen = [...builtInIds];
    for (const candidate of Array.isArray(source.rules) ? source.rules : []) {
      const result = validateCustomRule(candidate, seen);
      if (!result.ok) {
        errors.push(...result.errors.map(error => `${cleanText(candidate?.ruleId) || 'custom rule'}: ${error}`));
        continue;
      }
      rules.push(result.rule);
      seen.push(result.rule.ruleId);
    }
    const templates = { ...DEFAULT_REMARK_TEMPLATES };
    if (source.remarkTemplates && typeof source.remarkTemplates === 'object' && !Array.isArray(source.remarkTemplates)) {
      validateTemplates(source.remarkTemplates, errors);
      for (const key of ALLOWED_TEMPLATE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source.remarkTemplates, key)) templates[key] = cleanText(source.remarkTemplates[key], 1000);
      }
    }
    return { schemaVersion: SCHEMA_VERSION, rules, remarkTemplates: templates, errors };
  }

  function mergeRuleSet(builtIn, config) {
    const normalized = normalizeConfig(config, collectRuleIds(builtIn));
    const bundles = [...(builtIn.bundles || [])];
    const reviewTriggers = [...(builtIn.reviewTriggers || [])];
    for (const rule of normalized.rules.filter(item => item.enabled)) {
      if (rule.type === 'unbundling') {
        bundles.push({
          ruleId: rule.ruleId, category: 'Custom unbundling', risk: rule.risk,
          action: 'review-only', autoDeductEligible: false, bundle: rule.main,
          components: rule.components, remarkReason: rule.reason || 'Possible unbundling identified',
          reference: rule.reference, remarkTemplates: rule.remarks
        });
      } else {
        reviewTriggers.push({
          ruleId: rule.ruleId, category: 'Custom upcoding review', risk: rule.risk,
          label: rule.main.label, entity: rule.main,
          reason: rule.reason || 'Selected package requires documentation review',
          reference: rule.reference, remarkTemplates: rule.remarks
        });
      }
    }
    return { ...builtIn, bundles, reviewTriggers, remarkTemplates: normalized.remarkTemplates };
  }

  function collectRuleIds(rules) {
    const ids = [...RESERVED_RULE_IDS];
    for (const key of ['bundles', 'mutuallyExclusive', 'addOnDependencies', 'combinedAvailable', 'adjunctClusters', 'reviewTriggers']) {
      for (const rule of rules?.[key] || []) if (rule?.ruleId) ids.push(rule.ruleId);
    }
    return ids;
  }

  function formatTemplate(template, values = {}) {
    return String(template ?? '').replace(/\{([^{}]+)\}/g, (match, key) =>
      ALLOWED_TOKENS.has(key) ? cleanText(values[key], 500) : match).replace(/\s+/g, ' ').trim();
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_REMARK_TEMPLATES,
    collectRuleIds,
    formatTemplate,
    mergeRuleSet,
    normalizeConfig,
    validateCustomRule
  };
});
