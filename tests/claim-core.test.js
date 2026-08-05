const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEDUCTION_REMARK,
  PHARMACY_MARKET_PRICE_REMARK,
  parseAmount,
  calculateMedicineApprovedAmount,
  planRowUpdate,
  planPharmacyRowUpdate,
  getTabletOneByOneDrugName,
  normalizePatientName,
  patientNamesMatch,
  resolveRowColumnIndices,
  createDebouncedProcessor,
  validatePortalLayoutDescriptor,
  isSupportedClaimPage
} = require('../claim-core');

test('RGHS process sheets require exactly one fully mapped claim table', () => {
  const valid = {
    pathname: '/RGHS/processSheetSearch/123/1',
    tables: [{ hasRequiredHeaders: true, dataRows: 2, approvedControls: 2, mappedApprovedControls: 2, invalidMappings: 0 }]
  };
  assert.equal(validatePortalLayoutDescriptor(valid).ok, true);
  assert.equal(validatePortalLayoutDescriptor({ ...valid, tables: [] }).reason, 'expected-one-claim-table');
  assert.equal(validatePortalLayoutDescriptor({
    ...valid,
    tables: [{ ...valid.tables[0], mappedApprovedControls: 1, invalidMappings: 1 }]
  }).reason, 'unmapped-claim-controls');
  assert.equal(validatePortalLayoutDescriptor({ pathname: '/other', tables: [] }).ok, true);
});

test('Pharmacy claims are supported and require a fully mapped claim table', () => {
  const valid = {
    pathname: '/RGHS/tpaPharmacy',
    tables: [{ hasRequiredHeaders: true, hasPharmacyHeaders: true, dataRows: 5, approvedControls: 5, mappedApprovedControls: 5, invalidMappings: 0 }]
  };
  assert.equal(isSupportedClaimPage(valid.pathname), true);
  assert.equal(validatePortalLayoutDescriptor(valid).ok, true);
  assert.equal(validatePortalLayoutDescriptor({ ...valid, tables: [] }).reason, 'expected-one-claim-table');
  assert.equal(validatePortalLayoutDescriptor({
    ...valid,
    tables: [{ ...valid.tables[0], mappedApprovedControls: 4, invalidMappings: 1 }]
  }).reason, 'unmapped-claim-controls');
});

test('live Pharmacy hidden cells map from TPA controls to Claim Total', () => {
  assert.deepEqual(resolveRowColumnIndices({
    cellCount: 24,
    headerCellCount: 23,
    particularIdx: 0,
    claimIdx: 15,
    approvedIdx: 19,
    remarksIdx: 21,
    approvedControlIdx: 20,
    remarksControlIdx: 22
  }), {
    particularIdx: 1,
    claimIdx: 16,
    approvedIdx: 20,
    remarksIdx: 22
  });
});

test('Pharmacy approval is capped at P25 multiplied by quantity', () => {
  assert.deepEqual(planPharmacyRowUpdate({
    claimTotalValue: '12,055.72',
    p25Value: '2922.7',
    quantityValue: '4',
    approvedValue: '12055.7217',
    remarksValue: ''
  }), {
    approvedValue: '11690.8',
    remarksValue: PHARMACY_MARKET_PRICE_REMARK,
    reason: 'pharmacy-market-cap'
  });
});

test('Pharmacy approves the claim total below market price without adding the market-price remark', () => {
  assert.deepEqual(planPharmacyRowUpdate({
    claimTotalValue: '354.24',
    p25Value: '11.81',
    quantityValue: '30',
    approvedValue: '354.239',
    remarksValue: 'Verified invoice'
  }), {
    approvedValue: '354.24',
    remarksValue: null,
    reason: 'pharmacy-claim-below-market'
  });
});

test('Pharmacy appends the market-price remark only once when the P25 cap applies', () => {
  const values = {
    claimTotalValue: '12055.72',
    p25Value: '2922.7',
    quantityValue: '4',
    approvedValue: '12055.7217'
  };
  assert.equal(planPharmacyRowUpdate({ ...values, remarksValue: 'Verified invoice' }).remarksValue,
    `Verified invoice; ${PHARMACY_MARKET_PRICE_REMARK}`);
  assert.equal(planPharmacyRowUpdate({ ...values, remarksValue: PHARMACY_MARKET_PRICE_REMARK }).remarksValue, null);
});

test('Pharmacy ignores missing or zero market-price inputs', () => {
  for (const values of [
    { claimTotalValue: '0', p25Value: '10', quantityValue: '2' },
    { claimTotalValue: '100', p25Value: '0', quantityValue: '2' },
    { claimTotalValue: '100', p25Value: '10', quantityValue: '' }
  ]) {
    assert.deepEqual(planPharmacyRowUpdate({ ...values, approvedValue: '', remarksValue: '' }),
      { approvedValue: null, remarksValue: null, reason: 'invalid-pharmacy-values' });
  }
});

