'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const saved = { previewToken: 'abcdef12', selectedKeys: ['row-a'], approvedOverrides: {}, remarkOverrides: {}, exceptionalGroups: [] };

function setup() {
  const localData = { authSession: { uid: 'USER-A' }, ruleOverridesMigratedToLocal: true };
  const sessionData = {};
  const storage = data => ({
    get: (keys, callback) => callback(Object.fromEntries(keys.map(key => [key, data[key]]))),
    set: (values, callback) => { Object.assign(data, values); callback(); }
  });
  const session = storage(sessionData);
  let heldRead, onHeldRead, holding = false, failClear = false, listener;
  const originalGet = session.get;
  session.get = (keys, callback) => {
    if (holding) { heldRead = () => originalGet(keys, callback); onHeldRead(); }
    else originalGet(keys, callback);
  };
  const runtime = { onMessage: { addListener: fn => { listener = fn; } } };
  const originalSet = session.set;
  session.set = (values, callback) => {
    if (!failClear) return originalSet(values, callback);
    runtime.lastError = { message: 'Synthetic session storage failure' };
    callback();
    delete runtime.lastError;
  };
  const context = vm.createContext({ URL, console,
    chrome: { storage: { local: storage(localData), sync: storage(localData), session }, runtime }
  });
  vm.runInContext(source, context);
  const dispatch = (request, url = 'https://rghs.rajasthan.gov.in/RGHS/processSheetSearch/CLAIM-A/') =>
    new Promise(resolve => listener(request, { tab: { id: 1, url } }, resolve));
  return { localData, sessionData, dispatch,
    holdNextReviewRead: () => { holding = true; return new Promise(resolve => { onHeldRead = resolve; }); },
    releaseReviewRead: () => { holding = false; heldRead(); },
    failReviewClear: () => { failClear = true; }
  };
}

test('worker broker accepts supported claim pages and refuses other origins or missing claims', async () => {
  const f = setup();
  assert.equal((await f.dispatch({ action: 'saveReviewDecisions', tid: 'CLAIM-A', data: saved })).success, true);
  const reply = await f.dispatch({ action: 'getReviewDecisions', tid: 'CLAIM-A' });
  assert.equal(reply.value.previewToken, saved.previewToken);
  assert.equal((await f.dispatch({ action: 'getReviewDecisions', tid: 'CLAIM-A' }, 'https://example.invalid/claim')).success, false);
  assert.equal((await f.dispatch({ action: 'getReviewDecisions', tid: '' })).success, false);
});

test('review storage failure cannot prevent sign-out and leaves the review broker unavailable', async () => {
  const f = setup();
  await f.dispatch({ action: 'saveReviewDecisions', tid: 'CLAIM-A', data: saved });
  f.failReviewClear();
  assert.equal((await f.dispatch({ action: 'authSignOut' })).success, true);
  assert.equal(f.localData.authSession, null);
  assert.equal(f.localData.licenceState, null);
  f.localData.authSession = { uid: 'USER-A' };
  assert.equal((await f.dispatch({ action: 'getReviewDecisions', tid: 'CLAIM-A' })).success, false);
});

for (const action of ['getReviewDecisions', 'saveReviewDecisions']) {
  test(`sign-out invalidates a delayed ${action} and rejects new review work until clearing finishes`, { timeout: 3000 }, async () => {
    const f = setup();
    await f.dispatch({ action: 'saveReviewDecisions', tid: 'CLAIM-A', data: saved });
    const held = f.holdNextReviewRead();
    const pending = f.dispatch({ action, tid: 'CLAIM-A', data: saved });
    await held;
    const signingOut = f.dispatch({ action: 'authSignOut' });
    const during = await f.dispatch({ action: 'saveReviewDecisions', tid: 'CLAIM-A', data: saved });
    assert.equal(during.success, false);
    f.releaseReviewRead();
    assert.equal((await pending).success, false);
    assert.equal((await signingOut).success, true);
    assert.equal(f.localData.authSession, null);
    assert.equal(f.sessionData.claimReviewDecisions.length, 0);
    assert.equal((await f.dispatch({ action: 'getReviewDecisions', tid: 'CLAIM-A' })).success, false);
  });
}
