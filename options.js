// Options page: per-rule audit statistics and auto-deduct allowlist promotion.

const Rules = globalThis.RGHSAuditRules;
const AuditCore = globalThis.RGHSAuditCore;
const CustomRules = globalThis.RGHSCustomRules;

const rulesBody = document.getElementById('rulesBody');
const rulesMeta = document.getElementById('rulesMeta');
const otherFamilies = document.getElementById('otherFamilies');
const statusMessage = document.getElementById('statusMessage');
const resetBtn = document.getElementById('resetOverridesBtn');
const customRulesBody = document.getElementById('customRulesBody');
const ruleForm = document.getElementById('ruleEditorForm');
const ruleType = document.getElementById('customRuleType');
const importFile = document.getElementById('importRulesFile');

let ruleOverrides = {};
let latestStatsByRule = new Map();
let customRuleConfig = CustomRules.normalizeConfig(null);
let editingRuleId = null;

function normalizeRuleOverrides(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function showStatus(message) {
  statusMessage.textContent = message;
  setTimeout(() => { statusMessage.textContent = ''; }, 3000);
}

function formatFpRate(stat) {
  if (!stat || stat.falsePositiveRate === null) return '—';
  const pct = Math.round(stat.falsePositiveRate * 100);
  const span = document.createElement('span');
  span.textContent = `${pct}%`;
  span.className = stat.falsePositiveRate > 0.1 ? 'fp-bad' : 'fp-good';
  return span;
}

function render(statsByRule) {
  rulesBody.textContent = '';
  rulesMeta.textContent =
    `Rules version ${Rules.version} - generated from ${Rules.source}. ` +
    `${Rules.bundles.length} bundle rules shown below.`;

  for (const rule of Rules.bundles) {
    const stat = statsByRule.get(rule.ruleId);
    const override = ruleOverrides[rule.ruleId];
    const effective = rule.action === 'deduct-eligible'
      ? (override ? override.autoDeductEligible === true : rule.autoDeductEligible === true)
      : false;

    const row = document.createElement('tr');

    const cells = {
      ruleId: rule.ruleId,
      label: rule.bundle.label,
      category: rule.category,
      risk: rule.risk,
      cls: rule.action === 'deduct-eligible' ? 'deduct-eligible' : 'review-only'
    };
    for (const [key, value] of Object.entries(cells)) {
      const td = document.createElement('td');
      td.textContent = value;
      if (key === 'risk') td.className = `risk-${value}`;
      if (key === 'cls' && value === 'review-only') td.className = 'class-review';
      row.appendChild(td);
    }

    for (const key of ['flagged', 'deducted', 'confirmed', 'dismissed']) {
      const td = document.createElement('td');
      td.className = 'num';
      td.textContent = stat ? String(stat[key]) : '0';
      row.appendChild(td);
    }

    const fpTd = document.createElement('td');
    fpTd.className = 'num';
    fpTd.append(formatFpRate(stat));
    row.appendChild(fpTd);

    const toggleTd = document.createElement('td');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = effective;
    toggle.disabled = rule.action !== 'deduct-eligible';
    toggle.title = toggle.disabled
      ? 'Review-only rule - cannot auto-deduct'
      : 'Allow this rule to auto-deduct (deduct mode only)';
    toggle.addEventListener('change', () => {
      const enabled = toggle.checked;
      chrome.runtime.sendMessage({
        action: 'setRuleOverride',
        ruleId: rule.ruleId,
        autoDeductEligible: enabled
      }, response => {
        if (!response?.success) {
          showStatus(`Unable to update ${rule.ruleId}; reload and try again`);
          load();
          return;
        }
        showStatus(`${rule.ruleId} auto-deduct ${enabled ? 'enabled' : 'disabled'}`);
      });
    });
    toggleTd.appendChild(toggle);
    row.appendChild(toggleTd);

    rulesBody.appendChild(row);
  }

  otherFamilies.textContent =
    `Always review-only (no toggles): ${(Rules.mutuallyExclusive || []).length} mutually-exclusive groups, ` +
    `${(Rules.addOnDependencies || []).length} add-on dependencies, ` +
    `${(Rules.combinedAvailable || []).length} combined-package checks, ` +
    `${(Rules.adjunctClusters || []).length} adjunct clusters, ` +
    `${(Rules.duplicateMMGroups || []).length} duplicate-MM diagnosis groups, ` +
    `plus the exact-duplicate (DUP-CODE) and arithmetic (AMT-CALC) checks.`;
  renderRuleEditor();
}

function value(id) {
  return document.getElementById(id).value;
}

function setValue(id, next) {
  document.getElementById(id).value = next || '';
}

function ruleToForm(rule) {
  editingRuleId = rule?.ruleId || null;
  document.getElementById('ruleFormTitle').textContent = editingRuleId ? `Edit ${rule.ruleId}` : 'Add custom finding';
  setValue('customRuleId', rule?.ruleId);
  document.getElementById('customRuleId').disabled = Boolean(editingRuleId);
  setValue('customRuleType', rule?.type || 'unbundling');
  setValue('customRuleRisk', rule?.risk || 'High');
  document.getElementById('customRuleEnabled').checked = rule?.enabled !== false;
  setValue('customMainLabel', rule?.main?.label);
  setValue('customMainCodes', (rule?.main?.codes || []).join(', '));
  setValue('customMainPatterns', (rule?.main?.patterns || []).join('\n'));
  const component = rule?.components?.[0] || rule?.expected || {};
  setValue('customComponentLabel', component.label);
  setValue('customComponentCodes', (component.codes || []).join(', '));
  setValue('customComponentPatterns', (component.patterns || []).join('\n'));
  setValue('customReason', rule?.reason);
  setValue('customReference', rule?.reference);
  setValue('customHoldRemark', rule?.remarks?.hold);
  setValue('customDeductRemark', rule?.remarks?.deducted);
  updateRuleTypeFields();
}

function renderRuleEditor() {
  const templates = customRuleConfig.remarkTemplates;
  setValue('remarkApproved', templates.approved);
  setValue('remarkDeducted', templates.deducted);
  setValue('remarkRejected', templates.rejected);
  setValue('remarkHold', templates.hold);
  customRulesBody.textContent = '';
  if (customRuleConfig.rules.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-row';
    cell.textContent = 'No custom findings saved.';
    row.appendChild(cell);
    customRulesBody.appendChild(row);
    return;
  }
  for (const rule of customRuleConfig.rules) {
    const row = document.createElement('tr');
    const component = rule.components?.[0] || rule.expected;
    for (const text of [rule.ruleId, rule.type, rule.main.label, component?.label || '—', rule.enabled ? 'Enabled' : 'Disabled']) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.appendChild(cell);
    }
    const actions = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => ruleToForm(rule));
    const duplicate = document.createElement('button');
    duplicate.type = 'button';
    duplicate.textContent = 'Duplicate';
    duplicate.addEventListener('click', () => ruleToForm({ ...rule, ruleId: '' }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => {
      if (!globalThis.confirm(`Delete ${rule.ruleId}?`)) return;
      const next = { ...customRuleConfig, rules: customRuleConfig.rules.filter(item => item.ruleId !== rule.ruleId) };
      saveCustomConfig(next, `${rule.ruleId} deleted`);
    });
    actions.append(edit, duplicate, remove);
    row.appendChild(actions);
    customRulesBody.appendChild(row);
  }
}

