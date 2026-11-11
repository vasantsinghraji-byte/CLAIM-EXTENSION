'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Review = require('../review-core');
const { createReviewDecisionStore } = require('../background');

const context = { uid: 'USER-A', tid: 'CLAIM-A', url: 'https://example.invalid/claim' };
const row = { key: 'row-a', claimAmount: 1000, beforeApproved: 0, proposedApproved: 900, risk: 'high', ruleIds: ['RULE-A'] };
const preview = { token: 'abcdef12', ruleSetVersion: 'v1', ruleSetChecksum: 'checksum', proposals: [row] };
const saved = { previewToken: preview.token, ruleSetVersion: 'v1', ruleSetChecksum: 'checksum',
  selectedKeys: ['row-a'], approvedOverrides: { 'row-a': 1000 }, remarkOverrides: { 'row-a': 'Reviewed' }, exceptionalGroups: ['RULE-A'] };

function storageFixture() {
  const data = {};
  return { data, storage: { get: (_keys, cb) => cb(data), set: (value, cb) => { Object.assign(data, value); cb(); } } };
}

test('saved reviews are scoped to the current user, claim and exact page', async () => {
  const { storage } = storageFixture(); const store = createReviewDecisionStore(storage);
  await store.save(context, saved);
  assert.deepEqual(await store.get(context), saved);
  for (const change of [{ uid: 'USER-B' }, { tid: 'CLAIM-B' }, { url: 'https://example.invalid/other' }]) {
    assert.equal(await store.get({ ...context, ...change }), null);
  }
  const restarted = createReviewDecisionStore(storage);
  assert.deepEqual(await restarted.get(context), saved);
  await restarted.clear(context); assert.equal(await restarted.get(context), null);
});

test('review storage serializes concurrent tabs, rejects invalid data and expires old reviews', async () => {
  let now = 1000; const { storage, data } = storageFixture(); const store = createReviewDecisionStore(storage, () => now);
  await Promise.all([store.save(context, saved), store.save({ ...context, tid: 'CLAIM-B' }, saved)]);
  assert.equal(data.claimReviewDecisions.length, 2);
  await assert.rejects(store.save(context, { ...saved, approvedOverrides: { 'row-a': NaN } }), /Invalid saved amount/);
  await assert.rejects(store.save(context, { ...saved, selectedKeys: ['other'] }), /Invalid saved amount/);
  now += 24 * 60 * 60 * 1000;
  assert.equal(await store.get(context), null);
});

test('resume requires matching inputs and rule identity, and reinstates high-risk acknowledgement', () => {
  const resumed = Review.resumeDecisions(preview, saved);
  assert.deepEqual(resumed.selectedKeys, ['row-a']); assert.deepEqual(resumed.exceptionalGroups, ['RULE-A']);
  for (const change of [{ token: 'different' }, { ruleSetVersion: 'v2' }, { ruleSetChecksum: 'changed' }]) {
    assert.equal(Review.resumeDecisions({ ...preview, ...change }, saved), null);
  }
  const mandatory = Review.resumeDecisions({ ...preview, proposals: [{ ...row, mandatory: true }] }, { ...saved, selectedKeys: [] });
  assert.deepEqual(mandatory.selectedKeys, ['row-a']); assert.deepEqual(mandatory.approvedOverrides, {});
});

test('continuing after safe Apply carries only unchanged findings and resets policy changes', () => {
  const next = { ...preview, token: '1234abcd' };
  assert.deepEqual(Review.carryDecisions(preview, next, saved).approvedOverrides, { 'row-a': 1000 });
  const changed = { ...next, proposals: [{ ...row, beforeApproved: 100 }] };
  assert.deepEqual(Review.carryDecisions(preview, changed, saved).selectedKeys, []);
  assert.equal(Review.carryDecisions(preview, { ...next, ruleSetVersion: 'v2' }, saved), null);
  assert.equal(Review.carryDecisions({ ...preview, claimIdentity: 'CLAIM-A' },
    { ...next, claimIdentity: 'CLAIM-B' }, saved), null);
});
