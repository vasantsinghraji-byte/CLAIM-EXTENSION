// Content script for auto-filling approved amounts with claim amounts

const AUDIT_MODES = ['off', 'flag', 'deduct'];

let isAutoFillEnabled = true;
let auditMode = 'flag';
let ruleOverrides = {};
let undoBatch = [];
let lastPreview = null;
let previewRowElements = new Map();
let lastAppliedSummary = null;
let submitArmedUntil = 0;
const Core = globalThis.ClaimAutoFillCore;
const Audit = globalThis.RGHSAuditCore;
const AuditRules = globalThis.RGHSAuditRules;
const Review = globalThis.ClaimReviewCore;
const ruleSetValidation = Audit && AuditRules && Audit.validateRuleSet
  ? Audit.validateRuleSet(AuditRules)
  : { ok: false, errors: ['Audit rule engine is unavailable'] };
const APPLIED_SESSION_KEY = 'claimExtensionAppliedSummary';
const DEBUG = globalThis.CLAIM_EXTENSION_DEBUG === true;
let lastAuditBadgeCount = null;

function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

// Load settings from storage
chrome.storage.sync.get(['autoFillEnabled', 'auditMode'], (result) => {
  isAutoFillEnabled = result.autoFillEnabled !== false;
  auditMode = AUDIT_MODES.includes(result.auditMode) ? result.auditMode : 'flag';
  window.dispatchEvent(new CustomEvent('claim-autofill:enabled-change', {
    detail: { enabled: isAutoFillEnabled }
  }));
  schedulePassiveAudit([document]);
});

chrome.runtime.sendMessage({ action: 'ensureRuleOverridesMigration' }, () => {
  void chrome.runtime.lastError;
  chrome.storage.local.get(['ruleOverrides'], result => {
    ruleOverrides = result.ruleOverrides && typeof result.ruleOverrides === 'object' && !Array.isArray(result.ruleOverrides)
      ? result.ruleOverrides
      : {};
    schedulePassiveAudit([document]);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ruleOverrides) {
    ruleOverrides = changes.ruleOverrides.newValue && typeof changes.ruleOverrides.newValue === 'object'
      && !Array.isArray(changes.ruleOverrides.newValue)
      ? changes.ruleOverrides.newValue
      : {};
    schedulePassiveAudit([document]);
    return;
  }
  if (area !== 'sync') return;

  if (changes.auditMode) {
    auditMode = AUDIT_MODES.includes(changes.auditMode.newValue) ? changes.auditMode.newValue : 'flag';
    schedulePassiveAudit([document]);
  }

  if (changes.autoFillEnabled) {
    const enabled = changes.autoFillEnabled.newValue !== false;
    if (enabled === isAutoFillEnabled) return;
    isAutoFillEnabled = enabled;
    window.dispatchEvent(new CustomEvent('claim-autofill:enabled-change', {
      detail: { enabled: isAutoFillEnabled }
    }));
    schedulePassiveAudit([document]);
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleAutoFill') {
    isAutoFillEnabled = request.enabled;
    window.dispatchEvent(new CustomEvent('claim-autofill:enabled-change', {
      detail: { enabled: isAutoFillEnabled }
    }));
    schedulePassiveAudit([document]);
    sendResponse({ success: true });
  } else if (request.action === 'fillNow') {
    const result = applyReviewedPreview(request);
    sendResponse({ success: true, ...result });
  } else if (request.action === 'preview') {
    const result = createReviewedPreview();
    sendResponse({ success: true, ...result, hasUndo: undoBatch.length > 0 });
  } else if (request.action === 'undo') {
    const count = undoLastFill();
    if (count > 0) {
      sendResponse({ success: true, count });
    } else {
      restorePersistentSnapshot().then(result => sendResponse({ success: true, ...result }));
    }
  } else if (request.action === 'getStatus') {
    hasPersistentRecovery(hasRecovery => {
      sendResponse({ enabled: isAutoFillEnabled, auditMode, hasUndo: undoBatch.length > 0, hasRecovery });
    });
  }
  return true;
});

// Helper to find any editable element inside a cell
function findEditableElement(cell) {
  if (!cell) return null;

  const input = cell.querySelector('input[type="text"], input[type="number"], input:not([type])');
  if (input) return input;

  const textarea = cell.querySelector('textarea');
  if (textarea) return textarea;

  const select = cell.querySelector('select');
  if (select) return select;

  const editable = cell.querySelector('[contenteditable="true"], [contenteditable=""]');
  if (editable) return editable;

  const anyInput = cell.querySelector('input');
  if (anyInput) return anyInput;

  const ngModel = cell.querySelector('[ng-model], [ng-bind], [formcontrolname], [data-bind]');
  if (ngModel) return ngModel;

  return null;
}

// Helper to get value from any element (input or plain cell)
function getElementValue(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    return el.value || '';
  }
  if (el.hasAttribute && el.hasAttribute('contenteditable')) {
    return el.textContent.trim();
  }
  return el.value || el.textContent.trim();
}