test('Tab 1x1 validation returns only the tablet drug name', () => {
  assert.equal(getTabletOneByOneDrugName('ELTROXIN 125MG TAB FILE – Tab 1×1'), 'ELTROXIN 125MG TAB');
  assert.equal(getTabletOneByOneDrugName('ELTROXIN 125MG Tab 1x1'), 'ELTROXIN 125MG Tab');
  assert.equal(getTabletOneByOneDrugName('THYROXINE 50MCG TABLET FILE Tab 1*1'), 'THYROXINE 50MCG TABLET');
});

test('Tab 1x1 validation excludes non-tablet dosage forms', () => {
  for (const value of [
    'COUGH RELIEF 100ML SYP FILE Tab 1x1',
    'ANTIBIOTIC 1ML INJ FILE Tab 1×1',
    'PAIN RELIEF CAP FILE Tab 1*1',
    'ELTROXIN 125MG TAB FILE Cap 1x1'
  ]) {
    assert.equal(getTabletOneByOneDrugName(value), null);
  }
});

test('patient-name comparison ignores case, spacing, punctuation and accents', () => {
  assert.equal(normalizePatientName('  José   Kumar '), 'jose kumar');
  assert.equal(patientNamesMatch('REKHA  SHARMA', 'Rekha Sharma'), true);
  assert.equal(patientNamesMatch('A. K. Sharma', 'a k sharma'), true);
  assert.equal(patientNamesMatch('Rekha Sharma', 'Rekha Verma'), false);
  assert.equal(patientNamesMatch('', ''), false);
});

test('normal row writes a normalized portal-safe amount', () => {
  assert.deepEqual(planRowUpdate({ claimValue: '1,250.50', approvedValue: '', particularText: 'Investigation', remarksValue: '' }),
    { approvedValue: '1250.5', remarksValue: null, reason: 'standard' });
  assert.deepEqual(planRowUpdate({ claimValue: '1,23,450.00', approvedValue: '0', particularText: 'Procedure', remarksValue: '' }),
    { approvedValue: '123450', remarksValue: null, reason: 'standard' });
  assert.deepEqual(planRowUpdate({ claimValue: '12,345.67', approvedValue: '', particularText: 'Investigation', remarksValue: '' }),
    { approvedValue: '12345.67', remarksValue: null, reason: 'standard' });
});

test('medicine row deducts 12 percent and rounds to nearest whole rupee', () => {
  assert.equal(calculateMedicineApprovedAmount(1000.5), 880);
  assert.deepEqual(planRowUpdate({ claimValue: '₹1,001', approvedValue: '0.00', particularText: 'Medicine charges during hospitalization period', remarksValue: '' }),
    { approvedValue: '881', remarksValue: DEDUCTION_REMARK, reason: 'medicine' });
});

test('existing approved amount is preserved while a missing medicine remark is planned', () => {
  assert.deepEqual(planRowUpdate({ claimValue: '1000', approvedValue: '875', particularText: 'Final rate for medicine on discharge', remarksValue: '' }),
    { approvedValue: null, remarksValue: DEDUCTION_REMARK, reason: 'medicine' });
});

test('existing 12 percent remark is preserved', () => {
  assert.deepEqual(planRowUpdate({ claimValue: '1000', approvedValue: '0', particularText: 'Medicine used without extended stay more than 1000', remarksValue: 'Already 12% deducted' }),
    { approvedValue: '880', remarksValue: null, reason: 'medicine' });
});

test('malformed, negative, empty, and zero amounts are rejected', () => {
  for (const value of ['abc', '12.3.4', '-10', '', '0']) {
    assert.equal(planRowUpdate({ claimValue: value, approvedValue: '', particularText: '', remarksValue: '' }).approvedValue, null);
  }
  assert.equal(parseAmount('₹1,23,456.78'), 123456.78);
});

test('dynamic row processing is debounced without dropping earlier row batches', () => {
  const callbacks = new Map();
  let nextId = 0;
  const timers = {
    setTimeout(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
    clearTimeout(id) { callbacks.delete(id); }
  };
  const processed = [];
  const schedule = createDebouncedProcessor(nodes => processed.push(nodes), 300, timers);
  schedule(['old-row']);
  schedule(['new-row']);
  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assert.deepEqual(processed, [['old-row', 'new-row']]);
});

test('debounced processing accepts bulk mutation batches without spread-argument overflow', () => {
  let callback;
  const timers = {
    setTimeout(next) { callback = next; return 1; },
    clearTimeout() {}
  };
  let processedCount = 0;
  const schedule = createDebouncedProcessor(nodes => { processedCount = nodes.length; }, 300, timers);
  const bulkNodes = Array.from({ length: 200000 }, (_, index) => ({ index }));
  assert.doesNotThrow(() => schedule(bulkNodes));
  callback();
  assert.equal(processedCount, bulkNodes.length);
});

test('live RGHS hidden cells are mapped from the approved-input anchor', () => {
  assert.deepEqual(resolveRowColumnIndices({
    cellCount: 10,
    headerCellCount: 9,
    particularIdx: 0,
    claimIdx: 4,
    approvedIdx: 5,
    remarksIdx: 7,
    approvedControlIdx: 6,
    remarksControlIdx: 8
  }), {
    particularIdx: 1,
    claimIdx: 5,
    approvedIdx: 6,
    remarksIdx: 8
  });
});
