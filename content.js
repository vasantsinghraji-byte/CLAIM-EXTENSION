// Content script for auto-filling approved amounts with claim amounts

const AUDIT_MODES = ['off', 'flag', 'deduct'];

let isAutoFillEnabled = true;
let auditMode = 'flag';
let ruleOverrides = {};
let customRuleConfig = null;
let processingRuleSet = null;
let licenceState = null; // null = never checked yet (fresh install or signed out)
let undoBatch = [];
let lastPreview = null;
let previewRowElements = new Map();
const Core = globalThis.ClaimAutoFillCore;
const Audit = globalThis.RGHSAuditCore;
const AuditRules = globalThis.RGHSAuditRules;
const Review = globalThis.ClaimReviewCore;
const ProcessingRules = globalThis.ClaimProcessingRules;
const ruleSetValidation = Audit && AuditRules && Audit.validateRuleSet
  ? Audit.validateRuleSet(AuditRules)
  : { ok: false, errors: ['Audit rule engine is unavailable'] };
const DEBUG = globalThis.CLAIM_EXTENSION_DEBUG === true;
let lastAuditBadgeCount = null;
let invoicePatientValidation = { key: '', names: [], loading: false };
let ipdClaimDetailContext = { tid: '', loading: false, loaded: false, dischargeStatus: '' };
let cardTrackerContext = { tid: '', cardNumber: '', patientName: '', loading: false, loaded: false, cases: [] };
let investigationChecklistPreview = null;
let lastPublishedInvestigationChecklist = '';
const historicalPreauthDetailsCache = new Map();
const APPROVED_CONTROL_SELECTOR = [
  '[name="packageFinalAmounts"]',
  '[id^="packageFinalAmount_"]',
  '[name="tpaapprovedAmount"]',
  '[id^="tpaapprovedAmount_"]'
].join(', ');
const REMARKS_CONTROL_SELECTOR = '[id^="packageremarks_"], [id^="itemremarks_"]';

function processingAreaForPage() {
  if (location.pathname.startsWith('/RGHS/tpaPharmacy')) return 'PHARMACY';
  if (isOpdClaimPage()) return 'OPD';
  return 'IPD';
}

function isOpdClaimPage() {
  return /\/RGHS\/tpa(?:pre.?auth)?OPD/i.test(location.pathname)
    || /\/RGHS\/tpaOPD(?:pre.?auth)?/i.test(location.pathname);
}

function isMainIpdClaimPage() {
  return /^\/RGHS\/tpaClaim(?:Discharge|Settle)/i.test(location.pathname);
}

function configuredColumnKey(headerText) {
  const text = String(headerText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.includes('deduction') && text.includes('remark')) return 'deductionRemarks';
  if (text.includes('pharmacy') && text.includes('remark')) return 'pharmacyRemarks';
  if (text.includes('validation') && text.includes('remark')) return 'validationRemarks';
  if (text === 'remark' || text === 'remarks') return 'remarks';
  return null;
}

function extractIpdClaimDetailContext(html) {
  const parsed = new globalThis.DOMParser().parseFromString(String(html || ''), 'text/html');
  const fields = new Map();
  for (const group of parsed.querySelectorAll('#tpaClaimContentDetails .form-group, .form-group')) {
    const label = group.querySelector('label')?.textContent?.replace(/\s+/g, ' ').trim();
    const value = group.querySelector('input, select, textarea')?.value?.trim();
    if (label && value) fields.set(label, value);
  }
  return {
    admissionType: fields.get('Admission Type') || '',
    dischargeStatus: fields.get('Patient Discharge Status') || '',
    admissionDate: fields.get('Date of Admission') || '',
    admissionTime: fields.get('Time of Admission') || '',
    dischargeDate: fields.get('Date of Discharge') || '',
    dischargeTime: fields.get('Time of Discharge') || '',
    rghsCardNumber: fields.get('RGHS Card No.') || '',
    finalPackageCodes: [...parsed.querySelectorAll('#finalPackageTablebody tr')]
      .map(row => row.cells[0]?.textContent?.trim() || '')
      .filter(Boolean)
  };
}

function dispatchIpdContextUpdate() {
  const context = ipdClaimDetailContext;
  const completed24HourIntervals = Core.calculateCompleted24HourIntervals(context);
  window.dispatchEvent(new CustomEvent('claim-autofill:ipd-context', {
    detail: {
      loaded: context.loaded === true,
      admissionType: context.admissionType || '',
      dischargeStatus: context.dischargeStatus || '',
      admissionDate: context.admissionDate || '',
      admissionTime: context.admissionTime || '',
      dischargeDate: context.dischargeDate || '',
      dischargeTime: context.dischargeTime || '',
      completed24HourIntervals
    }
  }));
}

function extractCardTrackerCases(html) {
  const parsed = new globalThis.DOMParser().parseFromString(String(html || ''), 'text/html');
  const table = parsed.getElementById('CardTrackerTable');
  if (!table) return [];
  const headers = [...table.querySelectorAll('thead th, tr:first-child th')]
    .map(cell => cell.textContent.replace(/\s+/g, ' ').trim());
  const pickCell = (row, labels) => {
    const index = headers.findIndex(header => labels.some(label => header.toLowerCase() === label || header.toLowerCase().includes(label)));
    return index >= 0 ? row.cells[index] : null;
  };
  const pick = (row, labels) => {
    return pickCell(row, labels)?.textContent?.replace(/\s+/g, ' ').trim() || '';
  };
  return [...table.querySelectorAll('tbody tr')].map(row => {
    const transactionLabels = ['transaction id/ reimbursement id', 'transaction id', 'reimbursement id'];
    const transactionCell = pickCell(row, transactionLabels);
    return {
    transactionId: pick(row, transactionLabels),
    transactionUrl: transactionCell?.querySelector('a[href]')?.href || '',
    patientName: pick(row, ['patient name', 'beneficiary name', 'member name']),
    claimStatus: pick(row, ['claim status', 'status']),
    caseDate: pick(row, ['tid/rem id creation date', 'creation date']),
    admissionDate: pick(row, ['admission date']),
    dischargeDate: pick(row, ['discharge date']),
    dischargeStatus: pick(row, ['discharge status']),
    claimType: pick(row, ['claim type', 'claim category', 'case type']),
    finalPackages: pick(row, ['final used packages code', 'final package']),
    preauthPackages: pick(row, ['preauth packages code', 'preauth package']),
    approvedAmount: pick(row, ['tpa approved amount', 'cu/jd approved amount'])
    };
  }).filter(item => item.transactionId);
}

function dispatchCardTrackerUpdate() {
  window.dispatchEvent(new CustomEvent('claim-autofill:card-history', {
    detail: { loaded: cardTrackerContext.loaded === true, cases: cardTrackerContext.cases || [] }
  }));
}

function findLabeledPageValue(labelPattern) {
  for (const group of document.querySelectorAll('.form-group, tr, .row')) {
    const label = group.querySelector('label, th, td:first-child')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (!labelPattern.test(label)) continue;
    const control = group.querySelector('input, select, textarea');
    const value = control?.value?.trim() || [...group.querySelectorAll('td')].at(-1)?.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (value && value !== label) return value;
  }
  return '';
}

