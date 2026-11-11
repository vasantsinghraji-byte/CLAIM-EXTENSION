'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { URLSearchParams } = require('node:url');
const source = fs.readFileSync(path.join(__dirname, '../hosting/firebase-client.js'), 'utf8');
function fixture(fetch) {
  const values = new Map([['claimSparkAdminSession', JSON.stringify({ uid: 'synthetic', idToken: 'synthetic-token',
    refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3600000 })]]);
  const context = vm.createContext({ fetch, TextDecoder, URLSearchParams, sessionStorage: {
    getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)
  } });
  vm.runInContext(source, context);
  return { api: context.ClaimSparkAdminApi, values };
}

test('live monitor parses fragmented UTF-8 and CRLF events with credentials only in authorization headers', async () => {
  const input = Buffer.from('event: snapshot\r\ndata: {"name":"अक्षय"}\r\n\r\nevent: heartbeat\ndata: {"at":"now"}\n\n');
  let cancelled = false, released = false, index = 0;
  const f = fixture(async (url, options) => {
    assert.match(url, /\/monitorAdminDashboard$/); assert.doesNotMatch(url, /token|synthetic/);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token'); assert.equal(options.method, 'POST');
    return { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({
      read: async () => index < input.length ? { value: input.subarray(index, ++index), done: false } : { done: true },
      cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; }
    }) } };
  });
  const events = []; await f.api.watchMonitor({ aborted: false }, (event, data) => events.push({ event, data }));
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{ event: 'snapshot', data: { name: 'अक्षय' } }, { event: 'heartbeat', data: { at: 'now' } }]);
  assert.equal(cancelled, true); assert.equal(released, true);
});

test('monitor distinguishes unauthenticated, forbidden and not-deployed backend responses', async () => {
  for (const [status, message] of [[401, 'UNAUTHENTICATED'], [403, 'PERMISSION_DENIED'], [404, 'MONITOR_NOT_DEPLOYED']]) {
    const f = fixture(async () => ({ ok: false, status }));
    await assert.rejects(f.api.watchMonitor({ aborted: false }, () => {}), new RegExp(message));
  }
});

test('concurrent token refreshes coalesce and cannot restore a signed-out hosted session', async () => {
  let finish, calls = 0;
  const f = fixture(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const session = f.api.load(); session.expiresAt = 0; f.values.set('claimSparkAdminSession', JSON.stringify(session));
  const pending = [f.api.call('listUsers'), f.api.call('listOrganizations')];
  assert.equal(calls, 1); f.api.signOut();
  finish({ ok: true, json: async () => ({ user_id: 'synthetic', id_token: 'late-token', refresh_token: 'late-refresh', expires_in: '3600' }) });
  const results = await Promise.allSettled(pending);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'UNAUTHENTICATED'));
  assert.equal(f.api.load(), null);
});

test('late hosted sign-in and callable results cannot reactivate a signed-out session', async () => {
  let finish;
  const f = fixture(async () => new Promise(resolve => { finish = resolve; }));
  const signIn = f.api.signIn('synthetic@example.invalid', 'synthetic-only');
  f.api.signOut(); finish({ ok: true, json: async () => ({ localId: 'synthetic', idToken: 'late', refreshToken: 'late', expiresIn: '3600' }) });
  await assert.rejects(signIn, /UNAUTHENTICATED/); assert.equal(f.api.load(), null);
  const g = fixture(async () => new Promise(resolve => { finish = resolve; }));
  const request = g.api.call('getCurrentUserProfile'); await new Promise(resolve => setTimeout(resolve, 0));
  g.api.signOut(); finish({ ok: true, json: async () => ({ result: { role: 'platformAdmin' } }) });
  await assert.rejects(request, /SESSION_CHANGED/); assert.equal(g.api.load(), null);
});

test('sign-out before a queued hosted mutation reaches fetch prevents sending it', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('A cancelled mutation must not reach the backend'); });
  const pending = f.api.call('setUserLicense', { uid: 'synthetic-target', action: 'deactivate' });
  f.api.signOut();
  await assert.rejects(pending, /SESSION_CHANGED/);
  assert.equal(calls, 0);
});
