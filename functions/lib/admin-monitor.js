'use strict';
const { inactiveUserLicenceDecision } = require('./contracts');

const DAY = 86400000;
function millis(value) {
  if (!value) return null;
  const result = typeof value.toMillis === 'function' ? value.toMillis()
    : typeof value === 'object' && Number.isFinite(value.seconds ?? value._seconds)
      ? (value.seconds ?? value._seconds) * 1000 : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}
function iso(value) { const time = millis(value); return time === null ? null : new Date(time).toISOString(); }
function documents(snapshot) { return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })); }

// Only account, licensing and structured audit metadata leave this boundary.
// Counts use the complete collection snapshots, never the limited table rows.
function summarizeMonitor(data, now = Date.now(), projectId = '') {
  const users = data.users || [], organizations = data.organizations || [], licences = data.licences || [];
  const invitations = data.invitations || [], events = data.audit || [];
  const pending = users.filter(user => user.accountStatus === 'invited');
  const payments = users.filter(user => user.license?.type === 'individual' && user.license.paymentStatus === 'pending_verification');
  const expiry = user => user.license?.type === 'organisation'
    ? licences.find(licence => licence.id === user.organizationId)?.expiryDate : user.license?.expiresAt;
  const licensed = user => user.accountStatus === 'active' && !inactiveUserLicenceDecision(user) && (user.license?.type === 'organisation'
    ? user.license.status !== 'inactive' && licences.some(licence => licence.id === user.organizationId && licence.status === 'active')
      && organizations.some(org => org.id === user.organizationId && org.status === 'active')
    : user.license?.status === 'active');
  const expiring = users.filter(user => licensed(user) && millis(expiry(user)) >= now && millis(expiry(user)) <= now + 7 * DAY);
  const expired = users.filter(user => licensed(user) && millis(expiry(user)) !== null && millis(expiry(user)) < now);
  const versions = new Map(), latestByUser = new Map();
  for (const event of events) {
    if (!event.userId || !event.extensionVersion || latestByUser.has(event.userId)) continue;
    latestByUser.set(event.userId, event.extensionVersion);
    versions.set(event.extensionVersion, (versions.get(event.extensionVersion) || 0) + 1);
  }
  const userRow = user => ({ uid: user.id, name: user.displayName || '', email: user.email || '',
    organizationId: user.organizationId || '', role: user.role || '', status: user.accountStatus || 'unknown',
    licenseStatus: inactiveUserLicenceDecision(user)?.status || (user.license?.type === 'organisation'
      ? licences.find(licence => licence.id === user.organizationId)?.status || 'inactive' : user.license?.status || 'inactive'),
    expiresAt: iso(expiry(user)), updatedAt: iso(user.updatedAt || user.createdAt) });
  const config = data.config || {}, rules = data.rules || {};
  return {
    generatedAt: new Date(now).toISOString(), projectId,
    counts: { users: users.length, active: users.filter(user => user.accountStatus === 'active').length,
      pending: pending.length, payments: payments.length, expiring: expiring.length, expired: expired.length,
      suspended: users.filter(user => user.accountStatus === 'suspended').length,
      organizations: organizations.length, activeLicences: licences.filter(licence => licence.status === 'active'
        && millis(licence.expiryDate) > now).length,
      invitations: invitations.filter(invitation => invitation.status === 'pending' && millis(invitation.expiresAt) > now).length },
    config: { minimumSupportedVersion: config.minimumSupportedVersion || '1.6.0', maintenanceMode: config.maintenanceMode === true,
      processingRulesMode: config.processingRulesMode || (rules.versionId ? 'remote-required' : 'bundled'),
      activeRuleVersion: rules.versionId || null },
    users: [...users].sort((a, b) => (millis(b.updatedAt || b.createdAt) || 0) - (millis(a.updatedAt || a.createdAt) || 0)).slice(0, 20).map(userRow),
    attention: [...new Map([...pending, ...payments, ...expiring, ...expired].map(user => [user.id, user])).values()]
      .sort((a, b) => (millis(b.updatedAt || b.createdAt) || 0) - (millis(a.updatedAt || a.createdAt) || 0)).slice(0, 12).map(user => ({
      ...userRow(user), reason: pending.includes(user) ? 'Registration pending' : payments.includes(user) ? 'Payment verification'
        : expired.includes(user) ? 'Licence expired' : 'Expires within 7 days' })),
    organizations: organizations.map(org => ({ id: org.id, name: org.name || org.id, status: org.status || 'unknown',
      users: users.filter(user => user.organizationId === org.id && user.accountStatus !== 'deleted').length,
      maximumUsers: licences.find(licence => licence.id === org.id)?.maximumUsers ?? org.maximumUsers ?? null,
      licenseStatus: licences.find(licence => licence.id === org.id)?.status || 'inactive',
      expiresAt: iso(licences.find(licence => licence.id === org.id)?.expiryDate) })).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20),
    audit: events.slice(0, 25).map(event => ({ id: event.id, action: event.action || 'Unknown event',
      actor: event.actorId || event.userId || 'system', organizationId: event.organizationId || '',
      result: event.result || '', timestamp: iso(event.timestamp), extensionVersion: event.extensionVersion || null })),
    versions: [...versions].map(([version, count]) => ({ version, users: count })),
    versionSample: { events: events.length, users: latestByUser.size, limit: 100 },
    feedback: (data.feedback || []).filter(item => item.status === 'open').length
  };
}