function findTabularCardIdentity(currentTid) {
  for (const table of document.querySelectorAll('table')) {
    const headerRow = [...table.querySelectorAll('tr')].find(row => {
      const labels = [...row.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
      return labels.some(label => /(?:patient\s*)?rghs\s*card\s*(?:no|number)?/.test(label))
        && labels.some(label => /patient\s*name|beneficiary\s*name|member\s*name/.test(label));
    });
    if (!headerRow) continue;
    const headers = [...headerRow.querySelectorAll(':scope > th, :scope > td')]
      .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
    const transactionIndex = headers.findIndex(header => /transaction\s*id|\btid\b/.test(header));
    const patientIndex = headers.findIndex(header => /patient\s*name|beneficiary\s*name|member\s*name/.test(header));
    const cardIndex = headers.findIndex(header => /(?:patient\s*)?rghs\s*card\s*(?:no|number)?/.test(header));
    if (cardIndex < 0 || patientIndex < 0) continue;
    const rows = [...table.querySelectorAll('tbody tr, tr')].filter(row => row !== headerRow);
    const row = rows.find(candidate => {
      const cells = candidate.querySelectorAll(':scope > td');
      return cells.length > 0 && (transactionIndex < 0 || !currentTid || cells[transactionIndex]?.textContent?.replace(/\s+/g, '').includes(currentTid));
    });
    const cells = row?.querySelectorAll(':scope > td');
    const cardNumber = cells?.[cardIndex]?.textContent?.trim() || '';
    const patientName = cells?.[patientIndex]?.textContent?.trim() || '';
    if (cardNumber || patientName) return { cardNumber, patientName };
  }
  return { cardNumber: '', patientName: '' };
}

function getCurrentCardIdentity() {
  const detailTable = document.getElementById('patiendetailtable');
  const headerCells = detailTable ? [...detailTable.querySelectorAll('tr')].find(row => row.querySelectorAll('th').length > 0)?.querySelectorAll('th') : [];
  const headers = [...headerCells].map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
  const currentTid = findTid();
  const tabularIdentity = findTabularCardIdentity(currentTid);
  const transactionIndex = headers.findIndex(header => header === 'transaction id');
  const patientIndex = headers.findIndex(header => header === 'patient name');
  const cardIndex = headers.findIndex(header => /patient\s+rghs\s+card\s+no/i.test(header));
  const currentRow = detailTable ? [...detailTable.querySelectorAll('tbody tr, tr')].find(row => {
    const cells = row.querySelectorAll(':scope > td');
    return cells.length > 0 && (transactionIndex < 0 || cells[transactionIndex]?.textContent?.replace(/\s+/g, '').includes(currentTid));
  }) : null;
  const tableCardNumber = cardIndex >= 0 ? currentRow?.querySelectorAll(':scope > td')[cardIndex]?.textContent?.trim() || '' : '';
  const tablePatientName = patientIndex >= 0 ? currentRow?.querySelectorAll(':scope > td')[patientIndex]?.textContent?.trim() || '' : '';
  const cardNumber = ipdClaimDetailContext.rghsCardNumber
    || tableCardNumber
    || tabularIdentity.cardNumber
    || findLabeledPageValue(/(?:rghs\s*)?card\s*(?:no|number)?/i)
    || document.querySelector('[id*="card" i][value], [name*="card" i][value]')?.value?.trim()
    || '';
  const patientName = tablePatientName
    || tabularIdentity.patientName
    || findLabeledPageValue(/(?:patient|beneficiary|member)\s*name/i)
    || document.querySelector('[id*="patientName" i][value], [name*="patientName" i][value]')?.value?.trim()
    || '';
  return { tid: currentTid, cardNumber, patientName };
}

function ensureCardTrackerContext() {
  const { tid, cardNumber, patientName } = getCurrentCardIdentity();
  if (!tid || !cardNumber || cardTrackerContext.tid === tid
      && (cardTrackerContext.loading || cardTrackerContext.loaded)) return;
  cardTrackerContext = { tid, cardNumber, patientName, loading: true, loaded: false, cases: [] };
  fetch(`/RGHS/tpaCardTracker/${encodeURIComponent(cardNumber)}`, { credentials: 'same-origin' })
    .then(response => response.ok ? response.text() : Promise.reject(new Error('card-tracker-request-failed')))
    .then(html => {
      if (cardTrackerContext.tid !== tid) return;
      cardTrackerContext = { tid, cardNumber, patientName, loading: false, loaded: true, cases: extractCardTrackerCases(html) };
      dispatchCardTrackerUpdate();
    })
    .catch(() => {
      if (cardTrackerContext.tid === tid) {
        cardTrackerContext = { tid, cardNumber, patientName, loading: false, loaded: true, cases: [] };
        dispatchCardTrackerUpdate();
      }
    });
}

function isInvestigationProposal(proposal) {
  return /\binvestigation\b/i.test(`${proposal?.label || ''} ${proposal?.packageText || ''}`);
}

function packageCodeAppearsInText(code, text) {
  const escaped = String(code || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped && new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`, 'i').test(String(text || '')));
}

function extractPreauthPackageRows(root) {
  const table = root?.getElementById?.('packageDetailTpa') || root?.querySelector?.('#packageDetailTpa');
  if (table) return [...table.querySelectorAll('tbody tr')].flatMap((row, index) => {
    const cells = [...row.querySelectorAll(':scope > td')];
    const code = Core.extractPackageCode(row.querySelector('#packageid')?.textContent || '');
    const label = row.querySelector('#packagename')?.textContent?.trim() || `Package ${index + 1}`;
    const requested = Core.parseAmount(cells[4]?.textContent);
    const approved = Core.parseAmount(row.querySelector('input[type="number"]')?.value);
    return code && requested !== null && approved !== null ? [{ code, label, requested, approved }] : [];
  });
  const tables = [...(root?.querySelectorAll?.('table') || [])];
  const fallbackTable = tables.find(candidate => {
    const headers = [...candidate.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
      .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
    return headers.some(header => /package.*(?:code|id)/i.test(header))
      && headers.some(header => /(?:requested|claim|no\.?\s*of|number of).*?(?:unit|quantity|day)/i.test(header))
      && headers.some(header => /approved.*?(?:unit|quantity|day)/i.test(header));
  });
  if (!fallbackTable) return [];
  const headers = [...fallbackTable.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
    .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
  const codeIndex = headers.findIndex(header => /package.*(?:code|id)/i.test(header));
  const labelIndex = headers.findIndex(header => /package.*name|particular/i.test(header));
  const requestedIndex = headers.findIndex(header => /(?:requested|claim|no\.?\s*of|number of).*?(?:unit|quantity|day)/i.test(header));
  const approvedIndex = headers.findIndex(header => /approved.*?(?:unit|quantity|day)/i.test(header));
  return [...fallbackTable.querySelectorAll('tbody tr')].flatMap((row, index) => {
    const cells = [...row.querySelectorAll(':scope > td')];
    const code = Core.extractPackageCode(getCellValue(cells[codeIndex]));
    const label = getCellValue(cells[labelIndex]) || `Package ${index + 1}`;
    const requested = Core.parseAmount(getCellValue(cells[requestedIndex]));
    const approved = Core.parseAmount(getCellValue(cells[approvedIndex]));
    return code && requested !== null && approved !== null ? [{ code, label, requested, approved }] : [];
  });
}

function extractCurrentOpdPackageRows(root) {
  const rowsByCode = new Map();
  for (const table of root?.querySelectorAll?.('table') || []) {
    const tableRows = [...table.querySelectorAll('tr')];
    const headerIndex = tableRows.findIndex(row => {
      const headers = [...row.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
      return headers.some(header => /(?:pre.?auth\s*)?package\s*(?:code|id)/i.test(header));
    });
    if (headerIndex < 0) continue;
    const headers = [...tableRows[headerIndex].querySelectorAll(':scope > th, :scope > td')]
      .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
    const codeIndex = headers.findIndex(header => /(?:pre.?auth\s*)?package\s*(?:code|id)/i.test(header));
    const labelIndex = headers.findIndex(header => /package\s*name|particular(?:s)?|description/i.test(header));
    if (codeIndex < 0) continue;
    for (const row of tableRows.slice(headerIndex + 1)) {
      const cells = [...row.querySelectorAll(':scope > td')];
      if (cells.length <= codeIndex) continue;
      const codeText = getCellValue(cells[codeIndex]);
      const label = labelIndex >= 0 && cells[labelIndex]
        ? getCellValue(cells[labelIndex]).trim()
        : '';
      // Some OPD layouts put a comma-separated list in a single package-code cell.
      for (const value of codeText.split(',')) {
        const code = Core.extractPackageCode(value);
        if (code && !rowsByCode.has(code)) {
          rowsByCode.set(code, { code, label: label || `Package ${code}` });
        }
      }
    }
  }
  for (const codeCell of root?.querySelectorAll?.('[id="packageid"], [id^="packageid_"], [name="packageid"], [name^="packageid_"]') || []) {
    const code = Core.extractPackageCode(getCellValue(codeCell));
    if (!code || rowsByCode.has(code)) continue;
    const row = codeCell.closest('tr');
    const label = row?.querySelector('[id="packagename"], [id^="packagename_"], [name="packagename"], [name^="packagename_"]');
    rowsByCode.set(code, { code, label: getCellValue(label).trim() || `Package ${code}` });
  }
  return [...rowsByCode.values()];
}

async function getHistoricalPreauthPackageDetails(tid) {
  if (historicalPreauthDetailsCache.has(tid)) return historicalPreauthDetailsCache.get(tid);
  const request = fetch('/RGHS/tpaPreAuthDataByTidOpd', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ tid })
  })
    .then(response => response.ok ? response.text() : Promise.reject(new Error('historical-preauth-request-failed')))
    .then(html => extractPreauthPackageRows(new globalThis.DOMParser().parseFromString(html, 'text/html')))
    .catch(() => null);
  historicalPreauthDetailsCache.set(tid, request);
  return request;
}

async function getBlockedInvestigationHistory() {
  const identity = getCurrentCardIdentity();
  if (!isOpdClaimPage()) {
    return { available: false, reason: 'not-opd', matches: [] };
  }
  if (!identity.patientName) return { available: false, reason: 'patient-name-unavailable', matches: [] };
  if (cardTrackerContext.tid !== identity.tid || !cardTrackerContext.loaded) {
    ensureCardTrackerContext();
    return { available: false, reason: 'history-loading', matches: [] };
  }
  const current = fillAllApprovedAmounts({ apply: false });
  // OPD and pre-auth pages can provide package codes without a process-sheet preview.
  // A preview may legitimately be unavailable on these layouts, so use it only as
  // a last-resort source of audit findings rather than a gate for history matching.
  const auditBlockedInvestigations = (current.blocked ? [] : current.proposals)
    .filter(proposal => proposal.risk === 'high' && isInvestigationProposal(proposal))
    .map(proposal => ({ label: proposal.label, code: Core.extractPackageCode(proposal.packageText), ruleIds: proposal.ruleIds || [] }))
    .filter(item => item.code);
  const currentPreauthPackages = extractPreauthPackageRows(document)
    .map(pkg => ({ label: pkg.label, code: pkg.code, ruleIds: [], currentlyBlocked: pkg.approved < pkg.requested }))
    .filter(item => item.code);
  const currentPreauthByCode = new Map(currentPreauthPackages.map(item => [item.code, item]));
  const currentOpdPackages = extractCurrentOpdPackageRows(document)
    .map(pkg => ({
      ...pkg,
      ruleIds: [],
      currentlyBlocked: currentPreauthByCode.get(pkg.code)?.currentlyBlocked === true
    }));
  const preauthBlockedInvestigations = getPreauthBlockedInvestigations();
  const currentInvestigations = [...new Map((currentOpdPackages.length ? currentOpdPackages
    : currentPreauthPackages.length ? currentPreauthPackages
    : preauthBlockedInvestigations.length ? preauthBlockedInvestigations.map(item => ({ ...item, currentlyBlocked: true }))
      : auditBlockedInvestigations.map(item => ({ ...item, currentlyBlocked: true }))
  ).map(item => [item.code, item])).values()];
  const currentBlockedInvestigations = currentInvestigations.filter(item => item.currentlyBlocked);
  const priorCases = cardTrackerContext.cases.filter(item =>
    item.transactionId !== identity.tid
    && item.patientName
    && Core.patientNamesMatch(identity.patientName, item.patientName)
  );
  const candidateCases = priorCases.filter(item => currentInvestigations.some(investigation =>
    packageCodeAppearsInText(investigation.code, `${item.preauthPackages} ${item.finalPackages}`)));
  const detailResults = await Promise.all(candidateCases.map(async item => ({
    item,
    packages: await getHistoricalPreauthPackageDetails(item.transactionId)
  })));
  const historicalDetailsByTid = new Map(detailResults.map(({ item, packages }) => [item.transactionId, packages]));
  const trackerMatches = candidateCases.flatMap(item => currentInvestigations
    .filter(investigation => packageCodeAppearsInText(investigation.code, `${item.preauthPackages} ${item.finalPackages}`))
    .map(investigation => {
      const historicalPackage = historicalDetailsByTid.get(item.transactionId)?.find(pkg => pkg.code === investigation.code);
      return {
        ...investigation,
        transactionId: item.transactionId,
        transactionUrl: item.transactionUrl,
        claimStatus: item.claimStatus,
        caseDate: item.caseDate || item.admissionDate || item.dischargeDate,
        historicalRequestedUnits: historicalPackage?.requested,
        historicalApprovedUnits: historicalPackage?.approved
      };
    }));
  const matches = detailResults.flatMap(({ item, packages }) => {
    if (!Array.isArray(packages)) return [];
    const historicallyBlocked = packages.filter(pkg => pkg.approved < pkg.requested);
    return currentBlockedInvestigations.flatMap(investigation => historicallyBlocked
      .filter(pkg => pkg.code === investigation.code)
      .map(pkg => ({
        ...investigation,
        historicalRequestedUnits: pkg.requested,
        historicalApprovedUnits: pkg.approved,
        transactionId: item.transactionId,
        transactionUrl: item.transactionUrl,
        claimStatus: item.claimStatus,
        caseDate: item.caseDate || item.admissionDate || item.dischargeDate
      })));
  });
  const packageMatches = [...matches.reduce((byCode, match) => {
    if (!byCode.has(match.code)) byCode.set(match.code, { ...match, history: [] });
    byCode.get(match.code).history.push({
      transactionId: match.transactionId,
      transactionUrl: match.transactionUrl,
      claimStatus: match.claimStatus,
      caseDate: match.caseDate,
      historicalRequestedUnits: match.historicalRequestedUnits,
      historicalApprovedUnits: match.historicalApprovedUnits
    });
    return byCode;
  }, new Map()).values()];
  const similarPackageHistory = [...trackerMatches.reduce((byCode, match) => {
    if (!byCode.has(match.code)) byCode.set(match.code, { ...match, history: [] });
    byCode.get(match.code).history.push({
      transactionId: match.transactionId,
      transactionUrl: match.transactionUrl,
      claimStatus: match.claimStatus,
      caseDate: match.caseDate,
      historicalRequestedUnits: match.historicalRequestedUnits,
      historicalApprovedUnits: match.historicalApprovedUnits
    });
    return byCode;
  }, new Map()).values()];
  return {
    available: true,
    currentCount: currentInvestigations.length,
    currentBlockedCount: currentBlockedInvestigations.length,
    repeatedPackageCount: packageMatches.length,
    packageMatches,
    similarPackageCount: similarPackageHistory.length,
    similarPackageHistory,
    matches,
    checkedHistoricalCaseCount: candidateCases.length,
    unavailableHistoricalCaseCount: detailResults.filter(item => item.packages === null).length
  };
}

function getInvestigationChecklist() {
  const rows = [];
  for (const row of document.querySelectorAll('#processSheetTable tr')) {
    const nameCell = row.querySelector('[id^="packageName_"]');
    if (!nameCell || !/^investigation$/i.test(nameCell.textContent.trim())) continue;
    const index = nameCell.id.match(/_(\d+)$/)?.[1];
    const expected = Core.parseAmount(row.querySelector(`#packageDays_${index}`)?.textContent);
    const rate = Core.parseAmount(row.querySelector(`#packageRate_${index}`)?.textContent);
    const approvedCell = row.querySelector(`#packageFinalAmount_${index}`);
    const remarksCell = row.querySelector(`#packageremarks_${index}`);
    if (!index || expected === null || rate === null || !approvedCell || !remarksCell) continue;
    rows.push({
      index: Number(index),
      label: row.querySelector(`#packageCode_${index}`)?.textContent?.trim() || `Investigation ${index}`,
      expected,
      rate,
      approvedCell,
      remarksCell,
      rowEl: row
    });
  }
  return rows;
}

function publishInvestigationChecklist() {
  if (!location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  const tid = findTid();
  const items = getInvestigationChecklist()
    .map(({ index, label, expected }) => ({ index, label, expected }));
  if (!tid || !items.length) return;
  const signature = `${tid}:${JSON.stringify(items)}`;
  if (signature === lastPublishedInvestigationChecklist) return;
  lastPublishedInvestigationChecklist = signature;
  chrome.runtime.sendMessage({ action: 'registerInvestigationChecklist', tid, items }, () => {
    void chrome.runtime.lastError;
  });
}

function getMainClaimInvestigationChecklist() {
  const table = document.getElementById('packageDetailTpa');
  if (!table) return [];
  const headers = [...table.querySelectorAll('tr')].find(row => row.querySelectorAll('th').length > 0)
    ?.querySelectorAll('th') || [];
  const names = [...headers].map(cell => cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
  const codeIndex = names.findIndex(name => name.includes('package code'));
  const nameIndex = names.findIndex(name => name.includes('package name'));
  const unitIndex = names.findIndex(name => name === 'number of units');
  if (unitIndex < 0) return [];
  return [...table.querySelectorAll('tbody tr')].map((row, index) => {
    const cells = row.querySelectorAll(':scope > td');
    const offset = Math.max(0, cells.length - headers.length);
    const expected = Core.parseAmount(getCellValue(cells[unitIndex + offset]));
    if (cells.length === 0 || expected === null) return null;
    const code = codeIndex >= 0 ? getCellValue(cells[codeIndex + offset]) : '';
    const name = nameIndex >= 0 ? getCellValue(cells[nameIndex + offset]) : '';
    return { index: `main-${index}`, label: [code, name].filter(Boolean).join(' — ') || `Package ${index + 1}`, expected, writable: false };
  }).filter(Boolean);
}

function getPreauthBlockedInvestigations() {
  if (!isOpdClaimPage()) return [];
  return extractPreauthPackageRows(document)
    .filter(pkg => pkg.approved < pkg.requested)
    .map(pkg => ({ label: pkg.label, code: pkg.code, ruleIds: [] }));
}

function previewInvestigationVerification(verifiedCounts) {
  const supplied = new Map((Array.isArray(verifiedCounts) ? verifiedCounts : [])
    .map(item => [Number(item.index), Core.parseAmount(item.found)]));
  const rows = getInvestigationChecklist().filter(row => row.approvedCell && row.remarksCell);
  const entries = rows.flatMap(row => {
    const found = supplied.get(row.index);
    if (found === null || found === undefined || found < 0 || found > row.expected) return [];
    const approvedAmount = Math.round(row.rate * found * 100) / 100;
    const existingRemarks = getCellValue(row.remarksCell).trim();
    const remark = `Investigation verification: ${found} of ${row.expected} report(s) confirmed by processor.`;
    return [{
      key: `investigation-${row.index}`,
      row,
      found,
      approvedAmount,
      proposal: {
        key: `investigation-${row.index}`,
        label: row.label,
        claimAmount: row.rate * row.expected,
        beforeApproved: Core.parseAmount(getCellValue(row.approvedCell)) || 0,
        proposedApproved: approvedAmount,
        beforeRemarks: getCellValue(row.remarksCell),
        proposedRemarks: existingRemarks.includes('Investigation verification:') ? existingRemarks : `${existingRemarks}${existingRemarks ? '; ' : ''}${remark}`,
        risk: found < row.expected ? 'high' : 'low',
        reason: `Processor verified ${found} of ${row.expected} investigation report(s)`
      }
    }];
  });
  const proposals = entries.map(entry => entry.proposal);
  const token = Review.fingerprint(proposals);
  investigationChecklistPreview = { token, entries, tid: findTid(), createdAt: Date.now() };
  return { token, proposals };
}

async function applyInvestigationVerification(token) {
  const preview = investigationChecklistPreview;
  if (!preview || preview.token !== token || preview.tid !== findTid() || Date.now() - preview.createdAt > 10 * 60 * 1000) {
    return { blocked: true, blockReason: 'stale', count: 0 };
  }
  const batch = [];
  for (const entry of preview.entries) {
    setCellValue(entry.row.approvedCell, String(entry.approvedAmount), batch);
    entry.row.approvedCell.dataset.claimExtensionInvestigationVerified = 'true';
  }
  investigationChecklistPreview = null;
  undoBatch = batch;
  window.dispatchEvent(new CustomEvent('claim-autofill:investigations-verified', {
    detail: { rowIndexes: preview.entries.map(entry => entry.row.index) }
  }));
  const result = {
    blocked: false,
    count: batch.length,
    changedFieldCount: batch.length,
    hasUndo: batch.length > 0
  };
  const recoverySaved = await persistRecoverySnapshot(batch);
  if (recoverySaved) {
    appendClaimActivity('apply', { fieldCount: batch.length, rowCount: preview.entries.length, ruleIds: ['RGHS-INVESTIGATION-VERIFICATION'] });
  }
  return { ...result, recoverySaved };
}

function findIpdActionSelect() {
  return [...document.querySelectorAll('select')].find(select => {
    const group = select.closest('.form-group, tr, .row') || select.parentElement;
    const label = group?.querySelector('label, th, td:first-child')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const options = [...select.options].map(option => option.textContent.replace(/\s+/g, ' ').trim()).join(' ');
    return /(?:select\s*)?action|action\s*taken/i.test(label) || /query.*approve.*reject|approve.*query.*reject/i.test(options);
  }) || null;
}

function selectedIpdAction() {
  const select = findIpdActionSelect();
  const value = select?.selectedOptions?.[0]?.textContent || select?.value || '';
  if (/\bquery\b/i.test(value)) return 'query';
  if (/\breject/i.test(value)) return 'reject';
  if (/\bapprove/i.test(value)) return 'approve';
  return '';
}

function findIpdActionTextBox(action) {
  if (selectedIpdAction() !== action) return null;
  const selectors = action === 'query'
    ? ['textarea[id*="query" i]', 'textarea[name*="query" i]', 'input[type="text"][id*="query" i]', 'input[type="text"][name*="query" i]']
    : ['textarea[id*="remark" i]', 'textarea[name*="remark" i]', 'input[type="text"][id*="remark" i]', 'input[type="text"][name*="remark" i]'];
  const direct = document.querySelector(selectors.join(', '));
  if (direct) return direct;
  const labelPattern = action === 'query' ? /\bquery\b/i : /\bremarks?\b/i;
  for (const group of document.querySelectorAll('.form-group, tr, .row')) {
    const label = group.querySelector('label, th, td:first-child')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (!labelPattern.test(label)) continue;
    const control = group.querySelector('textarea, input[type="text"], input:not([type])');
    if (control) return control;
  }
  return null;
}

function appendIpdActionRemarks(action, remarks) {
  if (!isMainIpdClaimPage()) return { ok: false, addedCount: 0 };
  if (!['approve', 'query', 'reject'].includes(action)) return { ok: false, addedCount: 0 };
  const targetBox = findIpdActionTextBox(action);
  if (!targetBox) return { ok: false, addedCount: 0 };
  const existing = getElementValue(targetBox).trim();
  const additions = [...new Set((Array.isArray(remarks) ? remarks : [])
    .map(remark => String(remark || '').trim())
    .filter(remark => remark && !existing.includes(remark)))];
  if (additions.length) setElementValue(targetBox, [existing, ...additions].filter(Boolean).join('\n'));
  return { ok: true, addedCount: additions.length };
}

function getReviewDocuments() {
  if (!isMainIpdClaimPage()) return [];
  const headers = [...document.querySelectorAll('a, button, h1, h2, h3, h4, h5, div, span')]
    .filter(element => element.textContent?.replace(/\s+/g, ' ').trim() === 'Mandatory Claim Documents');
  const header = headers[0];
  if (!header) return [];
  const laterSectionHeader = [...document.querySelectorAll('a, button, h1, h2, h3, h4, h5, div, span')]
    .find(element => {
      const label = element.textContent?.replace(/\s+/g, ' ').trim() || '';
      return /^(?:PreAuth Documents|Documents for Extended Stay)$/i.test(label)
        && Boolean(header.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  const documents = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    if (!(header.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (laterSectionHeader && !(link.compareDocumentPosition(laterSectionHeader) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const href = link.getAttribute('href')?.trim() || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    const label = [link.textContent, link.getAttribute('title'), link.getAttribute('aria-label')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    let url;
    try { url = new URL(href, location.href); } catch (_) { continue; }
    if (url.origin !== location.origin || !/^https?:$/i.test(url.protocol)) continue;
    documents.set(url.href, { url: url.href, label: label || 'Claim document' });
    if (documents.size >= 20) break;
  }
  return [...documents.values()];
}

function extractECardSummary(html, patientName = '') {
  const parsed = new globalThis.DOMParser().parseFromString(String(html || ''), 'text/html');
  const entries = [];
  for (const row of parsed.querySelectorAll('tr')) {
    const cells = [...row.querySelectorAll(':scope > th, :scope > td')];
    if (cells.length < 2) continue;
    const label = cells[0].textContent.replace(/\s+/g, ' ').trim();
    const value = cells[1].textContent.replace(/\s+/g, ' ').trim();
    if (/card|limit|balance|status|valid/i.test(label) && value) entries.push({ label, value });
  }
  const parseGroup = group => [...group.querySelectorAll('p > b, p > strong')].map(label => {
    const labelText = label.textContent.replace(/\s+/g, ' ').trim();
    const fullText = label.parentElement?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return { label: labelText, value: fullText.slice(labelText.length).replace(/^\s*[:-]\s*/, '').trim() };
  }).filter(item => item.value);
  const groups = [...parsed.querySelectorAll('.ecard-details, .ecard-details-member-details')]
    .map(parseGroup).filter(group => group.length);
  const matchedGroup = groups.find(group => group.some(item => /name of (?:the )?(?:beneficiary|member)/i.test(item.label)
    && Core.patientNamesMatch(patientName, item.value)));
  for (const item of matchedGroup || groups[0] || []) {
    if (/card|limit|balance|status|valid|beneficiary|category|relation/i.test(item.label)) entries.push(item);
  }
  return [...new Map(entries.map(item => [`${item.label}:${item.value}`, item])).values()].slice(0, 8);
}

function ensureIpdClaimDetailContext() {
  if (!location.pathname.startsWith('/RGHS/processSheetSearch/')) return;
  const tid = document.getElementById('transactionId')?.value?.trim() || findTid();
  if (!tid || ipdClaimDetailContext.tid === tid && (ipdClaimDetailContext.loading || ipdClaimDetailContext.loaded)) return;

  ipdClaimDetailContext = { tid, loading: true, loaded: false, dischargeStatus: '' };
  fetch('/RGHS/tpaClaimSettleTidDetails', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ transactionId: tid })
  })
    .then(response => response.ok ? response.text() : Promise.reject(new Error('claim-detail-request-failed')))
    .then(html => {
      if (ipdClaimDetailContext.tid !== tid) return;
      ipdClaimDetailContext = { tid, loading: false, loaded: true, ...extractIpdClaimDetailContext(html) };
      dispatchIpdContextUpdate();
      ensureCardTrackerContext();
      schedulePassiveAudit([document]);
    })
    .catch(() => {
      if (ipdClaimDetailContext.tid === tid) {
        ipdClaimDetailContext = { tid, loading: false, loaded: true, dischargeStatus: '' };
        dispatchIpdContextUpdate();
      }
    });
}

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
  chrome.storage.local.get(['ruleOverrides', 'customRuleConfig', 'processingRuleSet', 'licenceState'], result => {
    ruleOverrides = result.ruleOverrides && typeof result.ruleOverrides === 'object' && !Array.isArray(result.ruleOverrides)
      ? result.ruleOverrides
      : {};
    customRuleConfig = result.customRuleConfig || null;
    processingRuleSet = result.processingRuleSet || null;
    licenceState = result.licenceState || null;
    schedulePassiveAudit([document]);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.customRuleConfig) {
    customRuleConfig = changes.customRuleConfig.newValue || null;
    schedulePassiveAudit([document]);
  }
  if (area === 'local' && changes.processingRuleSet) {
    const nextRuleSet = changes.processingRuleSet.newValue || null;
    if ((processingRuleSet?.versionId || '') !== (nextRuleSet?.versionId || '')) lastPreview = null;
    processingRuleSet = nextRuleSet;
    schedulePassiveAudit([document]);
  }
  if (area === 'local' && changes.ruleOverrides) {
    ruleOverrides = changes.ruleOverrides.newValue && typeof changes.ruleOverrides.newValue === 'object'
      && !Array.isArray(changes.ruleOverrides.newValue)
      ? changes.ruleOverrides.newValue
      : {};
    schedulePassiveAudit([document]);
  }
  if (area === 'local' && changes.licenceState) {
    licenceState = changes.licenceState.newValue || null;
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
  const respond = promise => Promise.resolve(promise)
    .then(result => sendResponse({ success: true, ...result }))
    .catch(error => sendResponse({ success: false, error: String(error?.message || error) }));
  if (request.action === 'toggleAutoFill') {
    isAutoFillEnabled = request.enabled;
    window.dispatchEvent(new CustomEvent('claim-autofill:enabled-change', {
      detail: { enabled: isAutoFillEnabled }
    }));
    schedulePassiveAudit([document]);
    sendResponse({ success: true });
  } else if (request.action === 'fillNow') {
    respond(applyFreshPreview(request));
  } else if (request.action === 'preview') {
    respond(createFreshPreview().then(result => ({ ...result, hasUndo: undoBatch.length > 0 })));
  } else if (request.action === 'undo') {
    const count = undoLastFill();
    if (count > 0) {
      sendResponse({ success: true, count });
    } else {
      respond(restorePersistentSnapshot());
    }
  } else if (request.action === 'getStatus') {
    hasPersistentRecovery(hasRecovery => {
      sendResponse({ enabled: isAutoFillEnabled, auditMode, hasUndo: undoBatch.length > 0, hasRecovery });
    });
  } else if (request.action === 'previewInvestigationVerification') {
    const result = previewInvestigationVerification(request.verifiedCounts);
    sendResponse({ success: true, ...result });
  } else if (request.action === 'applyInvestigationVerification') {
    respond(applyInvestigationVerification(request.token));
  }
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'investigation-checklist') return;
  port.onMessage.addListener(message => {
    const respond = result => port.postMessage({ id: message?.id, success: true, ...result });
    if (message?.action === 'getChecklist') {
      respond({ items: getInvestigationChecklist().map(({ index, label, expected }) => ({ index, label, expected })) });
    } else if (message?.action === 'preview') {
      respond(previewInvestigationVerification(message.verifiedCounts));
    } else if (message?.action === 'apply') {
      applyInvestigationVerification(message.token)
        .then(result => respond(result))
        .catch(error => port.postMessage({ id: message.id, success: false, error: String(error?.message || error) }));
    }
  });
});

function refreshProcessingRules() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ action: 'refreshProcessingRules' }, response => {
        if (chrome.runtime.lastError || !response?.success) {
          resolve({ ok: processingRuleSet?.mode !== 'remote-required', error: response?.error || 'network' });
          return;
        }
        const normalized = ProcessingRules?.normalizeRuleSet(response.ruleSet);
        if (!normalized || normalized.errors.length) {
          resolve({ ok: false, error: 'invalid-processing-rule-set' });
          return;
        }
        processingRuleSet = { ...response.ruleSet, rules: normalized.rules };
        resolve({ ok: true });
      });
    } catch {
      resolve({ ok: processingRuleSet?.mode !== 'remote-required', error: 'network' });
    }
  });
}

