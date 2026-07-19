// Options page: per-rule audit statistics and auto-deduct allowlist promotion.

const Rules = globalThis.RGHSAuditRules;
const AuditCore = globalThis.RGHSAuditCore;

const rulesBody = document.getElementById('rulesBody');
const rulesMeta = document.getElementById('rulesMeta');
const otherFamilies = document.getElementById('otherFamilies');
const statusMessage = document.getElementById('statusMessage');
const resetBtn = document.getElementById('resetOverridesBtn');

let ruleOverrides = {};

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
      ruleOverrides[rule.ruleId] = { autoDeductEligible: toggle.checked };
      chrome.storage.sync.set({ ruleOverrides }, () => {
        showStatus(`${rule.ruleId} auto-deduct ${toggle.checked ? 'enabled' : 'disabled'}`);
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
  chrome.storage.local.get(['rghsAuditLog', 'rghsAuditFeedback'], local => {
    chrome.storage.sync.get(['ruleOverrides'], sync => {
      ruleOverrides = sync.ruleOverrides && typeof sync.ruleOverrides === 'object' ? sync.ruleOverrides : {};
      const log = Array.isArray(local.rghsAuditLog) ? local.rghsAuditLog : [];
      const feedback = Array.isArray(local.rghsAuditFeedback) ? local.rghsAuditFeedback : [];
      const statsByRule = new Map(AuditCore.summarizeAudit(log, feedback).map(stat => [stat.ruleId, stat]));
      render(statsByRule);
    });
  });
}

resetBtn.addEventListener('click', () => {
  ruleOverrides = {};
  chrome.storage.sync.set({ ruleOverrides }, () => {
    showStatus('All overrides reset to the generated defaults');
    load();
  });
});

load();
