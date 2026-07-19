const test = require('node:test');
const assert = require('node:assert/strict');
const runSmoke = require('../scripts/live-browser-smoke');

test('live-browser smoke runs preview, apply, and undo and proves exact restoration', async () => {
  const fields = [
    { id: 'packageFinalAmount_0', name: 'packageFinalAmounts', value: '0' },
    { id: 'packageremarks_0', name: 'packageRemarks', value: '' }
  ];
  const calls = [];
  let hasUndo = false;
  const actions = {
    status: () => ({ enabled: true, hasUndo }),
    preview: () => {
      calls.push('preview');
      return { token: 'safe-token', proposals: [{ key: 'row-0', risk: 'low' }] };
    },
    apply: options => {
      calls.push(['apply', options]);
      fields[0].value = '100';
      hasUndo = true;
      return { blocked: false, count: 1 };
    },
    undo: () => {
      calls.push('undo');
      fields[0].value = '0';
      hasUndo = false;
      return { count: 1 };
    }
  };
  const document = { querySelectorAll: () => fields };

  const result = await runSmoke(actions, document);

  assert.equal(result.passed, true);
  assert.equal(result.submitted, false);
  assert.deepEqual(calls, [
    'preview',
    ['apply', { token: 'safe-token', selectedRowKeys: ['row-0'], acknowledgedHighRisk: false }],
    'undo'
  ]);
});

test('live-browser smoke refuses to run while the extension is off', async () => {
  await assert.rejects(
    runSmoke({ status: () => ({ enabled: false }) }, { querySelectorAll: () => [] }),
    /Extension is OFF/
  );
});
