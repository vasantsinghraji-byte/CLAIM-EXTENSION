#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { BrowserPipe, until } = require('./extension-browser-e2e');
const { findChrome } = require('./browser-smoke-e2e');
const { createMonitorHandler } = require('../functions/lib/admin-monitor');
const root = path.join(__dirname, '..');
async function cleanup(directory) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'claim-admin-e2e-')) throw new Error('Unexpected temporary directory');
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
}

function waitForBrowserExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const exited = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', exited); resolve(false); }, 5000);
    child.once('exit', exited);
  });
}

async function closeBrowser(browser, child) {
  if (browser) await browser.send('Browser.close').catch(() => {});
  if (child && !await waitForBrowserExit(child)) {
    child.kill();
    if (!await waitForBrowserExit(child)) throw new Error('Dashboard browser did not exit before profile cleanup');
  }
}

async function main() {
  const chrome = findChrome(); if (!chrome) throw new Error('Chrome required. Set CHROME_PATH.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-admin-e2e-'));
  const subscriptions = new Set();
  const streams = new Set();
  let unavailable = false;
  const calls = [];
  const user = (id, status = 'active') => ({ id, email: `${id}@example.invalid`, displayName: id === 'admin' ? 'Synthetic administrator' : `Synthetic ${id}`,
    organizationId: 'SYN-ORG', role: id === 'admin' ? 'platformAdmin' : 'processor', accountStatus: status,
    updatedAt: new Date().toISOString(), license: { type: 'individual', status: 'active', paymentStatus: 'verified', expiresAt: new Date(Date.now() + 86400000 * 3).toISOString() } });
  const data = { users: [user('admin'), user('reviewer'), user('pending', 'invited')], organizations: [
    { id: 'SYN-ORG', name: 'Synthetic review organization', status: 'active', maximumUsers: 25 }],
  licences: [{ id: 'SYN-ORG', status: 'active', maximumUsers: 25, expiryDate: new Date(Date.now() + 86400000 * 30).toISOString() }],
  invitations: [], auditLogs: [{ id: 'audit-1', userId: 'reviewer', action: 'preview', result: 'success', extensionVersion: '1.12.0', timestamp: new Date().toISOString() }],
  processingRuleFeedback: [], 'appConfig/production': { minimumSupportedVersion: '1.12.0' }, 'processingRuleState/active': {} };
  const snapshot = key => key.startsWith('users/') ? { exists: true, data: () => data.users.find(x => x.id === key.slice(6)) || {} }
    : Array.isArray(data[key]) ? { docs: data[key].map(item => ({ id: item.id, data: () => item })) }
      : { exists: Boolean(data[key]), data: () => data[key] };
  const reference = key => ({ orderBy() { return this; }, where() { return this; }, limit() { return this; },
    onSnapshot(callback) {
      const entry = { key, callback }; subscriptions.add(entry); queueMicrotask(() => { if (subscriptions.has(entry)) callback(snapshot(key)); });
      return () => subscriptions.delete(entry);
    } });
  const publish = key => { for (const entry of subscriptions) if (entry.key === key) entry.callback(snapshot(key)); };
  const monitor = createMonitorHandler({ db: { doc: reference, collection: reference }, projectId: 'demo-claimextension',
    verifyToken: async token => {
      if (token !== 'synthetic-token') throw new Error('Invalid token');
      return { uid: 'admin', exp: Date.now() / 1000 + 3600 };
    }, authorize: async () => {
      if (data.users[0].role !== 'platformAdmin') throw Object.assign(new Error('Denied'), { code: 'permission-denied' });
    } });
  const server = http.createServer(async (request, response) => {
    response.status = code => { response.statusCode = code; return response; };
    response.json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (request.url === '/functions/monitorAdminDashboard') {
      if (unavailable) return response.status(503).json({ error: 'UNAVAILABLE' });
      streams.add(response); response.on('close', () => streams.delete(response));
      return monitor(request, response);
    }
    if (request.url.startsWith('/auth/')) return response.json({ localId: 'admin', email: 'admin@example.invalid', idToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresIn: '3600' });
    if (request.url.startsWith('/functions/')) {
      const name = request.url.slice('/functions/'.length);
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = body ? JSON.parse(body).data || {} : {};
      calls.push({ name, data: input });
      const target = data.users.find(item => item.id === input.uid);
      if (name === 'activateUser' && target) { target.accountStatus = 'active'; publish('users'); }
      if (name === 'setUserLicense' && target) {
        target.license.durationWeeks = input.durationWeeks;
        target.license.status = input.action === 'deactivate' ? 'inactive' : 'active';
        publish('users');
      }
      if (name === 'changeUserRole' && target) { target.role = input.role; publish('users'); }
      const result = name === 'getCurrentUserProfile' ? { ...data.users[0], uid: 'admin' }
        : name === 'listUsers' ? { users: data.users.map(item => ({ ...item, uid: item.id, pendingApproval: item.accountStatus === 'invited' })), pendingCount: data.users.filter(item => item.accountStatus === 'invited').length }
          : name === 'listOrganizations' ? { organizations: data.organizations.map(item => ({ ...item, organizationId: item.id })) }
            : name === 'listAuditEvents' ? { events: [] } : {};
      return response.json({ result });
    }
    const name = request.url === '/admin' ? 'admin.html' : request.url.slice(1);
    if (!['admin.html', 'styles.css', 'admin.css', 'firebase-client.js', 'admin-monitor.js', 'admin.js'].includes(name)) { response.statusCode = 404; response.end(); return; }
    let body = fs.readFileSync(path.join(root, 'hosting', name), 'utf8');
    if (name === 'firebase-client.js') body = body.replace('__FIREBASE_API_KEY__', 'synthetic')
      .replace('__AUTH_BASE_URL__', `${origin}/auth`).replace('__TOKEN_BASE_URL__', `${origin}/token`).replace('__FUNCTIONS_BASE_URL__', `${origin}/functions`);
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'application/javascript' : 'text/html');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'");
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let child, browser;
  try {
    child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      '--remote-debugging-pipe', `--user-data-dir=${path.join(temporary, 'profile')}`], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    browser = new BrowserPipe(child);
    const page = await browser.page(`${origin}/admin`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => page.evaluate('document.readyState === "complete" && Boolean(globalThis.ClaimSparkAdminApi) && !document.getElementById("signInButton").disabled'), 'dashboard sign-in readiness');
    assert.equal(await page.evaluate('document.getElementById("dashboardView").hidden'), true);
    await page.evaluate(`document.getElementById('email').value='admin@example.invalid';document.getElementById('password').value='synthetic-only';document.getElementById('signInForm').requestSubmit()`);
    await until(() => page.evaluate(`document.querySelector('[data-metric="users"]').textContent==='3'`), 'initial live backend snapshot');
    assert.equal(await page.evaluate('document.getElementById("liveStatus").textContent'), 'Live');
    assert.equal(await page.evaluate('document.getElementById("overviewPanel").hidden'), false);
    assert.equal(await page.evaluate('document.getElementById("password").value'), '');
    data.users.push(user('new-registration', 'invited')); publish('users');
    await until(() => page.evaluate(`document.querySelector('[data-metric="pending"]').textContent==='2'`), 'registration arriving without refresh');
    data.users[3].accountStatus = 'active'; data.users[3].displayName = '<img src=x onerror=alert(1)>'; publish('users');
    await until(() => page.evaluate(`document.querySelector('[data-metric="active"]').textContent==='3'`), 'account activation arriving without refresh');
    assert.equal(await page.evaluate('document.querySelectorAll("#monitorUserRows img").length'), 0);
    await page.evaluate(`document.querySelector('[data-open-tab="users"]').click()`);
    assert.equal(await page.evaluate('document.getElementById("usersPanel").hidden'), false);
    assert.equal(await page.evaluate('document.getElementById("pageTitle").textContent'), 'Users & payments');
    await until(() => page.evaluate(`Boolean(document.querySelector('#pendingUsersList [data-action="approve"][data-uid="pending"]'))`), 'pending approval control');
    await page.evaluate(`document.querySelector('#pendingUsersList [data-action="approve"][data-uid="pending"]').click()`);
    await until(() => data.users.find(item => item.id === 'pending').accountStatus === 'active', 'approval action reaches backend');
    await until(() => page.evaluate(`document.querySelector('[data-metric="active"]').textContent==='4'`), 'live approval count');
    await until(() => page.evaluate(`Boolean(document.querySelector('#expiringUsersList [data-action="role"][data-uid="reviewer"]'))`), 'expiring user controls');
    await page.evaluate(`(()=>{const row=document.querySelector('#expiringUsersList [data-action="role"][data-uid="reviewer"]').closest('.record');row.querySelector('select[data-uid]').value='organizationAdmin';row.querySelector('[data-action="role"]').click()})()`);
    await until(() => data.users.find(item => item.id === 'reviewer').role === 'organizationAdmin', 'role selector uses clicked record');
    assert.equal(calls.filter(call => call.name === 'changeUserRole').at(-1).data.role, 'organizationAdmin');
    await until(() => page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] .user-facts')?.textContent.includes('Organization admin')`), 'saved role rendered in directory');
    assert.equal(await page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] details').open`), false, 'management controls start collapsed');
    await page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] summary').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] [data-action="license-extend"]').checkVisibility()`), true, 'Manage account reveals licence controls');
    const extensionsBefore = calls.filter(call => call.name === 'setUserLicense').length;
    for (const invalid of ['0', '53', '1.5']) {
      await page.evaluate(`(()=>{const row=document.querySelector('#usersList [data-user-id="reviewer"]');row.querySelector('[data-license-duration-custom]').value=${JSON.stringify(invalid)};row.querySelector('[data-action="license-extend"]').click()})()`);
      assert.equal(await page.evaluate(`document.getElementById('globalMessage').textContent.includes('No change was saved')`), true, 'invalid custom duration must not fall back to the preset');
      assert.equal(calls.filter(call => call.name === 'setUserLicense').length, extensionsBefore);
    }
    await page.evaluate(`(()=>{const row=document.querySelector('#usersList [data-action="license-extend"][data-uid="reviewer"]').closest('.record');row.querySelector('[data-license-duration-custom]').value='2';const button=row.querySelector('[data-action="license-extend"]');button.click();button.click()})()`);
    await until(() => data.users.find(item => item.id === 'reviewer').license.durationWeeks === 2, 'licence duration forwarded');
    await until(() => page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] details')?.open && document.querySelector('#usersList [data-user-id="reviewer"] [data-license-duration-custom]')?.value === ''`), 'management stays open after saving and reloading');
    assert.equal(calls.filter(call => call.name === 'setUserLicense').length, extensionsBefore + 1, 'duplicate clicks cause one licence extension');
    await page.evaluate(`document.getElementById('userSearch').value='reviewer@example.invalid';document.getElementById('userSearch').dispatchEvent(new Event('input'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#usersList .user-record:not([hidden])').length`), 1, 'directory search finds the correct account');
    await page.evaluate(`document.getElementById('userSearch').value='missing-user';document.getElementById('userSearch').dispatchEvent(new Event('input'))`);
    assert.equal(await page.evaluate(`document.getElementById('userSearchEmpty').hidden`), false, 'empty search explains the result');
    await page.evaluate(`document.getElementById('userSearch').value='';document.getElementById('userSearch').dispatchEvent(new Event('input'));document.getElementById('userStatusFilter').value='inactive-licence';document.getElementById('userStatusFilter').dispatchEvent(new Event('change'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#usersList .user-record:not([hidden])').length`), 0, 'licence filter uses licence status');
    await page.evaluate(`document.getElementById('userStatusFilter').value='current';document.getElementById('userStatusFilter').dispatchEvent(new Event('change'))`);
    data.users.find(item => item.id === 'reviewer').license.status = 'inactive';
    const beforeRefresh = calls.filter(call => call.name === 'listUsers').length;
    await page.evaluate(`document.getElementById('refreshUsers').click()`);
    await until(() => calls.filter(call => call.name === 'listUsers').length > beforeRefresh, 'refresh reaches backend');
    await until(() => page.evaluate(`document.querySelector('#usersList [data-user-id="reviewer"] [data-action="license-deactivate"]')?.disabled`), 'inactive licence remains disabled');
    await page.evaluate(`document.getElementById('userStatusFilter').value='inactive-licence';document.getElementById('userStatusFilter').dispatchEvent(new Event('change'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#usersList .user-record:not([hidden])').length`), 1, 'inactive licence filter finds the matching account');
    assert.equal(await page.evaluate(`document.querySelector('#usersList .user-record:not([hidden])').dataset.userId`), 'reviewer');
    await page.evaluate(`document.getElementById('userStatusFilter').value='current';document.getElementById('userStatusFilter').dispatchEvent(new Event('change'))`);
    for (const name of ['invitations', 'organizations', 'roster', 'licences', 'rules', 'rule-feedback', 'audit']) {
      await page.evaluate(`document.querySelector('[data-tab="${name}"]').click()`);
      assert.equal(await page.evaluate(`document.querySelector('[data-panel="${name}"]').hidden`), false, `${name} navigation`);
    }
    await page.evaluate(`document.querySelector('[data-tab="overview"]').click()`);
    data.users[3].displayName = 'Synthetic new registration'; publish('users');
    await until(() => page.evaluate(`document.getElementById('monitorUserRows').textContent.includes('Synthetic new registration')`), 'safe rendering update');
    unavailable = true;
    for (const stream of streams) stream.end();
    await until(() => page.evaluate(`document.getElementById('liveStatus').textContent.includes('Reconnecting')`), 'disconnected state');
    assert.equal(await page.evaluate(`document.querySelector('[data-metric="users"]').textContent`), '4', 'connection loss must not replace real counts with zero');
    unavailable = false;
    await page.evaluate(`document.getElementById('reconnectMonitor').click()`);
    await until(() => page.evaluate(`document.getElementById('liveStatus').textContent==='Live'`), 'recovery after backend outage');
    if (process.env.ADMIN_SCREENSHOT_PATH) {
      await page.evaluate(`document.getElementById('globalMessage').textContent='';window.scrollTo(0,0)`);
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.resolve(process.env.ADMIN_SCREENSHOT_PATH), Buffer.from(screenshot.data, 'base64'));
      await page.evaluate(`document.querySelector('[data-tab="users"]').click();window.scrollTo(0,0)`);
      const usersScreenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.resolve(process.env.ADMIN_SCREENSHOT_PATH).replace(/\.png$/, '-users.png'), Buffer.from(usersScreenshot.data, 'base64'));
      await page.evaluate(`document.querySelector('[data-tab="overview"]').click()`);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile layout must fit viewport');
    await page.evaluate(`document.querySelector('[data-tab="users"]').click()`);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'user directory and expanded management fit mobile');
    if (process.env.ADMIN_SCREENSHOT_PATH) {
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.resolve(process.env.ADMIN_SCREENSHOT_PATH).replace(/\.png$/, '-mobile.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await page.evaluate(`document.querySelector('[data-tab="overview"]').click()`);
    await page.evaluate(`document.getElementById('reconnectMonitor').click()`);
    await until(() => page.evaluate(`document.getElementById('liveStatus').textContent==='Live'`), 'manual reconnect');
    data.users[0].role = 'processor'; publish('users/admin');
    await until(() => page.evaluate('document.getElementById("dashboardView").hidden'), 'access revocation');
    assert.equal(await page.evaluate('sessionStorage.getItem("claimSparkAdminSession")'), null);
    assert.equal(await page.evaluate('document.querySelector("[data-metric=users]").textContent'), '—');
    assert.equal(await page.evaluate('document.getElementById("ruleVersionValue").textContent'), '—');
    await until(() => subscriptions.size === 0, 'listener cleanup');
    console.log('PASS: dashboard sign-in, live changes, approval, clicked-record role saving, licence duration, expandable management, search, status filters, inactive licence safety, refresh, all navigation, safe rendering, mobile layout, reconnect and revocation. Synthetic loopback data only.');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await closeBrowser(browser, child);
    await cleanup(temporary);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
