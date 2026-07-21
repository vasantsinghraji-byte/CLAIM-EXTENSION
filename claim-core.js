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

  // RGHS claim workflows this extension actively assists with. Passive
  // features (floating widget, passive audit highlights, submit interlock)
  // only arm on these pages; strict process-sheet layout validation stays
  // scoped separately since it relies on that page's specific DOM quirks.
  const SUPPORTED_CLAIM_PATH_PREFIXES = ['/RGHS/processSheetSearch/', '/RGHS/tpaOPD'];

  function isSupportedClaimPage(pathname) {
    const path = String(pathname || '');
    return SUPPORTED_CLAIM_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
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
    if (!String(descriptor.pathname || '').startsWith('/RGHS/processSheetSearch/')) {
      return { ok: true, reason: null };
    }
    const tables = Array.isArray(descriptor.tables) ? descriptor.tables : [];
    const compatible = tables.filter(table => table.hasRequiredHeaders === true && table.approvedControls > 0);
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
    MEDICINE_KEYWORDS,
    parseAmount,
    calculateMedicineApprovedAmount,
    isMedicineRow,
    isEmptyApprovedValue,
    planRowUpdate,
    resolveRowColumnIndices,
    createDebouncedProcessor,
    validatePortalLayoutDescriptor,
    isSupportedClaimPage
  };
});
