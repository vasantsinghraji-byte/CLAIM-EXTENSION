// Read-only processor view of audit statistics and centrally governed rules.

const Rules = globalThis.RGHSAuditRules;
const AuditCore = globalThis.RGHSAuditCore;
const rulesBody = document.getElementById('rulesBody');
const rulesMeta = document.getElementById('rulesMeta');
const otherFamilies = document.getElementById('otherFamilies');

function formatFpRate(stat) {
  if (!stat || stat.falsePositiveRate === null) return '—';
  const pct = Math.round(stat.falsePositiveRate * 100);
  const span = document.createElement('span');
  span.textContent = `${pct}%`;
  span.className = stat.falsePositiveRate > 0.1 ? 'fp-bad' : 'fp-good';
  return span;
}

function listBuiltInRules() {
  return ['bundles', 'mutuallyExclusive', 'addOnDependencies', 'combinedAvailable', 'adjunctClusters', 'reviewTriggers']
    .flatMap(collection => (Rules[collection] || []).map(rule => ({ ...rule, collection })));
}

function builtInRuleLabel(rule) {
  return rule.bundle?.label || rule.label || rule.entity?.label || rule.addOn?.label ||
    rule.combined?.label || rule.members?.map(member => member.label).filter(Boolean).join(' + ') || rule.ruleId;
}

function render(statsByRule, processingRuleSet) {
  rulesBody.textContent = '';
  const centralVersion = processingRuleSet?.versionId
    ? ` Central version ${processingRuleSet.versionId} is ${processingRuleSet.mode}.`
    : ' No central version has been cached in this profile.';
  rulesMeta.textContent =
    `Bundled safety rules ${Rules.version} from ${Rules.source}.${centralVersion} ` +
    'All processing behavior is read-only for processors.';

  for (const rule of listBuiltInRules()) {
    const stat = statsByRule.get(rule.ruleId);
    const row = document.createElement('tr');
    const cells = {
      ruleId: rule.ruleId,
      label: builtInRuleLabel(rule),
      category: rule.category || rule.collection,
      risk: rule.risk,
      cls: rule.action === 'deduct-eligible' ? 'deduct-eligible' : 'review-only'
    };
    for (const [key, value] of Object.entries(cells)) {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (key === 'risk') cell.className = `risk-${value}`;
      if (key === 'cls' && value === 'review-only') cell.className = 'class-review';
      row.appendChild(cell);
    }
    for (const key of ['flagged', 'deducted', 'confirmed', 'dismissed']) {
      const cell = document.createElement('td');
      cell.className = 'num';
      cell.textContent = stat ? String(stat[key]) : '0';
      row.appendChild(cell);
    }
    const falsePositiveCell = document.createElement('td');
    falsePositiveCell.className = 'num';
    falsePositiveCell.append(formatFpRate(stat));
    row.appendChild(falsePositiveCell);
    for (const label of ['Managed centrally', 'Managed centrally']) {
      const cell = document.createElement('td');
      cell.textContent = label;
      cell.title = 'Managed centrally by an authorized administrator';
      row.appendChild(cell);
    }
    rulesBody.appendChild(row);
  }

  otherFamilies.textContent =
    `Bundled safety baseline: ${(Rules.mutuallyExclusive || []).length} mutually-exclusive groups, ` +
    `${(Rules.addOnDependencies || []).length} add-on dependencies, ` +
    `${(Rules.combinedAvailable || []).length} combined-package checks, ` +
    `${(Rules.adjunctClusters || []).length} adjunct clusters, and ` +
    `${(Rules.duplicateMMGroups || []).length} duplicate-MM diagnosis groups.`;
}

function load() {
  chrome.storage.local.get(['rghsAuditLog', 'rghsAuditFeedback', 'processingRuleSet'], local => {
    const log = Array.isArray(local.rghsAuditLog) ? local.rghsAuditLog : [];
    const feedback = Array.isArray(local.rghsAuditFeedback) ? local.rghsAuditFeedback : [];
    const stats = new Map(AuditCore.summarizeAudit(log, feedback).map(stat => [stat.ruleId, stat]));
    render(stats, local.processingRuleSet || null);
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.rghsAuditLog || changes.rghsAuditFeedback || changes.processingRuleSet) load();
});

load();