function saveCustomConfig(config, successMessage) {
  const normalized = CustomRules.normalizeConfig(config, CustomRules.collectRuleIds(Rules));
  if (normalized.errors.length) {
    showStatus(normalized.errors[0]);
    return;
  }
  chrome.runtime.sendMessage({ action: 'setCustomRuleConfig', config: normalized }, response => {
    if (!response?.success) {
      showStatus('Unable to save custom rules; reload and try again');
      return;
    }
    customRuleConfig = normalized;
    render(latestStatsByRule);
    showStatus(successMessage);
  });
}

function updateRuleTypeFields() {
  const isUnbundling = ruleType.value === 'unbundling';
  for (const id of ['componentLabelWrap', 'componentCodesWrap', 'componentPatternsWrap', 'deductRemarkWrap']) {
    document.getElementById(id).hidden = !isUnbundling;
  }
  document.getElementById('customComponentLabel').required = isUnbundling;
}

function load() {
  chrome.storage.local.get(['rghsAuditLog', 'rghsAuditFeedback', 'ruleOverrides', 'customRuleConfig'], local => {
    ruleOverrides = normalizeRuleOverrides(local.ruleOverrides);
    customRuleConfig = CustomRules.normalizeConfig(local.customRuleConfig, CustomRules.collectRuleIds(Rules));
    const log = Array.isArray(local.rghsAuditLog) ? local.rghsAuditLog : [];
    const feedback = Array.isArray(local.rghsAuditFeedback) ? local.rghsAuditFeedback : [];
    latestStatsByRule = new Map(AuditCore.summarizeAudit(log, feedback).map(stat => [stat.ruleId, stat]));
    render(latestStatsByRule);
  });
}

resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'resetRuleOverrides' }, response => {
    if (!response?.success) {
      showStatus('Unable to reset overrides; reload and try again');
      return;
    }
    showStatus('All overrides reset to the generated defaults');
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.ruleOverrides) ruleOverrides = normalizeRuleOverrides(changes.ruleOverrides.newValue);
  if (changes.customRuleConfig) {
    customRuleConfig = CustomRules.normalizeConfig(changes.customRuleConfig.newValue, CustomRules.collectRuleIds(Rules));
  }
  if (changes.ruleOverrides || changes.customRuleConfig) render(latestStatsByRule);
});

document.getElementById('saveTemplatesBtn').addEventListener('click', () => {
  saveCustomConfig({
    ...customRuleConfig,
    remarkTemplates: {
      approved: value('remarkApproved'),
      deducted: value('remarkDeducted'),
      rejected: value('remarkRejected'),
      hold: value('remarkHold')
    }
  }, 'Remark templates saved');
});

ruleType.addEventListener('change', updateRuleTypeFields);
document.getElementById('cancelRuleEditBtn').addEventListener('click', () => ruleToForm(null));
ruleForm.addEventListener('submit', event => {
  event.preventDefault();
  const type = ruleType.value;
  const candidate = {
    ruleId: value('customRuleId'),
    type,
    risk: value('customRuleRisk'),
    enabled: document.getElementById('customRuleEnabled').checked,
    main: { label: value('customMainLabel'), codes: value('customMainCodes'), patterns: value('customMainPatterns') },
    reason: value('customReason'),
    reference: value('customReference'),
    remarks: { hold: value('customHoldRemark'), deducted: value('customDeductRemark') }
  };
  if (type === 'unbundling') {
    candidate.components = [{
      label: value('customComponentLabel'),
      codes: value('customComponentCodes'),
      patterns: value('customComponentPatterns')
    }];
  }
  const existingIds = [
    ...CustomRules.collectRuleIds(Rules),
    ...customRuleConfig.rules.filter(rule => rule.ruleId !== editingRuleId).map(rule => rule.ruleId)
  ];
  const validation = CustomRules.validateCustomRule(candidate, existingIds);
  if (!validation.ok) {
    showStatus(validation.errors[0]);
    return;
  }
  const rules = editingRuleId
    ? customRuleConfig.rules.map(rule => rule.ruleId === editingRuleId ? validation.rule : rule)
    : [...customRuleConfig.rules, validation.rule];
  saveCustomConfig({ ...customRuleConfig, rules }, `${validation.rule.ruleId} saved`);
  ruleToForm(null);
});

document.getElementById('exportRulesBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(customRuleConfig, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `claim-spark-custom-rules-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importRulesBtn').addEventListener('click', () => importFile.click());
document.getElementById('resetCustomRulesBtn').addEventListener('click', () => {
  if (!globalThis.confirm('Delete every custom finding and restore default remark templates?')) return;
  saveCustomConfig(CustomRules.normalizeConfig(null), 'Custom findings and remark templates reset');
  ruleToForm(null);
});
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const normalized = CustomRules.normalizeConfig(parsed, CustomRules.collectRuleIds(Rules));
    if (normalized.errors.length) throw new Error(normalized.errors[0]);
    if (!globalThis.confirm(`Replace the current configuration with ${normalized.rules.length} imported custom rule(s)?`)) return;
    saveCustomConfig(normalized, `${normalized.rules.length} custom rule(s) imported`);
  } catch (error) {
    showStatus(`Import rejected: ${error.message}`);
  } finally {
    importFile.value = '';
  }
});

ruleToForm(null);

chrome.runtime.sendMessage({ action: 'ensureRuleOverridesMigration' }, () => {
  void chrome.runtime.lastError;
  load();
});
