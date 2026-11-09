(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClaimAutoFillCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MEDICINE_KEYWORDS = [
    'medicine used without extended stay more than 1000',
    'medicine charges during hospitilization period',
    'medicine charges during hospitalization period',
    'final rate for medicine on discharge'
  ];
  const DEDUCTION_REMARK = '12% DEDUCTED AS PER RGHS GUIDELINES';
  const DEDUCTION_PERCENT = 12;
  const PHARMACY_MARKET_PRICE_REMARK = 'Approved As per prevailing market price.';
  const LAMA_DAMA_SURGICAL_PERCENT = 75;
  const LAMA_DAMA_SURGICAL_REMARK = '75% approved for surgical package on LAMA/DAMA discharge as per RGHS SOP.';

  // RGHS claim workflows this extension actively assists with. Passive
  // features (floating widget and passive audit highlights)
  // only arm on these pages; strict process-sheet layout validation stays
  // scoped separately since it relies on that page's specific DOM quirks.
  const SUPPORTED_CLAIM_PATH_PREFIXES = [
    '/RGHS/processSheetSearch/',
    '/RGHS/tpaOPD',
    '/RGHS/tpaPharmacy',
    '/RGHS/tpaClaimDischarge',
    '/RGHS/tpaClaimSettle'
  ];

  function isSupportedClaimPage(pathname) {
    const path = String(pathname || '');
    return SUPPORTED_CLAIM_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
      || /^\/RGHS\/tpa(?:pre.?auth)?OPD/i.test(path)
      || /^\/RGHS\/tpaOPD(?:pre.?auth)?/i.test(path)
      || /^\/RGHS\/tpaClaim(?:Discharge|Settle)/i.test(path);
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

  // RGHS approved amounts are whole rupees. Round to the nearest rupee after deduction.
  function calculateMedicineApprovedAmount(amount) {
    return Math.round(amount * (100 - DEDUCTION_PERCENT) / 100);
  }

  function isMedicineRow(particularText) {
    const text = String(particularText ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return MEDICINE_KEYWORDS.some(keyword => text.includes(keyword));
  }

  function isEmptyApprovedValue(value) {
    const text = String(value ?? '').trim();
    if (!text) return true;
    const amount = parseAmount(text);
    return amount === 0;
  }

  function planRowUpdate({ claimValue, approvedValue, particularText, remarksValue }) {
    const claimAmount = parseAmount(claimValue);
    if (claimAmount === null || claimAmount === 0) {
      return { approvedValue: null, remarksValue: null, reason: 'invalid-or-zero-claim' };
    }

    const medicine = isMedicineRow(particularText);
    const approved = isEmptyApprovedValue(approvedValue)
      ? String(medicine ? calculateMedicineApprovedAmount(claimAmount) : claimAmount)
      : null;
    const remarks = medicine && !String(remarksValue ?? '').toUpperCase().includes('12%')
      ? DEDUCTION_REMARK
      : null;

    return { approvedValue: approved, remarksValue: remarks, reason: medicine ? 'medicine' : 'standard' };
  }

  function planPharmacyRowUpdate({ claimTotalValue, p25Value, quantityValue, approvedValue, remarksValue }) {
    const claimTotal = parseAmount(claimTotalValue);
    const p25 = parseAmount(p25Value);
    const quantity = parseAmount(quantityValue);
    if (claimTotal === null || claimTotal === 0 || p25 === null || p25 === 0
        || quantity === null || quantity === 0) {
      return { approvedValue: null, remarksValue: null, reason: 'invalid-pharmacy-values' };
    }

    const marketPrice = Math.round(p25 * quantity * 100) / 100;
    const approvedAmount = Math.min(claimTotal, marketPrice);
    const currentApproved = parseAmount(approvedValue);
    const approved = currentApproved === approvedAmount ? null : String(approvedAmount);
    const marketPriceCapApplied = marketPrice < claimTotal;
    const existingRemarks = String(remarksValue ?? '').trim();
    const remarks = marketPriceCapApplied
      && !existingRemarks.toLowerCase().includes(PHARMACY_MARKET_PRICE_REMARK.toLowerCase())
      ? `${existingRemarks}${existingRemarks ? '; ' : ''}${PHARMACY_MARKET_PRICE_REMARK}`
      : null;

    return {
      approvedValue: approved,
      remarksValue: remarks,
      reason: marketPriceCapApplied ? 'pharmacy-market-cap' : 'pharmacy-claim-below-market'
    };
  }

  function isLamaDamaDischarge(value) {
    return /\b(?:lama|dama)\b/i.test(String(value ?? ''));
  }

  function isSurgicalPackage(particularText, packageText) {
    return /\b(?:surgical|surgery|operation)\b/i.test(`${particularText ?? ''} ${packageText ?? ''}`);
  }

  function planLamaDamaSurgicalPackageUpdate({
    claimValue,
    approvedValue,
    particularText,
    packageText,
    dischargeStatus,
    remarksValue
  }) {
    const claimAmount = parseAmount(claimValue);
    if (claimAmount === null || claimAmount === 0 || !isLamaDamaDischarge(dischargeStatus)
        || !isSurgicalPackage(particularText, packageText)) {
      return { approvedValue: null, remarksValue: null, reason: 'not-lama-dama-surgical' };
    }

    const approvedAmount = Math.round(claimAmount * LAMA_DAMA_SURGICAL_PERCENT) / 100;
    const currentApproved = parseAmount(approvedValue);
    const existingRemarks = String(remarksValue ?? '').trim();
    const remarkPresent = existingRemarks.toLowerCase().includes('lama/dama')
      && existingRemarks.includes(`${LAMA_DAMA_SURGICAL_PERCENT}%`);
    return {
      approvedValue: currentApproved === approvedAmount ? null : String(approvedAmount),
      remarksValue: remarkPresent ? null : `${existingRemarks}${existingRemarks ? '; ' : ''}${LAMA_DAMA_SURGICAL_REMARK}`,
      reason: 'lama-dama-surgical'
    };
  }

  function parsePortalDateTime(dateValue, timeValue) {
    const date = String(dateValue ?? '').trim();
    const time = String(timeValue ?? '').trim();
    const dateMatch = date.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
      || date.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!dateMatch || !timeMatch) return null;
    const yearFirst = dateMatch[1].length === 4;
    const year = Number(yearFirst ? dateMatch[1] : dateMatch[3]);
    const month = Number(yearFirst ? dateMatch[2] : dateMatch[2]);
    const day = Number(yearFirst ? dateMatch[3] : dateMatch[1]);
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    const second = Number(timeMatch[3] || 0);
    const meridiem = String(timeMatch[4] || '').toUpperCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = hour % 12 + (meridiem === 'PM' ? 12 : 0);
    }
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
    const result = new Date(year, month - 1, day, hour, minute, second);
    return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === day ? result : null;
  }

  function calculateCompleted24HourIntervals({ admissionDate, admissionTime, dischargeDate, dischargeTime }) {
    const admission = parsePortalDateTime(admissionDate, admissionTime);
    const discharge = parsePortalDateTime(dischargeDate, dischargeTime);
    if (!admission || !discharge || discharge <= admission) return null;
    return Math.floor((discharge.getTime() - admission.getTime()) / (24 * 60 * 60 * 1000));
  }

  function isDayCareAdmission(value) {
    return /\bday\s*-?\s*care\b/i.test(String(value ?? ''));
  }

  function isDailyIpdPackage(particularText, packageText) {
    const text = `${particularText ?? ''} ${packageText ?? ''}`;
    return /\bCM[-\s]|medical management|routine ward|general ward|\bICU\b|intensive care|daily package|per day/i.test(text);
  }

  function planIncompleteFinalDayUpdate({
    claimValue, rateValue, unitValue, approvedValue, particularText, packageText,
    admissionType, completed24HourIntervals, remarksValue
  }) {
    const claimed = parseAmount(claimValue);
    const rate = parseAmount(rateValue);
    const billedUnits = parseAmount(unitValue);
    const completed = Number.isInteger(completed24HourIntervals) ? completed24HourIntervals : null;
    if (claimed === null || rate === null || billedUnits === null || completed === null
        || isDayCareAdmission(admissionType) || !isDailyIpdPackage(particularText, packageText)
        || billedUnits <= completed) {
      return { approvedValue: null, remarksValue: null, reason: 'not-incomplete-daily-ipd' };
    }
    const approvedAmount = Math.min(claimed, Math.round(rate * completed * 100) / 100);
    if (approvedAmount >= claimed) {
      return { approvedValue: null, remarksValue: null, reason: 'not-incomplete-daily-ipd' };
    }
    const existingRemarks = String(remarksValue ?? '').trim();
    const remark = `Final incomplete IPD day deducted; ${completed} completed 24-hour interval(s) admissible.`;
    return {
      approvedValue: parseAmount(approvedValue) === approvedAmount ? null : String(approvedAmount),
      remarksValue: existingRemarks.includes('Final incomplete IPD day deducted') ? null : `${existingRemarks}${existingRemarks ? '; ' : ''}${remark}`,
      reason: 'incomplete-daily-ipd'
    };
  }

  function extractPackageCode(packageText) {
    return String(packageText ?? '').trim().match(/^([A-Z0-9]+(?:[-_/][A-Z0-9]+)*)/i)?.[1]?.toUpperCase() || '';
  }

  function planMultipleSurgicalPackageUpdates({ lines, finalPackageCodes }) {
    const portalOrder = new Map((Array.isArray(finalPackageCodes) ? finalPackageCodes : [])
      .map(extractPackageCode).filter(Boolean).map((code, index) => [code, index]));
    const isImplantOrAddOn = line => /\b(?:implant|add[\s-]*on)\b/i.test(`${line.particularText ?? ''} ${line.packageText ?? ''}`);
    const isSurgicalProcedure = line => isSurgicalPackage(line.particularText, line.packageText)
      || /\bprocedure\b/i.test(String(line.particularText ?? ''));
    const surgical = (Array.isArray(lines) ? lines : []).map(line => ({ ...line, code: extractPackageCode(line.packageText) }))
      .filter(line => line.code && portalOrder.has(line.code) && isSurgicalProcedure(line));
    if (surgical.length < 2) return [];
    const rankedProcedures = surgical.filter(line => !isImplantOrAddOn(line)).sort((left, right) => {
      const amountDifference = (parseAmount(right.claimValue) || 0) - (parseAmount(left.claimValue) || 0);
      return amountDifference || portalOrder.get(left.code) - portalOrder.get(right.code) || Number(left.index) - Number(right.index);
    });
    const mainPackageCode = rankedProcedures[0]?.code || '';
    const ranked = [
      ...rankedProcedures.map((line, index) => ({ line, position: index + 1, isImplantOrAddOn: false })),
      ...surgical.filter(isImplantOrAddOn).map(line => ({ line, position: null, isImplantOrAddOn: true }))
    ];
    return ranked.map(({ line, position, isImplantOrAddOn }) => {
      const percent = isImplantOrAddOn ? 100 : position === 1 ? 100 : position === 2 ? 50 : 25;
      const claimAmount = parseAmount(line.claimValue);
      const approvedAmount = claimAmount === null ? null : Math.round(claimAmount * percent) / 100;
      const existingRemarks = String(line.remarksValue ?? '').trim();
      const description = isImplantOrAddOn ? 'Implant/Add-On package' : `procedure ${position}`;
      const remark = `Multiple surgical package rule: ${description} approved at ${percent}% of package amount.`;
      return {
        index: line.index,
        approvedValue: approvedAmount === null || parseAmount(line.approvedValue) === approvedAmount ? null : String(approvedAmount),
        remarksValue: existingRemarks.includes('Multiple surgical package rule:') ? null : `${existingRemarks}${existingRemarks ? '; ' : ''}${remark}`,
        percent,
        position,
        mainPackageCode,
        decisionRole: isImplantOrAddOn ? 'implant/add-on (100%)'
          : position === 1 ? 'main' : position === 2 ? 'second procedure (50%)' : 'third/subsequent procedure (25%)',
        reason: 'multiple-surgical-package'
      };
    });
  }

  function getTabletOneByOneDrugName(value) {
    const text = String(value ?? '');
    const instruction = /\btab(?:let)?\s*1\s*[*x×]\s*1\b/i.exec(text);
    if (!instruction) return null;

    const prefix = text.slice(0, instruction.index);
    if (/\b(?:syp|syrup|inj|injection|cap|capsule|susp|suspension|cream|ointment|gel|drops?|lotion|powder)\b/i.test(prefix)) {
      return null;
    }

    const tabletForm = /\btab(?:let)?\b/i.exec(prefix);
    const end = tabletForm
      ? tabletForm.index + tabletForm[0].length
      : instruction.index + instruction[0].match(/^tab(?:let)?/i)[0].length;
    const drugName = text.slice(0, end).trim();
    return drugName || null;
  }

  function normalizePatientName(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalizeComparablePatientName(value) {
    return normalizePatientName(value)
      .replace(/^(?:patient(?: name)?\s+)?(?:mr|mrs|ms|miss|dr|shri|smt|km)\s+/, '')
      .replace(/^patient(?: name)?\s+/, '')
      .replace(/\s+\d{10,}$/, '');
  }

  function patientNamesMatch(first, second) {
    const normalizedFirst = normalizeComparablePatientName(first);
    const normalizedSecond = normalizeComparablePatientName(second);
    return Boolean(normalizedFirst && normalizedSecond && normalizedFirst === normalizedSecond);
  }

  // An invoice can legitimately repeat the same patient's name in more than
  // one section. Highlight only when none of the extracted invoice names
  // identifies the active patient.
  function hasPatientNameMismatch(patientName, invoiceNames) {
    const names = Array.isArray(invoiceNames) ? invoiceNames : [];
    return names.length > 0 && !names.some(name => patientNamesMatch(patientName, name));
  }

  function resolveRowColumnIndices({
    cellCount,
    headerCellCount,
    particularIdx,
    claimIdx,
    approvedIdx,
    remarksIdx,
    approvedControlIdx = -1,
    remarksControlIdx = -1
  }) {
    // RGHS rows contain hidden leading/trailing cells not represented consistently
    // in the visible header. Anchor to its stable approved input when available.
    const offset = approvedControlIdx >= 0
      ? approvedControlIdx - approvedIdx
      : Math.max(0, cellCount - headerCellCount);

    return {
      particularIdx: particularIdx >= 0 ? particularIdx + offset : -1,
      claimIdx: claimIdx + offset,
      approvedIdx: approvedControlIdx >= 0 ? approvedControlIdx : approvedIdx + offset,
      remarksIdx: remarksControlIdx >= 0 ? remarksControlIdx : remarksIdx >= 0 ? remarksIdx + offset : -1
    };
  }

  function createDebouncedProcessor(process, delay = 300, timers = globalThis) {
    let timer = null;
    let pendingNodes = [];
    return function schedule(nodes) {
      for (const node of nodes) pendingNodes.push(node);
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => {
        timer = null;
        const nodesToProcess = [...new Set(pendingNodes)];
        pendingNodes = [];
        process(nodesToProcess);
      }, delay);
    };
  }

  function validatePortalLayoutDescriptor(descriptor = {}) {
    const pathname = String(descriptor.pathname || '');
    const pharmacy = pathname.startsWith('/RGHS/tpaPharmacy');
    const requiresStrictMapping = pathname.startsWith('/RGHS/processSheetSearch/') || pharmacy;
    if (!requiresStrictMapping) {
      return { ok: true, reason: null };
    }
    const tables = Array.isArray(descriptor.tables) ? descriptor.tables : [];
    const compatible = tables.filter(table => table.hasRequiredHeaders === true
      && (!pharmacy || table.hasPharmacyHeaders === true)
      && table.approvedControls > 0);
    if (compatible.length !== 1) return { ok: false, reason: 'expected-one-claim-table' };
    const table = compatible[0];
    if (table.dataRows < 1) return { ok: false, reason: 'missing-claim-rows' };
    if (table.mappedApprovedControls !== table.approvedControls || table.invalidMappings > 0) {
      return { ok: false, reason: 'unmapped-claim-controls' };
    }
    return { ok: true, reason: null };
  }

  return {
    DEDUCTION_PERCENT,
    DEDUCTION_REMARK,
    PHARMACY_MARKET_PRICE_REMARK,
    LAMA_DAMA_SURGICAL_PERCENT,
    LAMA_DAMA_SURGICAL_REMARK,
    MEDICINE_KEYWORDS,
    parseAmount,
    calculateMedicineApprovedAmount,
    isMedicineRow,
    isEmptyApprovedValue,
    planRowUpdate,
    planPharmacyRowUpdate,
    isLamaDamaDischarge,
    isSurgicalPackage,
    planLamaDamaSurgicalPackageUpdate,
    parsePortalDateTime,
    calculateCompleted24HourIntervals,
    isDayCareAdmission,
    isDailyIpdPackage,
    planIncompleteFinalDayUpdate,
    extractPackageCode,
    planMultipleSurgicalPackageUpdates,
    getTabletOneByOneDrugName,
    normalizePatientName,
    patientNamesMatch,
    hasPatientNameMismatch,
    resolveRowColumnIndices,
    createDebouncedProcessor,
    validatePortalLayoutDescriptor,
    isSupportedClaimPage
  };
});