async function createFreshPreview() {
  const refresh = await refreshProcessingRules();
  if (!refresh.ok) return formatPreview(blockedFillResult('processing-rules-unavailable', [refresh.error]));
  return createReviewedPreview();
}

async function applyFreshPreview(options) {
  const previewVersion = lastPreview?.ruleSetVersion || '';
  const refresh = await refreshProcessingRules();
  if (!refresh.ok) return blockedFillResult('processing-rules-unavailable', [refresh.error]);
  if (previewVersion !== (processingRuleSet?.versionId || '')) return blockedFillResult('processing-rules-changed');
  return finalizeRecovery(await applyReviewedPreview(options));
}

// Helper to find any editable element inside a cell
function findEditableElement(cell) {
  if (!cell) return null;

  if (cell.matches?.('input[type="text"], input[type="number"], input:not([type]), textarea, select, [contenteditable="true"], [contenteditable=""]')) {
    return cell;
  }

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
  // Some portal totals only recompute on keyup/blur handlers rather than
  // input/change (older AngularJS/jQuery binding patterns). blur does not
  // natively bubble, so focusout (its bubbling equivalent) covers listeners
  // attached higher up the DOM as well as directly on the field.
  el.dispatchEvent(new Event('keyup', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.dispatchEvent(new Event('focusout', { bubbles: true }));
}

// Set value on a cell or its editable child
function setCellValue(cell, value, batch) {
  const editableEl = findEditableElement(cell);
  if (editableEl) {
    const entry = { element: editableEl, value: getElementValue(editableEl), after: String(value) };
    batch.push(entry);
    setElementValue(editableEl, value);
  } else {
    batch.push({ element: cell, value: cell.textContent, after: String(value) });
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
        claimTotal: labels.findIndex(text => text.includes('claim') && text.includes('total')),
        quantity: labels.findIndex(text => text === 'quantity' || text.startsWith('quantity ')),
        p25: labels.findIndex(text => /\bp\s*25\b/i.test(text)),
        approved: labels.findIndex(text => (text.includes('approved') || text.includes('sanctioned')) && (text.includes('amount') || text.includes('amt'))),
        remarks: labels.findIndex(text => text === 'remarks' || text === 'remark')
      };
      if (candidate.claim >= 0 && candidate.approved >= 0) {
        header = row;
        indices = candidate;
        break;
      }
    }

    const controls = [...table.querySelectorAll(APPROVED_CONTROL_SELECTOR)];
    let mappedApprovedControls = 0;
    let invalidMappings = 0;
    if (header && indices) {
      const headerCellCount = header.querySelectorAll('th, td').length;
      for (const control of controls) {
        const row = control.closest('tr');
        const cells = row ? [...row.querySelectorAll('td, th')] : [];
        const approvedControlIdx = cells.findIndex(cell => cell.contains(control));
        const mappedClaimIdx = location.pathname.startsWith('/RGHS/tpaPharmacy')
          ? indices.claimTotal
          : indices.claim;
        const resolved = Core.resolveRowColumnIndices({
          cellCount: cells.length,
          headerCellCount,
          particularIdx: indices.particular,
          claimIdx: mappedClaimIdx,
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
      hasPharmacyHeaders: Boolean(header && indices && indices.claimTotal >= 0 && indices.quantity >= 0 && indices.p25 >= 0),
      dataRows: controls.length,
      approvedControls: controls.length,
      mappedApprovedControls,
      invalidMappings
    };
  });
  return { ...Core.validatePortalLayoutDescriptor({ pathname: location.pathname, tables }), tables };
}

function getPortalCompatibilityDetails() {
  const layout = inspectPortalLayout();
  const compatibleTables = layout.tables.filter(table => table.hasRequiredHeaders && table.approvedControls > 0).length;
  const pageType = location.pathname.startsWith('/RGHS/processSheetSearch/') ? 'Process sheet'
    : location.pathname.startsWith('/RGHS/tpaPharmacy') ? 'Pharmacy claim'
      : isOpdClaimPage() ? 'OPD claim' : 'IPD claim';
  const reasons = {
    'expected-one-claim-table': 'Exactly one mapped claim table is required.',
    'missing-claim-rows': 'The mapped claim table has no writable claim rows.',
    'unmapped-claim-controls': 'One or more approved-amount controls could not be mapped safely.'
  };
  return {
    pageType,
    compatible: layout.ok,
    message: layout.ok ? `${pageType}: compatible (${compatibleTables} mapped claim table).`
      : `${pageType}: not compatible — ${reasons[layout.reason] || 'Required claim fields are unavailable.'}`,
    tableCount: layout.tables.length,
    compatibleTables
  };
}

// Preview stays local-first: a fresh install or signed-out session (state
// is null) never blocks preview, only a real Apply requires a signed-in,
// licensed session. Once signed in, previewAllowed can still gate Preview
// for hard-blocked states (expired/suspended/unlicensed).
function evaluateLicenceGate(state, apply) {
  if (!state) return apply ? { blocked: true, reason: 'signed-out' } : { blocked: false };
  if (state.status === 'update-required') return { blocked: true, reason: 'update-required' };
  if (state.status === 'maintenance') return { blocked: true, reason: 'maintenance' };
  if (apply && state.applyAllowed !== true) {
    return { blocked: true, reason: state.status === 'unverified' ? 'licence-unverified' : 'licence-apply-blocked' };
  }
  if (!apply && state.previewAllowed !== true) {
    return { blocked: true, reason: 'licence-preview-blocked' };
  }
  return { blocked: false };
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
function fillAllApprovedAmounts({ apply = true, roots = [document], selectedRowKeys = null, approvedOverrides = {}, remarkOverrides = {} } = {}) {
  if (!isAutoFillEnabled && apply) {
    return blockedFillResult('autofill-disabled');
  }

  const licenceGate = evaluateLicenceGate(licenceState, apply);
  if (licenceGate.blocked) return blockedFillResult(licenceGate.reason);

  const isPharmacyPage = location.pathname.startsWith('/RGHS/tpaPharmacy');
  const bundledFallbackEnabled = processingRuleSet?.mode !== 'remote-required'
    || processingRuleSet.bundledFallbackEnabled !== false;
  if (location.pathname.startsWith('/RGHS/processSheetSearch/') || isPharmacyPage) {
    const layout = inspectPortalLayout();
    if (!layout.ok) return blockedFillResult('unsupported-layout', [layout.reason]);
    if (!isPharmacyPage && !ruleSetValidation.ok) {
      return blockedFillResult('invalid-rule-set', ruleSetValidation.errors);
    }
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
  let processingBlock = null;
  const processingWarnings = [];
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
    let quantityIdx = -1;
    let dateIdx = -1;
    let claimIdx = -1;
    let claimTotalIdx = -1;
    let p25Idx = -1;
    let approvedIdx = -1;
    let remarksIdx = -1;
    let configuredColumnIndices = {};

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
        if (text === 'quantity' || text.startsWith('quantity ')) {
          quantityIdx = i;
        }
        if (text.includes('date') && !text.includes('update')) {
          dateIdx = i;
        }
        if ((text.includes('claim') && text.includes('amount')) ||
            text.match(/claim.*amt/i) ||
            (text.includes('payable') && text.includes('amount'))) {
          claimIdx = i;
        }
        if (text.includes('claim') && text.includes('total')) {
          claimTotalIdx = i;
        }
        if (/\bp\s*25\b/i.test(text)) {
          p25Idx = i;
        }
        if ((text.includes('approved') && text.includes('amount')) ||
            text.match(/approved.*amt/i) ||
            (text.includes('sanctioned') && text.includes('amount'))) {
          approvedIdx = i;
        }
        if (text === 'remarks' || text === 'remark') {
          remarksIdx = i;
        }
        const columnKey = configuredColumnKey(text);
        if (columnKey) configuredColumnIndices[columnKey] = i;
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
        quantityIdx = -1;
        dateIdx = -1;
        claimIdx = -1;
        claimTotalIdx = -1;
        p25Idx = -1;
        approvedIdx = -1;
        remarksIdx = -1;
        configuredColumnIndices = {};
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

      const approvedControl = row.querySelector(APPROVED_CONTROL_SELECTOR);
      const remarksControl = row.querySelector(REMARKS_CONTROL_SELECTOR);
      const approvedControlIdx = approvedControl ? [...cells].findIndex(cell => cell.contains(approvedControl)) : -1;
      const remarksControlIdx = remarksControl ? [...cells].findIndex(cell => cell.contains(remarksControl)) : -1;
      const mappedClaimIdx = isPharmacyPage ? claimTotalIdx : claimIdx;
      const resolved = Core.resolveRowColumnIndices({
        cellCount: cells.length,
        headerCellCount,
        particularIdx,
        claimIdx: mappedClaimIdx,
        approvedIdx,
        remarksIdx,
        approvedControlIdx,
        remarksControlIdx
      });
      const adjClaimIdx = resolved.claimIdx;
      const adjApprovedIdx = resolved.approvedIdx;
      const adjParticularIdx = resolved.particularIdx;
      const adjRemarksIdx = resolved.remarksIdx;
      const offset = adjClaimIdx - mappedClaimIdx;
      const adjPackageIdx = packageIdx !== -1 ? packageIdx + offset : -1;
      const adjRateIdx = rateIdx !== -1 ? rateIdx + offset : -1;
      const adjUnitIdx = unitIdx !== -1 ? unitIdx + offset : -1;
      const adjQuantityIdx = quantityIdx !== -1 ? quantityIdx + offset : -1;
      const adjDateIdx = dateIdx !== -1 ? dateIdx + offset : -1;
      const adjP25Idx = p25Idx !== -1 ? p25Idx + offset : -1;
      const targetCells = {};
      for (const [columnKey, columnIndex] of Object.entries(configuredColumnIndices)) {
        const adjustedIndex = columnIndex + offset;
        if (adjustedIndex >= 0 && adjustedIndex < cells.length) targetCells[columnKey] = cells[adjustedIndex];
      }

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
      const quantityValue = adjQuantityIdx !== -1 && adjQuantityIdx < cells.length ? getCellValue(cells[adjQuantityIdx]) : '';
      const dateValue = adjDateIdx !== -1 && adjDateIdx < cells.length ? getCellValue(cells[adjDateIdx]) : '';
      const p25Value = adjP25Idx !== -1 && adjP25Idx < cells.length ? getCellValue(cells[adjP25Idx]) : '';
      const remarksCell = adjRemarksIdx !== -1 && adjRemarksIdx < cells.length ? cells[adjRemarksIdx] : null;
      if (remarksCell) targetCells.remarks = remarksCell;

      records.push({
        rowEl: row,
        index: dataRowNum,
        claimCell,
        approvedCell,
        remarksCell,
        targetCells,
        claimValue: getCellValue(claimCell),
        approvedValue: getCellValue(approvedCell),
        investigationVerificationApplied: approvedCell.dataset.claimExtensionInvestigationVerified === 'true',
        particularText,
        packageText,
        rateValue,
        unitValue,
        quantityValue,
        dateValue,
        p25Value,
        remarksValue: remarksCell ? getCellValue(remarksCell) : ''
      });
    }

    // Second pass: audit for unbundling/duplicates before any auto-fill
    const auditedRows = new Set();
    if (processingRuleSet?.mode === 'remote-required' && ProcessingRules && records.length > 0) {
      const evaluation = ProcessingRules.evaluate(processingRuleSet, records.map(record => ({
        index: record.index,
        particularText: record.particularText,
        packageText: record.packageText,
        claimValue: record.claimValue,
        approvedValue: record.approvedValue
      })), processingAreaForPage());
      if (!evaluation.ok) {
        processingBlock = { reason: 'invalid-processing-rule-set', details: evaluation.errors };
        return;
      }
      if (evaluation.blocked) {
        processingBlock = {
          reason: evaluation.validations.length ? 'processing-validation-required' : 'processing-rule-blocked',
          details: [...evaluation.blockMessages, ...evaluation.validations].map(item => `${item.ruleId}: ${item.message}`)
        };
        return;
      }
      processingWarnings.push(...evaluation.warnings);
      for (const action of evaluation.rowActions) {
        const record = records.find(item => item.index === action.rowIndex);
        if (!record) continue;
        const missingColumn = Object.keys(action.remarks).find(columnKey => !record.targetCells[columnKey]);
        if (missingColumn) {
          processingBlock = {
            reason: 'processing-rule-target-missing',
            details: [`${action.ruleIds.join(', ')}: ${missingColumn}`]
          };
          return;
        }
        auditedRows.add(record.index);
        const key = `table-${tableIndex}-row-${record.index}`;
        const beforeApproved = Core.parseAmount(record.approvedValue) || 0;
        const generatedRemarks = Object.values(action.remarks).filter(Boolean);
        const existingRemark = record.remarksValue ? `${record.remarksValue}; ` : '';
        proposals.push({
          key,
          tableIndex,
          rowIndex: record.index,
          label: record.particularText.trim() || record.packageText.trim() || `Row ${record.index}`,
          packageText: record.packageText.trim(),
          claimAmount: Core.parseAmount(record.claimValue) || 0,
          beforeApproved,
          proposedApproved: action.proposedApproved,
          beforeRemarks: record.remarksValue,
          proposedRemarks: generatedRemarks.length ? existingRemark + generatedRemarks.join('; ') : null,
          targetRemarks: action.remarks,
          remarkModes: action.remarkModes,
          risk: action.enforcement === 'advisory' ? 'high' : 'medium',
          enforcement: action.enforcement,
          mandatory: action.enforcement === 'mandatory',
          reason: `Centrally governed rule${action.ruleIds.length === 1 ? '' : 's'}: ${action.ruleIds.join(', ')}`,
          ruleIds: action.ruleIds
        });
        rowElements.set(key, record.rowEl);
        if (!apply || selectedRowKeys && !selectedRowKeys.has(key)) continue;
        setCellValue(record.approvedCell, String(action.proposedApproved), batch);
        approvedCount++;
        for (const [columnKey, remark] of Object.entries(action.remarks)) {
          if (!remark) continue;
          const cell = record.targetCells[columnKey];
          const existing = getCellValue(cell);
          const next = action.remarkModes[columnKey] === 'replace' || !existing ? remark : `${existing}; ${remark}`;
          setCellValue(cell, next, batch);
          remarksCount++;
        }
        attachFeedbackControls(record, action.ruleIds, {
          url: location.href,
          tid: findTid(),
          mode: 'centrally-governed'
        });
      }
    }
    const supportsPackageAudit = !isPharmacyPage && bundledFallbackEnabled;
    if (supportsPackageAudit && Audit && AuditRules && auditMode !== 'off' && records.length > 0) {
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
      const centrallyGoverned = processingRuleSet?.mode === 'remote-required';
      const editableRules = !centrallyGoverned && globalThis.RGHSCustomRules
        ? globalThis.RGHSCustomRules.mergeRuleSet(AuditRules, customRuleConfig)
        : AuditRules;
      const effectiveRules = Audit.applyRuleOverrides(editableRules, centrallyGoverned ? {} : ruleOverrides);
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
        if (auditedRows.has(rowIndex)) continue;
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
          action.finding?.duplicateRows?.some(row => row.index === record.index) ||
          (action.finding?.type === 'COMBINED_AVAILABLE' && action.finding?.rows?.includes(record.index)));
        let recommendedApproved = null;
        if (primaryFinding?.type === 'UNBUNDLING_FIXED') {
          recommendedApproved = isMain
            ? Math.max(0, (Core.parseAmount(record.claimValue) || 0) - primaryFinding.fixedDeduction.amount)
            : Core.parseAmount(record.claimValue) || 0;
        } else if (primaryFinding?.type === 'UNBUNDLING') {
          recommendedApproved = isMain ? Core.parseAmount(record.claimValue) || 0 : 0;
        } else if (primaryFinding?.type === 'DUPLICATE') {
          recommendedApproved = isPrimary ? Core.parseAmount(record.claimValue) || 0 : 0;
        } else if (primaryFinding?.type === 'COMBINED_AVAILABLE') {
          // No single row anchors a combined-package finding - every matched
          // component is an equal candidate for the reviewer to zero out or keep.
          recommendedApproved = 0;
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
          decisionRemarks: primaryFinding ? {
            approved: Audit.formatRemark(primaryFinding, 'approved', record.index),
            deducted: Audit.formatRemark(primaryFinding, 'deduct', record.index),
            rejected: Audit.formatRemark(primaryFinding, 'rejected', record.index),
            hold: Audit.formatRemark(primaryFinding, 'flag', record.index)
          } : {},
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

        const hasRemarkOverride = Object.prototype.hasOwnProperty.call(remarkOverrides, key);
        const appliedRemark = hasRemarkOverride ? String(remarkOverrides[key] || '').trim() : remarkTexts.join('; ');
        if (record.remarksCell && appliedRemark && apply) {
          setCellValue(record.remarksCell, existing + appliedRemark, batch);
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

    const ipdContext = !isPharmacyPage && ipdClaimDetailContext.tid === findTid()
      ? ipdClaimDetailContext : null;
    const completed24HourIntervals = ipdContext
      ? Core.calculateCompleted24HourIntervals(ipdContext) : null;
    const multipleSurgicalPlans = new Map(Core.planMultipleSurgicalPackageUpdates({
      lines: records,
      finalPackageCodes: ipdContext?.finalPackageCodes || []
    }).map(plan => [plan.index, plan]));

    // Third pass: normal auto-fill, never touching audited rows
    for (const record of records) {
      if (auditedRows.has(record.index)) continue;
      // A processor-confirmed investigation count is authoritative for this open
      // process sheet, including a verified zero. Do not replace it with the
      // claimed amount during a later general preview.
      if (record.investigationVerificationApplied) continue;

      const lamaDamaPlan = ipdContext
        ? Core.planLamaDamaSurgicalPackageUpdate({
            claimValue: record.claimValue,
            approvedValue: record.approvedValue,
            particularText: record.particularText,
            packageText: record.packageText,
            dischargeStatus: ipdContext.dischargeStatus,
            remarksValue: record.remarksValue
          })
        : null;
      const incompleteDailyPlan = ipdContext
        ? Core.planIncompleteFinalDayUpdate({
            claimValue: record.claimValue,
            rateValue: record.rateValue,
            unitValue: record.unitValue,
            approvedValue: record.approvedValue,
            particularText: record.particularText,
            packageText: record.packageText,
            admissionType: ipdContext.admissionType,
            completed24HourIntervals,
            remarksValue: record.remarksValue
          })
        : null;
      const multipleSurgicalPlan = multipleSurgicalPlans.get(record.index) || null;
      const plan = lamaDamaPlan?.reason === 'lama-dama-surgical'
        ? lamaDamaPlan
        : incompleteDailyPlan?.reason === 'incomplete-daily-ipd'
          ? incompleteDailyPlan
          : multipleSurgicalPlan?.reason === 'multiple-surgical-package'
            ? multipleSurgicalPlan
        : !bundledFallbackEnabled
        ? Core.planRowUpdate({
            claimValue: record.claimValue,
            approvedValue: record.approvedValue,
            particularText: '',
            remarksValue: record.remarksValue
          })
        : isPharmacyPage
        ? Core.planPharmacyRowUpdate({
            claimTotalValue: record.claimValue,
            p25Value: record.p25Value,
            quantityValue: record.quantityValue,
            approvedValue: record.approvedValue,
            remarksValue: record.remarksValue
          })
        : Core.planRowUpdate({
            claimValue: record.claimValue,
            approvedValue: record.approvedValue,
            particularText: record.particularText,
            remarksValue: record.remarksValue
          });

      if (plan.reason === 'invalid-or-zero-claim' || plan.reason === 'invalid-pharmacy-values') continue;

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
          risk: ['lama-dama-surgical', 'incomplete-daily-ipd', 'multiple-surgical-package'].includes(plan.reason) ? 'high'
            : plan.reason === 'medicine' || plan.reason === 'pharmacy-market-cap' ? 'medium' : 'low',
          policyBadge: plan.reason === 'lama-dama-surgical'
            ? `LAMA/DAMA detected · Source: Patient Discharge Status · ${Core.LAMA_DAMA_SURGICAL_PERCENT}% SOP`
            : plan.reason === 'incomplete-daily-ipd'
              ? `Incomplete final IPD day · ${completed24HourIntervals} completed 24-hour interval(s)`
              : plan.reason === 'multiple-surgical-package'
                ? `Multiple surgical packages · Portal-confirmed package set · Main (highest claimed): ${plan.mainPackageCode || 'unavailable'} · ${plan.decisionRole}`
                : '',
          requiresAcknowledgement: ['lama-dama-surgical', 'incomplete-daily-ipd', 'multiple-surgical-package'].includes(plan.reason),
          recommendedApproved: ['lama-dama-surgical', 'incomplete-daily-ipd', 'multiple-surgical-package'].includes(plan.reason)
            ? proposedApproved : undefined,
          decisionRole: plan.decisionRole || undefined,
          reason: plan.reason === 'medicine'
            ? `${Core.DEDUCTION_PERCENT}% RGHS medicine deduction; rounded to nearest whole rupee`
            : plan.reason === 'lama-dama-surgical'
              ? `${Core.LAMA_DAMA_SURGICAL_PERCENT}% of the surgical package for LAMA/DAMA discharge`
              : plan.reason === 'incomplete-daily-ipd'
                ? `Deduct incomplete final IPD day after ${completed24HourIntervals} completed 24-hour interval(s)`
                : plan.reason === 'multiple-surgical-package'
                  ? `Multiple surgical package rule: ${plan.decisionRole}; approved at ${plan.percent}%`
            : plan.reason === 'pharmacy-market-cap'
              ? 'Limit the approved amount to P25 multiplied by quantity'
              : plan.reason === 'pharmacy-claim-below-market'
                ? 'Approve the lower Claim Total at the prevailing market price'
                : 'Copy eligible claim amount into the empty approved amount',
          ruleIds: plan.reason === 'medicine' ? ['RGHS-MEDICINE-12']
            : plan.reason === 'lama-dama-surgical' ? ['RGHS-IPD-LAMA-DAMA-75']
              : plan.reason === 'incomplete-daily-ipd' ? ['RGHS-IPD-INCOMPLETE-FINAL-DAY']
                : plan.reason === 'multiple-surgical-package' ? ['RGHS-IPD-MULTIPLE-SURGICAL'] : []
        });
        rowElements.set(key, record.rowEl);
        if (apply && selectedRowKeys && !selectedRowKeys.has(key)) continue;
      }

      // Apply the row plan. Hospital plans preserve existing nonzero approvals;
      // Pharmacy plans intentionally replace the portal's prefilled claim total.
      if (plan.approvedValue !== null) {
        if (apply) setCellValue(record.approvedCell, plan.approvedValue, batch);
        approvedCount++;
        debugLog(`[Claim Auto-Fill] Row ${record.index}: Planned approved amount "${plan.approvedValue}"`);
      }

      // Apply any rule-specific remark without touching rows that need none.
      if (record.remarksCell && plan.remarksValue !== null) {
        if (apply) setCellValue(record.remarksCell, plan.remarksValue, batch);
        remarksCount++;
        debugLog(`[Claim Auto-Fill] Row ${record.index}: Planned deduction remark`);
      }
    }

    debugLog(`[Claim Auto-Fill] Processed ${dataRowNum} data rows from table ${tableIndex + 1}`);
  });

  if (processingBlock) return blockedFillResult(processingBlock.reason, processingBlock.details);

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

        const siblings = [...parent.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')];
        const approvedSiblings = siblings.filter(sib => {
          const field = `${sib.name || ''} ${sib.id || ''}`.toLowerCase();
          return field.includes('approved') || field.includes('sanctioned');
        });
        const claimSiblings = siblings.filter(sib => {
          const field = `${sib.name || ''} ${sib.id || ''}`.toLowerCase();
          return field.includes('claim');
        });
        const identity = element => `${element.name || ''} ${element.id || ''}`.toLowerCase()
          .replace(/claim|approved|sanctioned|amount|amt/g, '').replace(/[^a-z0-9]/g, '');
        const inputIdentity = identity(input);
        const candidates = claimSiblings.length === 1 && approvedSiblings.length === 1
          ? approvedSiblings
          : inputIdentity
            ? approvedSiblings.filter(sib => identity(sib) === inputIdentity)
            : [];
        if (candidates.length !== 1) return;
        for (const sib of candidates) {
          const siblingIndex = siblings.indexOf(sib);
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
                const approvedValue = Object.prototype.hasOwnProperty.call(approvedOverrides, key)
                  ? String(approvedOverrides[key])
                  : String(amount);
                batch.push({ element: sib, value: getElementValue(sib), after: approvedValue });
                setElementValue(sib, approvedValue);
              }
              approvedCount++;
            }
        }
      }
    });
  }

  if (apply && batch.length > 0) undoBatch = batch;
  const recoveryWrite = apply && batch.length > 0
    ? persistRecoverySnapshot(batch)
    : Promise.resolve(true);
  if (apply && auditLogEntries.length > 0) appendAuditLog(auditLogEntries);
  const count = approvedCount + remarksCount + auditFlagged + auditDeducted;
  debugLog(`[Claim Auto-Fill] Done. ${apply ? 'Filled' : 'Previewed'} ${approvedCount} approved amount(s), ${remarksCount} remark(s); audit: ${auditDeducted} deducted, ${auditFlagged} flagged`);
  updateAuditBadge(auditFlagged + auditDeducted);
  return {
    count, changedFieldCount: batch.length, approvedCount, remarksCount,
    auditFlagged, auditDeducted, processingWarnings, proposals, rowElements,
    _recoveryWrite: recoveryWrite,
    _undoBatch: batch
  };
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
    processingWarnings: raw.processingWarnings || [],
    proposals: raw.proposals,
    token,
    createdAt,
    ruleSetVersion: processingRuleSet?.versionId || '',
    ruleSetChecksum: processingRuleSet?.checksum || '',
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