// Helper to set value on any element
function setElementValue(el, value) {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
  } else if (el.tagName === 'SELECT') {
    el.value = value;
  } else {
    el.textContent = value;
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Set value on a cell or its editable child
function setCellValue(cell, value, batch) {
  const editableEl = findEditableElement(cell);
  if (editableEl) {
    batch.push({ element: editableEl, value: getElementValue(editableEl) });
    setElementValue(editableEl, value);
  } else {
    batch.push({ element: cell, value: cell.textContent });
    cell.textContent = value;
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Get value from a cell or its editable child
function getCellValue(cell) {
  const editableEl = findEditableElement(cell);
  return editableEl ? getElementValue(editableEl).trim() : cell.textContent.trim();
}

// Check if a particular text matches medicine categories
function collectTables(roots) {
  const tables = new Set();
  for (const root of roots) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE && root !== document) continue;
    if (root.matches && root.matches('table')) tables.add(root);
    const parentTable = root.closest && root.closest('table');
    if (parentTable) tables.add(parentTable);
    if (root.querySelectorAll) root.querySelectorAll('table').forEach(table => tables.add(table));
  }
  return [...tables].filter(table => {
    const parentTable = table.parentElement?.closest?.('table');
    return !parentTable || !tables.has(parentTable);
  });
}

function getDirectTableRows(table) {
  return [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr')];
}

function getDirectRowCells(row) {
  return [...row.querySelectorAll(':scope > th, :scope > td')];
}

function collectInputs(roots) {
  const selector = 'input[type="text"], input[type="number"], input:not([type]), textarea';
  const inputs = new Set();
  for (const root of roots) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE && root !== document) continue;
    const scope = root === document ? document : root.closest('tr, div, form, fieldset') || root;
    if (scope.matches && scope.matches(selector)) inputs.add(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(selector).forEach(input => inputs.add(input));
  }
  return [...inputs];
}

function inspectPortalLayout() {
  const tables = [...document.querySelectorAll('table')].map(table => {
    const rows = [...table.querySelectorAll('tr')];
    let header = null;
    let indices = null;
    for (const row of rows) {
      const labels = [...row.querySelectorAll('th, td')].map(cell => cell.textContent.toLowerCase().trim());
      const candidate = {
        particular: labels.findIndex(text => text === 'particular' || text === 'particulars'),
        claim: labels.findIndex(text => text.includes('claim') && (text.includes('amount') || text.includes('amt'))),
        approved: labels.findIndex(text => (text.includes('approved') || text.includes('sanctioned')) && (text.includes('amount') || text.includes('amt'))),
        remarks: labels.findIndex(text => text === 'remarks' || text === 'remark')
      };
      if (candidate.claim >= 0 && candidate.approved >= 0) {
        header = row;
        indices = candidate;
        break;
      }
    }

    const controls = [...table.querySelectorAll('[name="packageFinalAmounts"], [id^="packageFinalAmount_"]')];
    let mappedApprovedControls = 0;
    let invalidMappings = 0;
    if (header && indices) {
      const headerCellCount = header.querySelectorAll('th, td').length;
      for (const control of controls) {
        const row = control.closest('tr');
        const cells = row ? [...row.querySelectorAll('td, th')] : [];
        const approvedControlIdx = cells.findIndex(cell => cell.contains(control));
        const resolved = Core.resolveRowColumnIndices({
          cellCount: cells.length,
          headerCellCount,
          particularIdx: indices.particular,
          claimIdx: indices.claim,
          approvedIdx: indices.approved,
          remarksIdx: indices.remarks,
          approvedControlIdx
        });
        if (row && approvedControlIdx >= 0 && resolved.claimIdx >= 0 && resolved.claimIdx < cells.length) mappedApprovedControls++;
        else invalidMappings++;
      }
    }

    return {
      hasRequiredHeaders: Boolean(header && indices && indices.particular >= 0 && indices.claim >= 0 && indices.approved >= 0 && indices.remarks >= 0),
      dataRows: controls.length,
      approvedControls: controls.length,
      mappedApprovedControls,
      invalidMappings
    };
  });
  return Core.validatePortalLayoutDescriptor({ pathname: location.pathname, tables });
}

function blockedFillResult(reason, details = []) {
  return {
    blocked: true,
    blockReason: reason,
    blockDetails: details,
    count: 0,
    changedFieldCount: 0,
    approvedCount: 0,
    remarksCount: 0,
    auditFlagged: 0,
    auditDeducted: 0,
    proposals: [],
    rowElements: new Map()
  };
}

// Fill all approved amounts on the page
function fillAllApprovedAmounts({ apply = true, roots = [document], selectedRowKeys = null, approvedOverrides = {} } = {}) {
  if (!isAutoFillEnabled && apply) {
    return blockedFillResult('autofill-disabled');
  }

  if (location.pathname.startsWith('/RGHS/processSheetSearch/')) {
    const layout = inspectPortalLayout();
    if (!layout.ok) return blockedFillResult('unsupported-layout', [layout.reason]);
    if (!ruleSetValidation.ok) return blockedFillResult('invalid-rule-set', ruleSetValidation.errors);
  }

  debugLog('[Claim Auto-Fill] Starting auto-fill process...');

  let approvedCount = 0;
  let remarksCount = 0;
  let auditFlagged = 0;
  let auditDeducted = 0;
  const auditLogEntries = [];
  const batch = [];
  const proposals = [];
  const rowElements = new Map();
  const tables = collectTables(roots);
  debugLog(`[Claim Auto-Fill] Found ${tables.length} tables on page`);

  tables.forEach((table, tableIndex) => {
    const allRows = getDirectTableRows(table);
    let headerRow = null;
    let headerCellCount = 0;
    let particularIdx = -1;
    let packageIdx = -1;
    let rateIdx = -1;
    let unitIdx = -1;
    let dateIdx = -1;
    let claimIdx = -1;
    let approvedIdx = -1;
    let remarksIdx = -1;

    // Find header row
    for (const row of allRows) {
      const cells = getDirectRowCells(row);
      for (let i = 0; i < cells.length; i++) {
        const text = cells[i].textContent.toLowerCase().trim();

        if (text === 'particular' || text === 'particulars') {
          particularIdx = i;
        }
        if (text.includes('package') && (text.includes('code') || text.includes('name'))) {
          packageIdx = i;
        }
        if (text === 'rate' || text.startsWith('rate ')) {
          rateIdx = i;
        }
        if (text.includes('unit') || text.includes('hours') || text.includes('days')) {
          unitIdx = i;
        }
        if (text.includes('date') && !text.includes('update')) {
          dateIdx = i;
        }
        if ((text.includes('claim') && text.includes('amount')) || text.match(/claim.*amt/i)) {
          claimIdx = i;
        }
        if ((text.includes('approved') && text.includes('amount')) ||
            text.match(/approved.*amt/i) ||
            (text.includes('sanctioned') && text.includes('amount'))) {
          approvedIdx = i;
        }
        if (text === 'remarks' || text === 'remark') {
          remarksIdx = i;
        }
      }

      if (claimIdx !== -1 && approvedIdx !== -1) {
        headerRow = row;
        headerCellCount = cells.length;
        debugLog(`[Claim Auto-Fill] Header found: Particular@${particularIdx}, Package@${packageIdx}, Claim@${claimIdx}, Approved@${approvedIdx}, Remarks@${remarksIdx} (${headerCellCount} cells)`);
        break;
      } else {
        particularIdx = -1;
        packageIdx = -1;
        rateIdx = -1;
        unitIdx = -1;
        dateIdx = -1;
        claimIdx = -1;
        approvedIdx = -1;
        remarksIdx = -1;
      }
    }

    if (!headerRow) return;

    // First pass: collect data rows after the header into records
    const records = [];
    let foundHeader = false;
    let dataRowNum = 0;

    for (const row of allRows) {
      if (!foundHeader) {
        if (row === headerRow) foundHeader = true;
        continue;
      }

      const cells = getDirectRowCells(row);
      dataRowNum++;

      const approvedControl = row.querySelector('[name="packageFinalAmounts"], [id^="packageFinalAmount_"]');
      const remarksControl = row.querySelector('[id^="packageremarks_"]');
      const approvedControlIdx = approvedControl ? [...cells].findIndex(cell => cell.contains(approvedControl)) : -1;
      const remarksControlIdx = remarksControl ? [...cells].findIndex(cell => cell.contains(remarksControl)) : -1;
      const resolved = Core.resolveRowColumnIndices({
        cellCount: cells.length,
        headerCellCount,
        particularIdx,
        claimIdx,
        approvedIdx,
        remarksIdx,
        approvedControlIdx,
        remarksControlIdx
      });
      const adjClaimIdx = resolved.claimIdx;
      const adjApprovedIdx = resolved.approvedIdx;
      const adjParticularIdx = resolved.particularIdx;
      const adjRemarksIdx = resolved.remarksIdx;
      const offset = adjClaimIdx - claimIdx;
      const adjPackageIdx = packageIdx !== -1 ? packageIdx + offset : -1;
      const adjRateIdx = rateIdx !== -1 ? rateIdx + offset : -1;
      const adjUnitIdx = unitIdx !== -1 ? unitIdx + offset : -1;
      const adjDateIdx = dateIdx !== -1 ? dateIdx + offset : -1;

      if (cells.length <= Math.max(adjClaimIdx, adjApprovedIdx)) continue;

      const claimCell = cells[adjClaimIdx];
      const approvedCell = cells[adjApprovedIdx];
      if (!claimCell || !approvedCell) continue;

      const particularText = adjParticularIdx !== -1 && adjParticularIdx < cells.length
        ? cells[adjParticularIdx].textContent
        : '';
      const packageText = adjPackageIdx !== -1 && adjPackageIdx < cells.length
        ? cells[adjPackageIdx].textContent
        : '';
      const rateValue = adjRateIdx !== -1 && adjRateIdx < cells.length ? getCellValue(cells[adjRateIdx]) : '';
      const unitValue = adjUnitIdx !== -1 && adjUnitIdx < cells.length ? getCellValue(cells[adjUnitIdx]) : '';
      const dateValue = adjDateIdx !== -1 && adjDateIdx < cells.length ? getCellValue(cells[adjDateIdx]) : '';
      const remarksCell = adjRemarksIdx !== -1 && adjRemarksIdx < cells.length ? cells[adjRemarksIdx] : null;

      records.push({
        rowEl: row,
        index: dataRowNum,
        claimCell,
        approvedCell,
        remarksCell,
        claimValue: getCellValue(claimCell),
        approvedValue: getCellValue(approvedCell),
        particularText,
        packageText,
        rateValue,
        unitValue,
        dateValue,
        remarksValue: remarksCell ? getCellValue(remarksCell) : ''
      });
    }

    // Second pass: audit for unbundling/duplicates before any auto-fill
    const auditedRows = new Set();
    if (Audit && AuditRules && auditMode !== 'off' && records.length > 0) {
      const lines = records.map(record => ({
        index: record.index,
        particularText: record.particularText,
        packageText: record.packageText,
        claimValue: record.claimValue,
        approvedValue: record.approvedValue,
        remarksValue: record.remarksValue,
        rateValue: record.rateValue,
        unitValue: record.unitValue,
        dateValue: record.dateValue
      }));
      const effectiveRules = Audit.applyRuleOverrides(AuditRules, ruleOverrides);
      const findings = Audit.analyzeClaim(lines, effectiveRules);
      const { rowActions } = Audit.planAuditActions(findings, lines, {
        mode: auditMode,
        settings: effectiveRules.settings
      });

      const actionsByRow = new Map();
      for (const action of rowActions) {
        if (!actionsByRow.has(action.rowIndex)) actionsByRow.set(action.rowIndex, []);
        actionsByRow.get(action.rowIndex).push(action);
      }

      const context = { url: location.href, tid: findTid(), mode: auditMode };
      for (const [rowIndex, actions] of actionsByRow) {
        const record = records.find(r => r.index === rowIndex);
        if (!record) continue;
        auditedRows.add(rowIndex);

        const deductAction = actions.find(action => action.setApproved !== null);
        const reviewedApproval = deductAction ? null : Core.planRowUpdate({
          claimValue: record.claimValue,
          approvedValue: record.approvedValue,
          particularText: record.particularText,
          remarksValue: record.remarksValue
        }).approvedValue;
        const key = `table-${tableIndex}-row-${record.index}`;
        const primaryFinding = actions[0]?.finding;
        const isMain = actions.some(action => action.finding?.bundleRow?.index === record.index);
        const isPrimary = actions.some(action => action.finding?.firstRow?.index === record.index);
        const isComponent = actions.some(action =>
          action.finding?.componentRow?.index === record.index ||
          action.finding?.components?.some(component => component.index === record.index) ||
          action.finding?.duplicateRows?.some(row => row.index === record.index));
        let recommendedApproved = null;
        if (primaryFinding?.type === 'UNBUNDLING_FIXED') {
          recommendedApproved = isMain
            ? Math.max(0, (Core.parseAmount(record.claimValue) || 0) - primaryFinding.fixedDeduction.amount)
            : Core.parseAmount(record.claimValue) || 0;
        } else if (primaryFinding?.type === 'UNBUNDLING') {
          recommendedApproved = isMain ? Core.parseAmount(record.claimValue) || 0 : 0;
        } else if (primaryFinding?.type === 'DUPLICATE') {
          recommendedApproved = isPrimary ? Core.parseAmount(record.claimValue) || 0 : 0;
        }
        const decisionRole = isMain ? 'main' : isPrimary ? 'primary' : isComponent ? 'component' : 'member';
        const decisionMethod = primaryFinding?.type === 'UNBUNDLING_FIXED'
          ? 'fixed-main-adjustment'
          : primaryFinding?.type === 'UNBUNDLING'
            ? 'inclusive-components'
            : primaryFinding?.type === 'DUPLICATE'
              ? 'duplicate-after-first'
              : null;
        const displayRemarkTexts = [...new Set(actions.map(action => action.remark))];
        const remarkTexts = [...new Set(actions
          .filter(action => action.appendRemark !== false)
          .map(action => action.remark))];
        const existing = record.remarksValue ? `${record.remarksValue}; ` : '';
        proposals.push({
          key,
          tableIndex,
          rowIndex: record.index,
          label: record.particularText.trim() || record.packageText.trim() || `Row ${record.index}`,
          packageText: record.packageText.trim(),
          claimAmount: Core.parseAmount(record.claimValue) || 0,
          beforeApproved: Core.parseAmount(record.approvedValue) || 0,
          proposedApproved: deductAction
            ? Number(deductAction.setApproved)
            : reviewedApproval === null ? null : Core.parseAmount(reviewedApproval),
          beforeRemarks: record.remarksValue,
          proposedRemarks: remarkTexts.length ? existing + remarkTexts.join('; ') : null,
          risk: 'high',
          reason: actions.map(action => `${action.ruleId}: ${action.remark}`).join(' | '),
          ruleIds: [...new Set(actions.map(action => action.ruleId))],
          groupId: actions[0]?.ruleId || key,
          decisionRole,
          decisionMethod,
          recommendedApproved,
          recommendedDeductionCap: primaryFinding?.type === 'UNBUNDLING_FIXED'
            ? Number(primaryFinding.fixedDeduction.amount)
            : null
        });
        rowElements.set(key, record.rowEl);
        if (apply && selectedRowKeys && !selectedRowKeys.has(key)) continue;

        const hasApprovedOverride = Object.prototype.hasOwnProperty.call(approvedOverrides, key);
        if (deductAction && !hasApprovedOverride) {
          if (apply) setCellValue(record.approvedCell, deductAction.setApproved, batch);
          auditDeducted++;
        } else {
          const approvedOverride = hasApprovedOverride
            ? String(approvedOverrides[key])
            : reviewedApproval;
          if (approvedOverride !== null && apply) {
            setCellValue(record.approvedCell, approvedOverride, batch);
            approvedCount++;
          }
          auditFlagged++;
        }

        if (record.remarksCell && remarkTexts.length > 0 && apply) {
          setCellValue(record.remarksCell, existing + remarkTexts.join('; '), batch);
        }

        if (apply) {
          highlightRow(record.rowEl, deductAction && !hasApprovedOverride
            ? 'deduct'
            : actions.some(action => action.highlight === 'candidate') ? 'candidate' : 'review');
          record.rowEl.title = displayRemarkTexts.join('\n');
          attachFeedbackControls(record, [...new Set(actions.map(action => action.ruleId))], context);
          for (const action of actions) {
            auditLogEntries.push(Audit.buildAuditEntry(action, { ...context, amountBefore: record.approvedValue }));
          }
        }
        debugLog(`[RGHS-Audit] Row ${rowIndex}: ${actions.map(action => action.ruleId).join(', ')} ${deductAction && !hasApprovedOverride ? '(deduction applied)' : '(review decision applied)'}`);
      }
    }

    // Third pass: normal auto-fill, never touching audited rows
    for (const record of records) {
      if (auditedRows.has(record.index)) continue;

      const plan = Core.planRowUpdate({
        claimValue: record.claimValue,
        approvedValue: record.approvedValue,
        particularText: record.particularText,
        remarksValue: record.remarksValue
      });

      if (plan.reason === 'invalid-or-zero-claim') continue;

      if (plan.approvedValue !== null || plan.remarksValue !== null) {
        const key = `table-${tableIndex}-row-${record.index}`;
        const claimAmount = Core.parseAmount(record.claimValue) || 0;
        const proposedApproved = plan.approvedValue === null ? null : Core.parseAmount(plan.approvedValue);
        proposals.push({
          key,
          tableIndex,
          rowIndex: record.index,
          label: record.particularText.trim() || record.packageText.trim() || `Row ${record.index}`,
          packageText: record.packageText.trim(),
          claimAmount,
          beforeApproved: Core.parseAmount(record.approvedValue) || 0,
          proposedApproved,
          beforeRemarks: record.remarksValue,
          proposedRemarks: plan.remarksValue,
          risk: plan.reason === 'medicine' ? 'medium' : 'low',
          reason: plan.reason === 'medicine'
            ? `${Core.DEDUCTION_PERCENT}% RGHS medicine deduction; rounded to nearest whole rupee`
            : 'Copy eligible claim amount into the empty approved amount',
          ruleIds: plan.reason === 'medicine' ? ['RGHS-MEDICINE-12'] : []
        });
        rowElements.set(key, record.rowEl);
        if (apply && selectedRowKeys && !selectedRowKeys.has(key)) continue;
      }

      // Only fill if approved is empty or "0"
      if (plan.approvedValue !== null) {
        if (apply) setCellValue(record.approvedCell, plan.approvedValue, batch);
        approvedCount++;
        debugLog(`[Claim Auto-Fill] Row ${record.index}: Planned approved amount "${plan.approvedValue}"`);
      }

      // Fill remarks for medicine rows
      if (record.remarksCell && plan.remarksValue !== null) {
        if (apply) setCellValue(record.remarksCell, plan.remarksValue, batch);
        remarksCount++;
        debugLog(`[Claim Auto-Fill] Row ${record.index}: Planned deduction remark`);
      }
    }

    debugLog(`[Claim Auto-Fill] Processed ${dataRowNum} data rows from table ${tableIndex + 1}`);
  });

  // Fallback: Find by input name/id attributes
  if (proposals.length === 0) {
    debugLog('[Claim Auto-Fill] Table strategy found nothing, trying input name/id matching...');
    const inputs = collectInputs(roots);
    const proposedApprovedInputs = new Set();

    inputs.forEach((input, inputIndex) => {
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();

      if (name.includes('claim') || id.includes('claim') || placeholder.includes('claim')) {
        const parent = input.closest('tr, div, form, fieldset');
        if (!parent) return;

        const siblings = parent.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea');
        for (const [siblingIndex, sib] of [...siblings].entries()) {
          if (sib === input) continue;
          const sName = (sib.name || '').toLowerCase();
          const sId = (sib.id || '').toLowerCase();
          if (sName.includes('approved') || sName.includes('sanctioned') ||
              sId.includes('approved') || sId.includes('sanctioned')) {
            if (proposedApprovedInputs.has(sib)) continue;
            const claimVal = input.value.trim();
            const appVal = sib.value.trim();
            const amount = Core.parseAmount(claimVal);
            if (amount !== null && amount > 0 && Core.isEmptyApprovedValue(appVal)) {
              const key = `fallback-${inputIndex}-${siblingIndex}`;
              proposals.push({
                key,
                tableIndex: null,
                rowIndex: inputIndex,
                label: input.getAttribute('aria-label') || input.name || input.id || `Claim field ${inputIndex + 1}`,
                packageText: '',
                claimAmount: amount,
                beforeApproved: Core.parseAmount(appVal) || 0,
                proposedApproved: amount,
                beforeRemarks: '',
                proposedRemarks: null,
                risk: 'low',
                reason: 'Copy eligible claim amount into the empty approved amount',
                ruleIds: []
              });
              proposedApprovedInputs.add(sib);
              rowElements.set(key, parent);
              if (apply && selectedRowKeys && !selectedRowKeys.has(key)) continue;
              if (apply) {
                batch.push({ element: sib, value: getElementValue(sib) });
                const approvedValue = Object.prototype.hasOwnProperty.call(approvedOverrides, key)
                  ? String(approvedOverrides[key])
                  : String(amount);
                setElementValue(sib, approvedValue);
              }
              approvedCount++;
            }
          }
        }
      }
    });
  }

  if (apply && batch.length > 0) undoBatch = batch;
  if (apply && batch.length > 0) persistRecoverySnapshot(batch);
  if (apply && auditLogEntries.length > 0) appendAuditLog(auditLogEntries);
  const count = approvedCount + remarksCount + auditFlagged + auditDeducted;
  debugLog(`[Claim Auto-Fill] Done. ${apply ? 'Filled' : 'Previewed'} ${approvedCount} approved amount(s), ${remarksCount} remark(s); audit: ${auditDeducted} deducted, ${auditFlagged} flagged`);
  updateAuditBadge(auditFlagged + auditDeducted);
  return { count, changedFieldCount: batch.length, approvedCount, remarksCount, auditFlagged, auditDeducted, proposals, rowElements };
}

// Best-effort tab badge showing how many audit findings are open on this page.
function updateAuditBadge(count) {
  const normalizedCount = Math.max(0, Number(count) || 0);
  if (normalizedCount === lastAuditBadgeCount) return;
  lastAuditBadgeCount = normalizedCount;
  try {
    chrome.runtime.sendMessage({ action: 'setAuditBadge', count: normalizedCount }, () => {
      if (chrome.runtime.lastError) lastAuditBadgeCount = null;
    });
  } catch (error) {
    lastAuditBadgeCount = null;
    // Extension context may be gone (page outliving a reload); badge is optional.
  }
}

function formatPreview(raw, createdAt = Date.now()) {
  const token = Review.fingerprint(raw.proposals);
  return {
    count: raw.count,
    rowCount: raw.proposals.length,
    approvedCount: raw.approvedCount,
    remarksCount: raw.remarksCount,
    auditFlagged: raw.auditFlagged,
    auditDeducted: raw.auditDeducted,
    proposals: raw.proposals,
    token,
    createdAt,
    reconciliation: Review.reconcile(raw.proposals),
    blocked: raw.blocked === true,
    blockReason: raw.blockReason || null,
    blockDetails: raw.blockDetails || []
  };
}

function createReviewedPreview() {
  const raw = fillAllApprovedAmounts({ apply: false });
  const preview = formatPreview(raw);
  lastPreview = preview;
  previewRowElements = raw.rowElements;
  appendClaimActivity('preview', {
    blocked: preview.blocked,
    blockReason: preview.blockReason,
    rowCount: preview.rowCount,
    totals: preview.reconciliation,
    ruleIds: preview.proposals.flatMap(proposal => proposal.ruleIds || [])
  });
  return preview;
}

function applyReviewedPreview({ token, selectedRowKeys, approvedOverrides = {}, acknowledgedHighRisk = false } = {}) {
  const currentRaw = fillAllApprovedAmounts({ apply: false });
  if (currentRaw.blocked) {
    appendClaimActivity('apply-blocked', { blockReason: currentRaw.blockReason });
    return { ...blockedFillResult(currentRaw.blockReason, currentRaw.blockDetails), rowElements: undefined, proposals: undefined };
  }
  const current = formatPreview(currentRaw, lastPreview?.createdAt);
  const selectedKeys = Array.isArray(selectedRowKeys) ? [...new Set(selectedRowKeys)] : [];
  const invalidOverride = Object.entries(approvedOverrides).some(([key, value]) => {
    const proposal = current.proposals.find(item => item.key === key);
    if (!proposal || !selectedKeys.includes(key)) return true;
    const allowed = [0, proposal.claimAmount, proposal.beforeApproved, proposal.proposedApproved, proposal.recommendedApproved]
      .filter(item => item !== null && item !== undefined)
      .map(Number);
    return !allowed.some(item => Math.abs(item - Number(value)) < 0.005);
  });
  if (invalidOverride) return { blocked: true, blockReason: 'invalid-decision', count: 0 };
  const selected = current.proposals
    .filter(proposal => selectedKeys.includes(proposal.key))
    .map(proposal => Object.prototype.hasOwnProperty.call(approvedOverrides, proposal.key)
      ? { ...proposal, proposedApproved: Number(approvedOverrides[proposal.key]) }
      : proposal);
  const validation = Review.validateApply({
    previewToken: token,
    currentToken: current.token,
    createdAt: lastPreview?.token === token ? lastPreview.createdAt : 0,
    selectedProposals: selected,
    acknowledgedHighRisk
  });

  if (!validation.ok) {
    return {
      blocked: true,
      blockReason: validation.reason,
      currentToken: current.token,
      reconciliation: validation.totals || Review.reconcile(selected),
      count: 0
    };
  }

  const result = fillAllApprovedAmounts({
    apply: true,
    selectedRowKeys: new Set(selectedKeys),
    approvedOverrides
  });
  if (result.blocked) {
    appendClaimActivity('apply-blocked', { blockReason: result.blockReason });
    return { ...result, rowElements: undefined, proposals: undefined };
  }
  const ruleIds = [...new Set(selected.flatMap(proposal => proposal.ruleIds || []))];
  lastAppliedSummary = {
    createdAt: Date.now(),
    path: location.pathname,
    tid: findTid(),
    selectedRows: selected.length,
    changedFields: result.changedFieldCount,
    highRiskCount: validation.totals.highRiskCount,
    proposedApprovedTotal: validation.totals.proposedApprovedTotal,
    deductionTotal: validation.totals.deductionTotal,
    ruleIds
  };
  sessionStorage.setItem(APPLIED_SESSION_KEY, JSON.stringify(lastAppliedSummary));
  appendClaimActivity('apply', { rowCount: selected.length, fieldCount: result.changedFieldCount, totals: validation.totals, ruleIds });
  lastPreview = null;
  previewRowElements = new Map();
  return {
    ...result,
    proposals: undefined,
    rowElements: undefined,
    blocked: false,
    reconciliation: validation.totals
  };
}

// --- RGHS audit helpers ---

function ensureAuditStyles() {
  if (document.getElementById('rghs-audit-styles')) return;
  const style = document.createElement('style');
  style.id = 'rghs-audit-styles';
  style.textContent = [
    'tr.rghs-audit-review td { background-color: #fff3cd !important; }',
    'tr.rghs-audit-candidate td { background-color: #ffe0b2 !important; }',
    'tr.rghs-audit-deduct td { background-color: #f8d7da !important; }',
    'tr.rghs-audit-passive td { background-color: #fef3c7 !important; box-shadow: inset 0 2px #d97706, inset 0 -2px #d97706; }',
    'tr.rghs-decision-approve td { background-color: #dcfce7 !important; box-shadow: inset 0 2px #16a34a, inset 0 -2px #16a34a; }',
    'tr.rghs-decision-deduct td { background-color: #fee2e2 !important; box-shadow: inset 0 2px #dc2626, inset 0 -2px #dc2626; }',
    '.rghs-audit-feedback { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }',
    '.rghs-audit-feedback button { border: 1px solid #999; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; line-height: 1; padding: 2px 6px; }',
    '.rghs-audit-feedback button:hover { background: #eee; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

function highlightRow(rowEl, kind) {
  ensureAuditStyles();
  rowEl.classList.remove('rghs-audit-review', 'rghs-audit-candidate', 'rghs-audit-deduct');
  rowEl.classList.add(`rghs-audit-${kind}`);
}

function highlightDecisionRows(approvedByKey = {}) {
  ensureAuditStyles();
  for (const row of previewRowElements.values()) {
    row.classList.remove('rghs-decision-approve', 'rghs-decision-deduct');
  }
  for (const [key, approvedAmount] of Object.entries(approvedByKey)) {
    const row = previewRowElements.get(key);
    if (!row) continue;
    row.classList.add(Number(approvedAmount) === 0 ? 'rghs-decision-deduct' : 'rghs-decision-approve');
  }
}

function refreshPassiveAuditHighlights() {
  if (!location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  for (const row of document.querySelectorAll('tr.rghs-audit-passive')) {
    row.classList.remove('rghs-audit-passive');
  }
  if (!isAutoFillEnabled || auditMode === 'off') return;
  const preview = fillAllApprovedAmounts({ apply: false });
  if (preview.blocked) return;
  for (const proposal of preview.proposals) {
    if (proposal.risk !== 'high') continue;
    const row = preview.rowElements.get(proposal.key);
    if (row) row.classList.add('rghs-audit-passive');
  }
}

const schedulePassiveAudit = Core.createDebouncedProcessor(
  () => refreshPassiveAuditHighlights(),
  150
);

function installPassiveAuditObserver() {
  if (!location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  const observer = new MutationObserver(mutations => {
    const addedNodes = mutations.flatMap(mutation => [...mutation.addedNodes]);
    if (addedNodes.length) schedulePassiveAudit(addedNodes);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedulePassiveAudit([document]);
}

let cachedTid;
function findTid() {
  if (cachedTid !== undefined) return cachedTid;
  const text = `${document.title} ${(document.body ? document.body.textContent : '').slice(0, 30000)}`;
  const match = text.match(/\bTID[\s:.#-]*([A-Z0-9][A-Z0-9/-]{3,19})/i);
  if (match) cachedTid = match[1];
  return match ? match[1] : '';
}

let localStorageMutationChain = Promise.resolve();

function queueStorageMutation(message) {
  localStorageMutationChain = localStorageMutationChain
    .catch(() => undefined)
    .then(() => new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          void chrome.runtime.lastError;
          resolve(response?.success === true);
        });
      } catch (_) {
        resolve(false);
      }
    }));
  return localStorageMutationChain;
}

function appendStorageEntries(key, entries) {
  return queueStorageMutation({ action: 'appendStorageEntries', key, entries });
}

function appendClaimActivity(event, details = {}) {
  const totals = details.totals || {};
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    tid: findTid(),
    path: location.pathname,
    extensionVersion: chrome.runtime.getManifest().version,
    ruleSetVersion: AuditRules?.version || '',
    blocked: details.blocked === true,
    blockReason: String(details.blockReason || ''),
    rowCount: Number(details.rowCount) || 0,
    fieldCount: Number(details.fieldCount) || 0,
    proposedApprovedTotal: Number(totals.proposedApprovedTotal) || 0,
    deductionTotal: Number(totals.deductionTotal) || 0,
    highRiskCount: Number(totals.highRiskCount) || 0,
    ruleIds: [...new Set((details.ruleIds || []).map(String))]
  };
  appendStorageEntries('claimActivityLog', [entry]);
}

function clearAppliedSummary() {
  lastAppliedSummary = null;
  sessionStorage.removeItem(APPLIED_SESSION_KEY);
}

function normalizeNonnegativeNumber(value, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return integer ? Math.floor(number) : number;
}

function normalizeAppliedSummary(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  return {
    createdAt: normalizeNonnegativeNumber(saved.createdAt, true),
    path: String(saved.path || ''),
    tid: String(saved.tid || ''),
    selectedRows: normalizeNonnegativeNumber(saved.selectedRows, true),
    changedFields: normalizeNonnegativeNumber(saved.changedFields, true),
    highRiskCount: normalizeNonnegativeNumber(saved.highRiskCount, true),
    proposedApprovedTotal: normalizeNonnegativeNumber(saved.proposedApprovedTotal),
    deductionTotal: normalizeNonnegativeNumber(saved.deductionTotal),
    ruleIds: Array.isArray(saved.ruleIds) ? saved.ruleIds.map(String).slice(0, 100) : []
  };
}

function restoreAppliedSummary() {
  try {
    const saved = normalizeAppliedSummary(JSON.parse(sessionStorage.getItem(APPLIED_SESSION_KEY) || 'null'));
    const age = saved ? Date.now() - saved.createdAt : -1;
    if (saved && saved.path === location.pathname && age >= 0 && age < 24 * 60 * 60 * 1000) {
      lastAppliedSummary = saved;
    } else {
      sessionStorage.removeItem(APPLIED_SESSION_KEY);
    }
  } catch (_) {
    sessionStorage.removeItem(APPLIED_SESSION_KEY);
  }
}

function isPortalSubmitControl(target) {
  const control = target?.closest?.('button, input[type="submit"], input[type="button"]');
  if (!control) return false;
  const label = String(control.textContent || control.value || '').replace(/\s+/g, ' ').trim();
  if (/\bsubmit\b/i.test(label)) return true;

  // Do not trust control.type: HTML gives <button> without a type attribute the
  // computed type "submit", which would intercept unrelated portal buttons.
  const isExplicitSubmit = control.matches?.('input[type="submit"], button[type="submit"]') === true;
  const form = control.form;
  if (!isExplicitSubmit || !form) return false;
  const formIdentity = `${form.id || ''} ${form.name || ''} ${form.getAttribute?.('action') || ''}`;
  const containsClaimAmounts = Boolean(form.querySelector?.(
    '[name="packageFinalAmounts"], [id^="packageFinalAmount_"]'
  ));
  return containsClaimAmounts || /\b(?:claim|process.?sheet)\b/i.test(formIdentity);
}

function showSubmissionInterlock() {
  let host = document.getElementById('claim-extension-submit-guard');
  if (host) return;
  const summary = lastAppliedSummary;
  host = document.createElement('div');
  host.id = 'claim-extension-submit-guard';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(15,23,42,.55);';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}.card{width:min(480px,calc(100vw - 32px));padding:20px;border-radius:16px;background:#fff;color:#172554;box-shadow:0 20px 60px rgba(0,0,0,.35);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.title{font-size:18px;font-weight:800;color:#991b1b}.summary{margin:12px 0;padding:12px;border-radius:10px;background:#fff7ed}.ack{display:flex;gap:9px;align-items:flex-start;margin:14px 0;font-weight:650}.actions{display:flex;gap:9px;justify-content:flex-end}button{border:0;border-radius:9px;padding:10px 13px;cursor:pointer;font-weight:750}.cancel{background:#e2e8f0;color:#334155}.continue{background:#b91c1c;color:#fff}.continue:disabled{opacity:.45;cursor:not-allowed}
    </style>
    <section class="card" role="alertdialog" aria-modal="true" aria-labelledby="guard-title">
      <div class="title" id="guard-title">Final claim review required</div>
      <p>Claim Extension changed fields on this process sheet. Submission remains blocked until you acknowledge the final review.</p>
      <div class="summary">Selected rows: <strong data-summary="selectedRows"></strong><br>Changed fields: <strong data-summary="changedFields"></strong><br>Proposed approved total: <strong data-summary="proposedApprovedTotal"></strong><br>Claim-proposed difference: <strong data-summary="deductionTotal"></strong><br>High-risk rows: <strong data-summary="highRiskCount"></strong></div>
      <label class="ack"><input type="checkbox">I reviewed the approved amounts, deductions, remarks, and high-risk findings.</label>
      <div class="actions"><button class="cancel" type="button">Return to claim</button><button class="continue" type="button" disabled>Allow next Submit click</button></div>
    </section>`;
  const summaryValues = {
    selectedRows: summary.selectedRows,
    changedFields: summary.changedFields,
    proposedApprovedTotal: summary.proposedApprovedTotal,
    deductionTotal: summary.deductionTotal,
    highRiskCount: summary.highRiskCount
  };
  for (const [key, value] of Object.entries(summaryValues)) {
    const prefix = key === 'proposedApprovedTotal' || key === 'deductionTotal' ? 'Rs. ' : '';
    shadow.querySelector(`[data-summary="${key}"]`).textContent = prefix + String(value);
  }
  const checkbox = shadow.querySelector('input');
  const continueButton = shadow.querySelector('.continue');
  checkbox.addEventListener('change', () => { continueButton.disabled = !checkbox.checked; });
  shadow.querySelector('.cancel').addEventListener('click', () => host.remove());
  continueButton.addEventListener('click', () => {
    submitArmedUntil = Date.now() + 2 * 60 * 1000;
    appendClaimActivity('submit-acknowledged', { rowCount: summary.selectedRows, fieldCount: summary.changedFields, ruleIds: summary.ruleIds });
    host.remove();
  });
  document.documentElement.appendChild(host);
  checkbox.focus();
}

function installSubmissionInterlock() {
  if (!location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  restoreAppliedSummary();
  document.addEventListener('click', event => {
    if (!lastAppliedSummary || !isPortalSubmitControl(event.target) || Date.now() < submitArmedUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    appendClaimActivity('submit-blocked', { rowCount: lastAppliedSummary.selectedRows, fieldCount: lastAppliedSummary.changedFields, ruleIds: lastAppliedSummary.ruleIds });
    showSubmissionInterlock();
  }, true);
  document.addEventListener('submit', event => {
    if (!lastAppliedSummary || Date.now() < submitArmedUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    appendClaimActivity('submit-blocked', { rowCount: lastAppliedSummary.selectedRows, fieldCount: lastAppliedSummary.changedFields, ruleIds: lastAppliedSummary.ruleIds });
    showSubmissionInterlock();
  }, true);
}

// Auditor feedback buttons: confirm keeps the flag, dismiss records a false
// positive, clears the highlight and strips this rule's remark segment.
function attachFeedbackControls(record, ruleIds, context) {
  const host = record.remarksCell || record.approvedCell;
  if (!host || host.querySelector('.rghs-audit-feedback')) return;

  const wrap = document.createElement('span');
  wrap.className = 'rghs-audit-feedback';

  const makeButton = (label, title, verdict) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      recordAuditFeedback(record, ruleIds, verdict, context);
      if (verdict === 'dismissed') {
        record.rowEl.classList.remove('rghs-audit-review', 'rghs-audit-candidate', 'rghs-audit-deduct');
        record.rowEl.removeAttribute('title');
        if (record.remarksCell) {
          let cleaned = getCellValue(record.remarksCell);
          for (const ruleId of ruleIds) cleaned = Audit.stripAuditRemark(cleaned, ruleId);
          setCellValue(record.remarksCell, cleaned, []);
        }
      }
      wrap.remove();
    });
    return button;
  };

  wrap.append(
    makeButton('✓', 'Confirm finding (flag is correct)', 'confirmed'),
    makeButton('✗', 'Dismiss finding (false positive)', 'dismissed')
  );
  host.appendChild(wrap);
}

function recordAuditFeedback(record, ruleIds, verdict, context) {
  const entries = ruleIds.map(ruleId => ({
    ts: new Date().toISOString(),
    tid: context.tid,
    url: context.url,
    ruleId,
    rowNumber: record.index,
    verdict
  }));
  appendStorageEntries('rghsAuditFeedback', entries);
}

function appendAuditLog(entries) {
  appendStorageEntries('rghsAuditLog', Audit.dedupeLogEntries([], entries));
}

function persistRecoverySnapshot(batch) {
  const entries = batch
    .filter(item => item.element?.id)
    .map(item => ({ id: item.element.id, before: String(item.value ?? ''), after: getElementValue(item.element) }));
  if (!entries.length) return;

  const snapshot = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    tid: findTid(),
    url: location.href,
    version: chrome.runtime.getManifest().version,
    entries
  };
  appendStorageEntries('claimRecoverySnapshots', [snapshot]);
}

function getMatchingRecoverySnapshot(callback) {
  chrome.storage.local.get(['claimRecoverySnapshots'], result => {
    const snapshots = Array.isArray(result.claimRecoverySnapshots) ? result.claimRecoverySnapshots : [];
    const activeSnapshots = snapshots.filter(item => Date.now() - item.createdAt <= 24 * 60 * 60 * 1000);
    const tid = findTid();
    const snapshot = [...activeSnapshots].reverse().find(item => item.url === location.href || (tid && item.tid === tid));
    callback(snapshot || null, activeSnapshots);
  });
}

function restorePersistentSnapshot() {
  return new Promise(resolve => {
    getMatchingRecoverySnapshot(snapshot => {
      if (!snapshot) return resolve({ count: 0, hasRecovery: false });
      let count = 0;
      for (const entry of snapshot.entries) {
        const element = document.getElementById(entry.id);
        if (!element?.isConnected) continue;
        setElementValue(element, entry.before);
        count++;
      }
      if (count === 0) return resolve({ count: 0, hasRecovery: true });
      const fullyRestored = count === snapshot.entries.length;
      if (fullyRestored) {
        queueStorageMutation({ action: 'removeRecoverySnapshot', id: snapshot.id });
        clearAppliedSummary();
      }
      appendClaimActivity('restore', { fieldCount: count });
      resolve({ count, hasRecovery: !fullyRestored });
    });
  });
}

function hasPersistentRecovery(callback) {
  getMatchingRecoverySnapshot(snapshot => callback(Boolean(snapshot)));
}

function undoLastFill() {
  const batch = undoBatch;
  undoBatch = [];
  let count = 0;
  for (let index = batch.length - 1; index >= 0; index--) {
    const element = batch[index].element;
    if (!element?.isConnected) continue;
    setElementValue(element, batch[index].value);
    count++;
  }
  if (count > 0) {
    clearAppliedSummary();
    appendClaimActivity('undo', { fieldCount: count });
    if (count === batch.length) {
      getMatchingRecoverySnapshot(snapshot => {
        if (snapshot) queueStorageMutation({ action: 'removeRecoverySnapshot', id: snapshot.id });
      });
    }
  }
  return count;
}

globalThis.ClaimAutoFillActions = {
  preview() {
    const result = createReviewedPreview();
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  apply(options) {
    const result = applyReviewedPreview(options);
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  undo() {
    const count = undoLastFill();
    return { count, hasUndo: undoBatch.length > 0 };
  },
  status() {
    return { enabled: isAutoFillEnabled, hasUndo: undoBatch.length > 0 };
  },
  jumpToRow(key) {
    const row = previewRowElements.get(key);
    if (!row) return false;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previousOutline = row.style.outline;
    row.style.outline = '3px solid #2563eb';
    setTimeout(() => { row.style.outline = previousOutline; }, 1800);
    return true;
  },
  highlightDecisionRows,
  restoreRecovery() {
    return restorePersistentSnapshot();
  },
  hasRecovery(callback) {
    hasPersistentRecovery(callback);
  }
};

installSubmissionInterlock();
installPassiveAuditObserver();
