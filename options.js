// Options page: per-rule audit statistics and auto-deduct allowlist promotion.

const Rules = globalThis.RGHSAuditRules;
const AuditCore = globalThis.RGHSAuditCore;

const rulesBody = document.getElementById('rulesBody');
const rulesMeta = document.getElementById('rulesMeta');
const otherFamilies = document.getElementById('otherFamilies');
const statusMessage = document.getElementById('statusMessage');
const resetBtn = document.getElementById('resetOverridesBtn');

let ruleOverrides = {};
let latestStatsByRule = new Map();

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
}

function load() {
  chrome.storage.local.get(['rghsAuditLog', 'rghsAuditFeedback', 'ruleOverrides'], local => {
    ruleOverrides = normalizeRuleOverrides(local.ruleOverrides);
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
  if (areaName !== 'local' || !changes.ruleOverrides) return;
  ruleOverrides = normalizeRuleOverrides(changes.ruleOverrides.newValue);
  render(latestStatsByRule);
});

chrome.runtime.sendMessage({ action: 'ensureRuleOverridesMigration' }, () => {
  void chrome.runtime.lastError;
  load();
});
