'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Core = require('../claim-core');
const { createSerializedStorageWriter } = require('../background');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));

function setup() {
  const elements = new Map([['a', { id: 'a', value: '900', dataset: {}, isConnected: true }],
    ['b', { id: 'b', value: '800', dataset: {}, isConnected: true }]]);
  const snapshot = { id: 'saved', tid: 'CLAIM-A', url: 'https://example.invalid/RGHS/tpaPharmacy',
    createdAt: Date.now(), entries: [{ id: 'a', before: '400', after: '900' }, { id: 'b', before: '300', after: '800' }] };
  const data = { claimRecoverySnapshots: [snapshot] };
  const storage = { get: (keys, cb) => cb(data), set: (value, cb) => { Object.assign(data, value); cb(); } };
  const writer = createSerializedStorageWriter(storage);
  const pending = [];
  const c = vm.createContext({ Core, tid: 'CLAIM-A', undoBatch: [], chrome: { storage: { local: storage } },
    location: { href: snapshot.url, pathname: '/RGHS/tpaPharmacy' },
    document: { getElementById: id => elements.get(id) }, getElementValue: e => e.value,
    setElementValue: (e, value) => { e.value = value; }, appendClaimActivity: () => {},
    queueStorageMutation: message => {
      const work = message.action === 'removeRecoverySnapshot' ? writer.removeRecoverySnapshot(message.id)
        : writer.markRecoveryEntriesRestored(message.id, message.restoredIds);
      pending.push(work); return work;
    } });
  c.findTid = () => c.tid;
  vm.runInContext(section('function currentClaimContext(', 'function persistRecoverySnapshot(')
    + section('function getMatchingRecoverySnapshot(', 'globalThis.ClaimAutoFillActions'), c);
  return { c, elements, data, pending };
}

test('persistent recovery refuses missing IDs, other claims and other page routes', async () => {
  for (const change of [c => { c.tid = ''; }, c => { c.tid = 'CLAIM-B'; }, c => { c.location.href += '/other'; }]) {
    const { c, elements, data } = setup(); change(c);
    assert.equal((await c.restorePersistentSnapshot()).count, 0);
    assert.equal(elements.get('a').value, '900');
    assert.equal(data.claimRecoverySnapshots.length, 1);
  }
});

test('Undo remains bound to its original claim and can be retried on the correct claim', () => {
  const { c, elements } = setup();
  c.undoBatch = c.createClaimBatch();
  c.undoBatch.push({ element: elements.get('a'), value: '400', after: '900' });
  c.tid = 'CLAIM-B';
  assert.equal(c.undoLastFill(), 0);
  assert.equal(elements.get('a').value, '900');
  c.tid = 'CLAIM-A';
  assert.equal(c.undoLastFill(), 1);
  assert.equal(elements.get('a').value, '400');
});

test('partial saved recovery removes only restored entries and reports remaining conflicts', async () => {
  const { c, elements, data, pending } = setup();
  elements.get('b').value = 'manual';
  const result = await c.restorePersistentSnapshot();
  await Promise.all(pending);
  assert.equal(result.count, 1); assert.equal(result.conflicts, 1); assert.equal(result.hasRecovery, true);
  assert.equal(data.claimRecoverySnapshots[0].entries.length, 1);
  elements.get('b').value = '800';
  assert.equal((await c.restorePersistentSnapshot()).count, 1);
  await Promise.all(pending);
  assert.equal(data.claimRecoverySnapshots.length, 0);
  assert.equal(elements.get('a').value, '400'); assert.equal(elements.get('b').value, '300');
});

test('partial Undo retains unresolved entries and missing recovery controls are counted', async () => {
  const { c, elements } = setup();
  c.undoBatch = c.createClaimBatch();
  c.undoBatch.push({ element: elements.get('a'), value: '400', after: '900' },
    { element: elements.get('b'), value: '300', after: '800' });
  elements.get('b').isConnected = false;
  assert.equal(c.undoLastFill(), 1);
  assert.equal(c.undoBatch.length, 2);
  assert.equal((await c.restorePersistentSnapshot()).missing, 1);
  elements.get('b').isConnected = true;
  assert.equal(c.undoLastFill(), 1);
  assert.equal(c.undoBatch.length, 0);
});
