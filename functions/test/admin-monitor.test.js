'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { summarizeMonitor, createMonitorHandler } = require('../lib/admin-monitor');
const now = Date.parse('2026-11-10T12:00:00Z');

test('monitor counts use all accounts while tables and audit payloads are bounded and redacted', () => {
  const users = Array.from({ length: 650 }, (_, i) => ({ id: `u${i}`, accountStatus: i === 0 ? 'invited' : 'active',
    email: `u${i}@example.invalid`, license: { type: 'individual', status: 'active', paymentStatus: 'verified', expiresAt: new Date(now + 100000).toISOString() },
    patientName: 'MUST-NOT-LEAK', password: 'MUST-NOT-LEAK', updatedAt: new Date(now).toISOString() }));
  const result = summarizeMonitor({ users, audit: [{ id: 'a', userId: 'u1', extensionVersion: '1.12.0', action: 'preview',
    details: { patientName: 'MUST-NOT-LEAK' }, timestamp: new Date(now).toISOString() },
  { id: 'b', userId: 'u1', extensionVersion: '1.11.1' }, { id: 'c', userId: 'u2', extensionVersion: '1.11.1' }] }, now, 'demo-test');
  assert.equal(result.counts.users, 650); assert.equal(result.counts.active, 649); assert.equal(result.counts.pending, 1);
  assert.equal(result.users.length, 20); assert.equal(result.counts.expiring, 649);
  assert.deepEqual(result.versions, [{ version: '1.12.0', users: 1 }, { version: '1.11.1', users: 1 }]);
  assert.equal(result.versionSample.users, 2); assert.doesNotMatch(JSON.stringify(result), /MUST-NOT-LEAK/);
});

test('organization licence expiry, payment queue and unexpired invitations use actual backend fields', () => {
  const result = summarizeMonitor({ users: [
    { id: 'org-user', organizationId: 'org', accountStatus: 'active', license: { type: 'organisation', status: 'active' } },
    { id: 'pay', accountStatus: 'invited', license: { type: 'individual', paymentStatus: 'pending_verification' } },
    { id: 'old', accountStatus: 'active', license: { type: 'individual', status: 'active', paymentStatus: 'verified', expiresAt: new Date(now - 1).toISOString() } }
  ], organizations: [{ id: 'org', status: 'active' }], licences: [{ id: 'org', status: 'active', maximumUsers: 10,
    expiryDate: { toMillis: () => now + 86400000 } }], invitations: [
    { status: 'pending', expiresAt: { seconds: now / 1000 + 20 } }, { status: 'pending', expiresAt: new Date(now - 1).toISOString() }
  ] }, now);
  assert.equal(result.counts.expiring, 1); assert.equal(result.counts.expired, 1); assert.equal(result.counts.payments, 1);
  assert.equal(result.counts.invitations, 1); assert.equal(result.organizations[0].maximumUsers, 10);
  assert.equal(result.users.find(user => user.uid === 'org-user').licenseStatus, 'active');
});

test('monitor preserves explicit user deactivation and legacy activation requirements under an active organization licence', () => {
  const user = { id: 'disabled', role: 'processor', organizationId: 'org', accountStatus: 'active',
    license: { type: 'organisation', status: 'inactive', paymentStatus: 'not_required' } };
  const result = summarizeMonitor({ users: [user, { ...user, id: 'legacy', onboardingSource: 'self-registration',
    license: { ...user.license, status: 'active' } }], organizations: [{ id: 'org', status: 'active' }],
  licences: [{ id: 'org', status: 'active', expiryDate: new Date(now + 86400000).toISOString() }] }, now);
  assert.equal(result.counts.active, 2, 'account status stays separate from licensed access');
  assert.equal(result.counts.expiring, 0);
  assert(result.users.every(row => row.licenseStatus === 'inactive'));
});

test('attention rows show the latest changes while counts retain the complete queue', () => {
  const result = summarizeMonitor({ users: Array.from({ length: 30 }, (_, index) => ({
    id: String(index), accountStatus: 'invited', updatedAt: new Date(now + index * 1000).toISOString()
  })) }, now);
  assert.equal(result.counts.pending, 30);
  assert.equal(result.attention.length, 12);
  assert.equal(result.attention[0].uid, '29');
  assert.equal(result.attention.at(-1).uid, '18');
});

