const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEDUCTION_REMARK,
  parseAmount,
  calculateMedicineApprovedAmount,
  planRowUpdate,
  resolveRowColumnIndices,
  createDebouncedProcessor,
  validatePortalLayoutDescriptor
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