function applyReviewedPreview({ token, selectedRowKeys, approvedOverrides = {}, remarkOverrides = {}, acknowledgedHighRisk = false } = {}) {
  const currentRaw = fillAllApprovedAmounts({ apply: false });
  if (currentRaw.blocked) {
    appendClaimActivity('apply-blocked', { blockReason: currentRaw.blockReason });
    return { ...blockedFillResult(currentRaw.blockReason, currentRaw.blockDetails), rowElements: undefined, proposals: undefined };
  }
  const current = formatPreview(currentRaw, lastPreview?.createdAt);
  const selectedKeys = Array.isArray(selectedRowKeys) ? [...new Set(selectedRowKeys)] : [];
  const missingMandatory = current.proposals.some(proposal => proposal.mandatory && !selectedKeys.includes(proposal.key));
  if (missingMandatory) return { blocked: true, blockReason: 'mandatory-action-required', count: 0 };
  const mandatoryRemarkOverride = Object.keys(remarkOverrides).some(key =>
    current.proposals.some(proposal => proposal.key === key && proposal.mandatory));
  if (mandatoryRemarkOverride) return { blocked: true, blockReason: 'mandatory-action-override', count: 0 };
  const invalidOverride = Object.entries(approvedOverrides).some(([key, value]) => {
    const proposal = current.proposals.find(item => item.key === key);
    if (!proposal || !selectedKeys.includes(key)) return true;
    if (proposal.mandatory) return Math.abs(Number(value) - Number(proposal.proposedApproved)) >= 0.005;
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
    approvedOverrides,
    remarkOverrides
  });
  if (result.blocked) {
    appendClaimActivity('apply-blocked', { blockReason: result.blockReason });
    return { ...result, rowElements: undefined, proposals: undefined };
  }
  const ruleIds = [...new Set(selected.flatMap(proposal => proposal.ruleIds || []))];
  lastPreview = null;
  previewRowElements = new Map();
  return {
    ...result,
    proposals: undefined,
    rowElements: undefined,
    blocked: false,
    reconciliation: validation.totals,
    _activityDetails: {
      rowCount: selected.length,
      fieldCount: result.changedFieldCount,
      totals: validation.totals,
      ruleIds
    }
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

function ensurePharmacyValidationStyles() {
  if (document.getElementById('claim-extension-pharmacy-validation-styles')) return;
  const style = document.createElement('style');
  style.id = 'claim-extension-pharmacy-validation-styles';
  style.textContent = [
    '.claim-extension-tablet-highlight { background:#dc2626 !important; color:#fff !important; font-weight:800 !important; border-radius:3px; padding:1px 3px; box-shadow:0 0 0 1px #991b1b; }',
    '.claim-extension-name-mismatch { background:#fecaca !important; color:#991b1b !important; font-weight:800 !important; border-radius:3px; padding:1px 2px; }',
    '.claim-extension-invoice-mismatch { background:#fee2e2 !important; color:#991b1b !important; outline:2px solid #dc2626 !important; outline-offset:2px; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

function removeTextHighlights(root, className) {
  if (!root?.querySelectorAll) return;
  for (const span of root.querySelectorAll(`span.${className}`)) {
    const parent = span.parentNode;
    span.replaceWith(document.createTextNode(span.textContent));
    parent?.normalize?.();
  }
}

function highlightPlainText(element, text, className, title) {
  if (!element || element.childElementCount > 0 || element.querySelector(`span.${className}`)) return false;
  const source = element.textContent;
  const index = source.indexOf(text);
  if (index < 0 || !text) return false;
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  span.title = title;
  element.replaceChildren(
    document.createTextNode(source.slice(0, index)),
    span,
    document.createTextNode(source.slice(index + text.length))
  );
  return true;
}

function findCurrentPatientNameCell() {
  const table = document.getElementById('patiendetailtable');
  if (!table) return null;
  const header = [...table.querySelectorAll('tr')].find(row =>
    [...row.querySelectorAll('th, td')].some(cell => cell.textContent.trim().toLowerCase() === 'patient name'));
  if (!header) return null;
  const labels = [...header.querySelectorAll('th, td')].map(cell => cell.textContent.trim().toLowerCase());
  const nameIndex = labels.indexOf('patient name');
  const transactionIndex = labels.findIndex(label => label === 'transaction id');
  const activeTransaction = String(document.getElementById('transid')?.value || '').replace(/\W/g, '');
  const rows = [...table.querySelectorAll('tbody tr')].filter(row => row !== header);
  const row = rows.find(candidate => {
    if (!activeTransaction || transactionIndex < 0) return false;
    const cells = [...candidate.querySelectorAll(':scope > td, :scope > th')];
    return String(cells[transactionIndex]?.textContent || '').replace(/\W/g, '') === activeTransaction;
  }) || (rows.length === 1 ? rows[0] : null);
  const cells = row ? [...row.querySelectorAll(':scope > td, :scope > th')] : [];
  const cell = cells[nameIndex];
  const value = cell?.textContent?.trim() || '';
  return cell && value ? { cell, value } : null;
}

function findInvoiceValidationDescriptor() {
  const links = [...document.querySelectorAll('a[onclick*="openInvoicePopUp"]')];
  const link = links.find(element => element.getClientRects().length > 0) || links[0];
  const match = link?.getAttribute('onclick')?.match(/openInvoicePopUp\(\s*['"]?(\d+)/i);
  return match ? { key: match[1], link } : null;
}

function extractInvoicePatientEntries(root) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll('td.header-col-3-left, td, div, p')].flatMap(cell => {
    const match = cell.textContent.match(/^\s*patient(?:\s+name)?\s*:\s*([^\r\n]+?)\s*$/i);
    return match?.[1]?.trim() ? [{ cell, value: match[1].trim() }] : [];
  });
}

function clearPatientMismatchHighlights() {
  removeTextHighlights(document, 'claim-extension-name-mismatch');
  for (const link of document.querySelectorAll('.claim-extension-invoice-mismatch')) {
    link.classList.remove('claim-extension-invoice-mismatch');
    link.removeAttribute('data-claim-extension-name-mismatch');
    if (link.title === 'Patient name differs from Patient Data') link.removeAttribute('title');
  }
}

function applyPatientNameValidation(descriptor) {
  const patient = findCurrentPatientNameCell();
  if (!patient || !descriptor || invoicePatientValidation.key !== descriptor.key
      || invoicePatientValidation.names.length === 0) return;

  clearPatientMismatchHighlights();
  const mismatch = Core.hasPatientNameMismatch(patient.value, invoicePatientValidation.names);
  if (!mismatch) {
    clearPatientMismatchHighlights();
    return;
  }

  ensurePharmacyValidationStyles();
  highlightPlainText(patient.cell, patient.value, 'claim-extension-name-mismatch',
    'Patient name differs from the invoice');
  descriptor.link.classList.add('claim-extension-invoice-mismatch');
  descriptor.link.dataset.claimExtensionNameMismatch = 'true';
  descriptor.link.title = 'Patient name differs from Patient Data';

  for (const entry of extractInvoicePatientEntries(document.getElementById('invoicedtls'))) {
    if (Core.patientNamesMatch(patient.value, entry.value)) continue;
    highlightPlainText(entry.cell, entry.value, 'claim-extension-name-mismatch',
      'Invoice patient name differs from Patient Data');
  }
}

function requestInvoicePatientValidation(descriptor) {
  if (!descriptor) return;
  if (invoicePatientValidation.key !== descriptor.key) {
    clearPatientMismatchHighlights();
    invoicePatientValidation = { key: descriptor.key, names: [], loading: false };
  }
  if (invoicePatientValidation.loading || invoicePatientValidation.names.length > 0) {
    applyPatientNameValidation(descriptor);
    return;
  }

  invoicePatientValidation.loading = true;
  const requestKey = descriptor.key;
  const url = new URL('/RGHS/simsinvoiceDoc', location.origin);
  url.searchParams.set('id', requestKey);
  fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then(response => response.ok ? response.text() : Promise.reject(new Error('invoice-request-failed')))
    .then(html => {
      if (html.length > 2 * 1024 * 1024) throw new Error('invoice-response-too-large');
      const parsed = new globalThis.DOMParser().parseFromString(html, 'text/html');
      const names = extractInvoicePatientEntries(parsed).map(entry => entry.value);
      if (invoicePatientValidation.key !== requestKey) return;
      invoicePatientValidation = { key: requestKey, names, loading: false };
      applyPatientNameValidation(findInvoiceValidationDescriptor());
    })
    .catch(() => {
      if (invoicePatientValidation.key === requestKey) {
        invoicePatientValidation = { key: requestKey, names: [], loading: false };
      }
    });
}

function refreshPharmacyValidations() {
  if (!location.pathname.startsWith('/RGHS/tpaPharmacy')) return;
  if (!isAutoFillEnabled) {
    removeTextHighlights(document, 'claim-extension-tablet-highlight');
    clearPatientMismatchHighlights();
    return;
  }

  ensurePharmacyValidationStyles();
  for (const cell of document.querySelectorAll('#processSheetTable [id^="particular_"]')) {
    const drugName = Core.getTabletOneByOneDrugName(cell.textContent);
    if (drugName) {
      highlightPlainText(cell, drugName, 'claim-extension-tablet-highlight',
        'Review tablet packaging for Tab 1×1 dosage');
    } else {
      removeTextHighlights(cell, 'claim-extension-tablet-highlight');
    }
  }

  requestInvoicePatientValidation(findInvoiceValidationDescriptor());
}

function refreshPassiveAuditHighlights() {
  if (!Core.isSupportedClaimPage(location.pathname)) return;
  ensureIpdClaimDetailContext();
  if (location.pathname.startsWith('/RGHS/processSheetSearch/') || isOpdClaimPage()) {
    ensureCardTrackerContext();
  }
  refreshPharmacyValidations();
  publishInvestigationChecklist();
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
  if (!Core.isSupportedClaimPage(location.pathname)) return;
  const observer = new MutationObserver(mutations => {
    const addedNodes = mutations.flatMap(mutation => [...mutation.addedNodes]);
    const changedTextParents = mutations
      .filter(mutation => mutation.type === 'characterData')
      .map(mutation => mutation.target.parentElement)
      .filter(Boolean);
    if (addedNodes.length || changedTextParents.length) schedulePassiveAudit([...addedNodes, ...changedTextParents]);
  });
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  const scheduleFromField = event => {
    const row = event.target?.closest?.('tr') || event.target?.parentElement;
    schedulePassiveAudit([row || document]);
  };
  document.addEventListener('input', scheduleFromField, true);
  document.addEventListener('change', scheduleFromField, true);
  schedulePassiveAudit([document]);
}

function findTid() {
  // Pharmacy claims share one route and replace the selected transaction in
  // place. Read its live hidden identifier on every call so recovery data from
  // a previously opened claim cannot be reused for the next one.
  const pharmacyTid = document.getElementById?.('transid')?.value?.trim();
  if (pharmacyTid) return pharmacyTid;
  const processSheetTid = String(globalThis.location?.pathname || '').match(/^\/RGHS\/processSheetSearch\/([^/?#]+)/i)?.[1];
  if (processSheetTid) return processSheetTid;
  const text = `${document.title} ${(document.body ? document.body.textContent : '').slice(0, 30000)}`;
  // Process sheets label the claim "TID: <code>"; tpaOPD labels it
  // "transaction id [OPD] :-<code>" instead - both need to resolve to a
  // per-claim identifier since only tpaOPD's URL stays fixed across claims.
  const patterns = [
    /\bTID[\s:.#-]*([A-Z0-9][A-Z0-9/-]{3,19})/i,
    /transaction\s*id[^\d]{0,25}(\d{6,20})/i
  ];
  let match = null;
  for (const pattern of patterns) {
    match = text.match(pattern);
    if (match) break;
  }
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
    ruleSetVersion: processingRuleSet?.versionId || AuditRules?.version || '',
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
  if (verdict === 'dismissed' && processingRuleSet?.versionId) {
    for (const ruleId of ruleIds) {
      chrome.runtime.sendMessage({
        action: 'submitProcessingRuleFeedback',
        data: {
          ruleId,
          ruleSetVersion: processingRuleSet.versionId,
          category: 'rule_triggered_incorrectly',
          processingArea: processingAreaForPage(),
          packageCodes: []
        }
      }, () => { void chrome.runtime.lastError; });
    }
  }
}

function appendAuditLog(entries) {
  appendStorageEntries('rghsAuditLog', Audit.dedupeLogEntries([], entries));
}

function persistRecoverySnapshot(batch) {
  const entries = batch
    .filter(item => item.element?.id)
    .map(item => ({ id: item.element.id, before: String(item.value ?? ''), after: getElementValue(item.element) }));
  if (!entries.length || entries.length !== batch.length) return Promise.resolve(false);

  const snapshot = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: Date.now(),
    tid: findTid(),
    url: location.href,
    version: chrome.runtime.getManifest().version,
    entries
  };
  return appendStorageEntries('claimRecoverySnapshots', [snapshot]);
}

async function finalizeRecovery(result) {
  const {
    _recoveryWrite: recoveryWrite = Promise.resolve(true),
    _undoBatch: resultUndoBatch = [],
    _activityDetails: activityDetails = null,
    ...publicResult
  } = result || {};
  if (publicResult.blocked || publicResult.changedFieldCount === 0) return publicResult;
  const recoverySaved = await recoveryWrite;
  if (recoverySaved) {
    if (activityDetails) appendClaimActivity('apply', activityDetails);
    return { ...publicResult, recoverySaved: true };
  }
  if (undoBatch === resultUndoBatch) undoBatch = [];
  const restored = restoreFillBatch(resultUndoBatch, { removeRecovery: false });
  appendClaimActivity('apply-blocked', { blockReason: 'recovery-save-failed' });
  return {
    ...blockedFillResult('recovery-save-failed'),
    changedFieldCount: 0,
    restoredFieldCount: restored,
    recoverySaved: false
  };
}

function getMatchingRecoverySnapshot(callback) {
  chrome.storage.local.get(['claimRecoverySnapshots'], result => {
    const snapshots = Array.isArray(result.claimRecoverySnapshots) ? result.claimRecoverySnapshots : [];
    const activeSnapshots = snapshots.filter(item => Date.now() - item.createdAt <= 24 * 60 * 60 * 1000);
    const tid = findTid();
    // location.href alone identifies the claim on process sheets, but on tpaOPD
    // every claim shares the same URL - matching by URL there would restore a
    // different claim's saved field values onto whatever claim is on screen now.
    // Once a TID is known, it must agree; URL is only trusted when no TID exists.
    const snapshot = [...activeSnapshots].reverse().find(item =>
      tid ? item.tid === tid : item.url === location.href);
    callback(snapshot || null, activeSnapshots);
  });
}

function restorePersistentSnapshot() {
  return new Promise(resolve => {
    getMatchingRecoverySnapshot(snapshot => {
      if (!snapshot) return resolve({ count: 0, hasRecovery: false });
      let count = 0;
      let conflicts = 0;
      for (const entry of snapshot.entries) {
        const element = document.getElementById(entry.id);
        if (!element?.isConnected) continue;
        if (getElementValue(element) !== String(entry.after ?? '')) {
          conflicts++;
          continue;
        }
        setElementValue(element, entry.before);
        count++;
      }
      if (count === 0) return resolve({ count: 0, hasRecovery: true });
      const fullyRestored = count === snapshot.entries.length;
      if (fullyRestored) {
        queueStorageMutation({ action: 'removeRecoverySnapshot', id: snapshot.id });
      }
      appendClaimActivity('restore', { fieldCount: count });
      resolve({ count, conflicts, hasRecovery: !fullyRestored });
    });
  });
}

function hasPersistentRecovery(callback) {
  getMatchingRecoverySnapshot(snapshot => callback(Boolean(snapshot)));
}

function restoreFillBatch(batch, { removeRecovery = true } = {}) {
  let count = 0;
  for (let index = batch.length - 1; index >= 0; index--) {
    const element = batch[index].element;
    if (!element?.isConnected) continue;
    if (getElementValue(element) !== String(batch[index].after ?? '')) continue;
    setElementValue(element, batch[index].value);
    count++;
  }
  if (count > 0) {
    appendClaimActivity('undo', { fieldCount: count });
    if (removeRecovery && count === batch.length) {
      getMatchingRecoverySnapshot(snapshot => {
        if (snapshot) queueStorageMutation({ action: 'removeRecoverySnapshot', id: snapshot.id });
      });
    }
  }
  return count;
}

function undoLastFill() {
  const batch = undoBatch;
  undoBatch = [];
  return restoreFillBatch(batch);
}

globalThis.ClaimAutoFillActions = {
  preview() {
    const result = createReviewedPreview();
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  async apply(options) {
    const result = await finalizeRecovery(applyReviewedPreview(options));
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  async previewFresh() {
    const result = await createFreshPreview();
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  async applyFresh(options) {
    const result = await applyFreshPreview(options);
    return { ...result, hasUndo: undoBatch.length > 0 };
  },
  undo() {
    const count = undoLastFill();
    return { count, hasUndo: undoBatch.length > 0 };
  },
  status() {
    return { enabled: isAutoFillEnabled, hasUndo: undoBatch.length > 0 };
  },
  getIpdContext() {
    const context = ipdClaimDetailContext;
    return {
      loaded: context.loaded === true,
      admissionType: context.admissionType || '',
      dischargeStatus: context.dischargeStatus || '',
      admissionDate: context.admissionDate || '',
      admissionTime: context.admissionTime || '',
      dischargeDate: context.dischargeDate || '',
      dischargeTime: context.dischargeTime || '',
      completed24HourIntervals: Core.calculateCompleted24HourIntervals(context)
    };
  },
  getCardHistory() {
    return { loaded: cardTrackerContext.loaded === true, cases: cardTrackerContext.cases || [] };
  },
  getBlockedInvestigationHistory() {
    return getBlockedInvestigationHistory();
  },
  getPortalCompatibilityDetails() {
    return getPortalCompatibilityDetails();
  },
  getInvestigationChecklist() {
    const sheetItems = getInvestigationChecklist();
    const items = sheetItems.length ? sheetItems : getMainClaimInvestigationChecklist();
    return items.map(({ index, label, expected, approvedCell }) => ({ index, label, expected, writable: Boolean(approvedCell) }));
  },
  getCurrentTid() {
    return findTid() || ipdClaimDetailContext.tid || '';
  },
  previewInvestigationVerification(verifiedCounts) {
    return previewInvestigationVerification(verifiedCounts);
  },
  applyInvestigationVerification(token) {
    return applyInvestigationVerification(token);
  },
  appendIpdActionRemarks(action, remarks) {
    return appendIpdActionRemarks(action, remarks);
  },
  getReviewDocuments() {
    return getReviewDocuments();
  },
  async getECardSummary() {
    const tid = findTid();
    if (!tid) return { ok: false, entries: [] };
    const response = await fetch('/RGHS/tpaECardDetailbytid', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ id: tid })
    });
    return { ok: response.ok, entries: response.ok ? extractECardSummary(await response.text(), getCurrentCardIdentity().patientName) : [] };
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
  jumpToRows(keys) {
    const rows = [...new Set((Array.isArray(keys) ? keys : []).map(key => previewRowElements.get(key)).filter(Boolean))];
    if (!rows.length) return 0;
    rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    for (const row of rows) {
      const previousOutline = row.style.outline;
      row.style.outline = '3px solid #2563eb';
      setTimeout(() => { row.style.outline = previousOutline; }, 1800);
    }
    return rows.length;
  },
  highlightDecisionRows,
  restoreRecovery() {
    return restorePersistentSnapshot();
  },
  hasRecovery(callback) {
    hasPersistentRecovery(callback);
  }
};

installPassiveAuditObserver();