function createMonitorHandler({ db, verifyToken, authorize, projectId, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization || '');
    if (!bearer) return response.status(401).json({ error: 'UNAUTHENTICATED' });
    let token;
    try {
      token = await verifyToken(bearer[1]);
      await authorize({ auth: { uid: token.uid, token } });
    } catch (error) {
      const forbidden = ['permission-denied', 'failed-precondition'].includes(error.code);
      return response.status(forbidden ? 403 : 401).json({ error: forbidden ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED' });
    }
    if (response.destroyed || request.aborted) return;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    await new Promise(resolve => {
      const unsubscribers = [], timers = new Set(), state = {}, ready = new Set();
      let stopped = false, scheduled = null;
      const timer = (fn, delay) => { const id = setTimer(() => { timers.delete(id); fn(); }, delay); timers.add(id); return id; };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const unsubscribe of unsubscribers) unsubscribe();
        for (const id of timers) clearTimer(id);
        response.off('close', stop);
        response.off('error', stop);
        if (!response.writableEnded) response.end();
        resolve();
      };
      const send = (event, value) => {
        if (stopped) return;
        // Disconnect slow consumers instead of buffering an unbounded audit feed.
        if (!response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)) stop();
      };
      const fail = code => { send('monitor-error', { code }); stop(); };
      response.on('close', stop);
      response.on('error', stop);
      const emit = () => {
        scheduled = null;
        if (ready.size === 8 && !stopped) send('snapshot', summarizeMonitor(state, now(), projectId));
      };
      const schedule = () => { if (!scheduled && !stopped) scheduled = timer(emit, 150); };
      const watch = (name, reference, single = false) => {
        const unsubscribe = reference.onSnapshot(snapshot => {
          if (stopped) return;
          state[name] = single ? snapshot.exists ? snapshot.data() : {} : documents(snapshot);
          ready.add(name); schedule();
        }, () => fail('UNAVAILABLE'));
        if (stopped) unsubscribe(); else unsubscribers.push(unsubscribe);
      };
      try {
        // Close the feed as soon as the profile listener observes revoked access.
        const unsubscribe = db.doc(`users/${token.uid}`).onSnapshot(snapshot => {
          const user = snapshot.exists ? snapshot.data() : {};
          if (user.role !== 'platformAdmin' || user.accountStatus !== 'active') fail('PERMISSION_DENIED');
        }, () => fail('UNAVAILABLE'));
        if (stopped) unsubscribe(); else unsubscribers.push(unsubscribe);
        for (const name of ['users', 'organizations', 'licences', 'invitations']) {
          if (!stopped) watch(name, db.collection(name));
        }
        if (!stopped) watch('audit', db.collection('auditLogs').orderBy('timestamp', 'desc').limit(100));
        if (!stopped) watch('feedback', db.collection('processingRuleFeedback').where('status', '==', 'open').limit(100));
        if (!stopped) watch('config', db.doc('appConfig/production'), true);
        if (!stopped) watch('rules', db.doc('processingRuleState/active'), true);
      } catch { fail('UNAVAILABLE'); }
      const heartbeat = () => {
        if (stopped) return;
        send('heartbeat', { at: new Date(now()).toISOString() });
        schedule(); // Refresh time-dependent expiry counts even without a write.
        if (!stopped) timer(heartbeat, 15000);
      };
      const revalidate = async () => {
        if (stopped) return;
        try { await verifyToken(bearer[1]); await authorize({ auth: { uid: token.uid, token } }); }
        catch { return fail('PERMISSION_DENIED'); }
        if (!stopped) timer(revalidate, 30000);
      };
      if (!stopped) {
        timer(heartbeat, 15000); timer(revalidate, 30000);
        timer(() => fail('RECONNECT'), Math.max(1, Math.min(240000, token.exp * 1000 - now())));
      }
    });
  };
}

module.exports = { summarizeMonitor, createMonitorHandler };