function fixture(options = {}) {
  const watchers = [], timers = new Map(); let nextTimer = 0, unsubscribeCount = 0;
  const reference = path => ({ orderBy() { return this; }, where() { return this; }, limit() { return this; },
    onSnapshot(onValue, onError) {
      const watcher = { path, onValue, onError, active: true }; watchers.push(watcher);
      return () => { if (watcher.active) { watcher.active = false; unsubscribeCount++; } };
    } });
  const response = Object.assign(new EventEmitter(), {
    headers: {}, chunks: [], writableEnded: false, statusCode: 200,
    setHeader(key, value) { this.headers[key] = value; }, flushHeaders() {},
    status(code) { this.statusCode = code; return this; }, json(body) { this.jsonBody = body; },
    write(chunk) { this.chunks.push(chunk); return !options.backpressure; }, end() { this.writableEnded = true; }
  });
  const handler = createMonitorHandler({ db: { doc: reference, collection: reference },
    verifyToken: options.verifyToken || (async () => ({ uid: 'admin', exp: now / 1000 + 3600 })),
    authorize: options.authorize || (async () => {}), projectId: 'demo-test', now: () => now,
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id) });
  const publish = (path, value, doc = false) => {
    for (const watcher of watchers.filter(item => item.active && item.path === path)) watcher.onValue(doc
      ? { exists: value !== null, data: () => value }
      : { docs: value.map(item => ({ id: item.id, data: () => item })) });
  };
  const tick = async delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); await timer.fn(); } };
  const initial = () => {
    publish('users/admin', { role: 'platformAdmin', accountStatus: 'active' }, true);
    for (const name of ['users', 'organizations', 'licences', 'invitations', 'auditLogs', 'processingRuleFeedback']) publish(name, []);
    publish('appConfig/production', {}, true); publish('processingRuleState/active', null, true);
  };
  return { watchers, response, timers, publish, tick, initial, unsubscribed: () => unsubscribeCount,
    run: request => handler({ method: 'POST', headers: { authorization: 'Bearer synthetic' }, ...request }, response) };
}
async function start(f) { const running = f.run(); await new Promise(resolve => setTimeout(resolve, 0)); return { running }; }

test('unauthenticated and non-admin requests create no database listeners', async () => {
  for (const denied of ['permission-denied', 'failed-precondition', 'auth/id-token-expired']) {
    const f = fixture({ authorize: async () => { throw Object.assign(new Error('Denied'), { code: denied }); } });
    await f.run(); assert.equal(f.watchers.length, 0); assert.equal(f.response.statusCode, denied.startsWith('auth/') ? 401 : 403);
  }
  const f = fixture(); await f.run({ headers: {} }); assert.equal(f.response.statusCode, 401);
});

test('initial snapshot waits for every source, then streams changes and releases all listeners on disconnect', async () => {
  const f = fixture(); const { running } = await start(f);
  f.publish('users', [{ id: 'u', accountStatus: 'invited' }]); await f.tick(150);
  assert.equal(f.response.chunks.length, 0);
  f.initial(); await f.tick(150); assert.match(f.response.chunks.at(-1), /"users":0/);
  f.publish('users', [{ id: 'u', accountStatus: 'invited' }]); await f.tick(150);
  assert.match(f.response.chunks.at(-1), /"pending":1/);
  f.response.emit('close'); await running;
  assert.equal(f.unsubscribed(), 9); assert.equal(f.timers.size, 0);
});

test('role revocation, listener failure, revoked token, timeout and slow clients terminate feeds', async () => {
  for (const reason of ['role', 'database', 'token', 'timeout', 'backpressure']) {
    let checks = 0;
    const f = fixture({ backpressure: reason === 'backpressure', verifyToken: async () => {
      if (++checks > 1 && reason === 'token') throw new Error('Revoked');
      return { uid: 'admin', exp: now / 1000 + 3600 };
    } });
    const { running } = await start(f); f.initial();
    if (reason === 'role') f.publish('users/admin', { role: 'processor', accountStatus: 'active' }, true);
    if (reason === 'database') f.watchers[1].onError(new Error('Offline'));
    if (reason === 'token') await f.tick(30000);
    if (reason === 'timeout') await f.tick(240000);
    if (reason === 'backpressure') await f.tick(150);
    await running; assert.equal(f.unsubscribed(), 9, reason); assert.equal(f.timers.size, 0, reason);
    assert.equal(f.response.writableEnded, true, reason);
  }
});
