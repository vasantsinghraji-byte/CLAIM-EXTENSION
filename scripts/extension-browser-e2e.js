#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBuildEntries, runtimeConfigSource } = require('../build');
const { findChrome } = require('./browser-smoke-e2e');

class BrowserPipe {
  constructor(child) {
    this.child = child; this.nextId = 0; this.pending = new Map(); this.listeners = new Set();
    let buffered = '';
    child.stdio[4].on('data', chunk => {
      buffered += chunk.toString();
      let boundary;
      while ((boundary = buffered.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1);
        const waiting = this.pending.get(message.id);
        if (waiting) {
          clearTimeout(waiting.timer); this.pending.delete(message.id);
          if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
          else waiting.resolve(message.result);
        } else for (const listener of this.listeners) listener(message);
      }
    });
    child.once('exit', () => {
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Test browser exited')); }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  async page(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const contexts = new Map();
    this.listeners.add(message => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.executionContextCreated') contexts.set(message.params.context.id, message.params.context);
      if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    });
    await this.send('Runtime.enable', {}, sessionId);
    const evaluate = async (expression, contextId) => {
      const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
        ...(contextId ? { contextId } : {}) }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    return { targetId, sessionId, contexts, evaluate, send: (method, params) => this.send(method, params, sessionId) };
  }
}

async function until(check, description) {
  const deadline = Date.now() + 15000;
  do {
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function contentWorld(page) {
  return until(async () => {
    for (const context of page.contexts.values()) {
      if (context.auxData?.isDefault) continue;
      try { if (await page.evaluate('Boolean(globalThis.ClaimAutoFillActions)', context.id)) return context.id; } catch (_) { /* a navigation may replace this context */ }
    }
    return null;
  }, 'real content script');
}

async function widgetRoot(page, world) {
  const { root } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = node => node.attributes?.includes('claim-spark-widget-host') ? node
    : [...(node.children || []), ...(node.shadowRoots || [])].map(find).find(Boolean);
  const host = find(root);
  assert.ok(host?.shadowRoots?.[0], 'Actual widget shadow root is missing');
  const resolved = await page.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId, executionContextId: world });
  return async expression => {
    const result = await page.send('Runtime.callFunctionOn', { objectId: resolved.object.objectId,
      functionDeclaration: `function(){return (${expression})(this);}`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function cleanupTestDirectory(directory) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'claim-extension-e2e-')) throw new Error('Unexpected test cleanup path');
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
  // Allow Chrome to finish shutting down its profile writers before deletion.
  if (child && !await waitForBrowserExit(child)) {
    child.kill();
    if (!await waitForBrowserExit(child)) throw new Error('Extension browser did not exit before profile cleanup');
  }
}

const fixture = `<!doctype html><html><body><input id="transid" value="SYN-A">
<table><tr><th>Particular</th><th>Package Code(Package Name)</th><th>Rate</th><th>Unit/Hours/Days</th><th>Claim Amount(Rs.)</th><th>Approved Amount(Rs.)</th><th>Deductions</th><th>Remarks</th><th hidden></th></tr>
<tr><td hidden>1</td><td id="packageName_0">Investigation</td><td id="packageCode_0">INV-SYN</td><td id="packageRate_0">100</td><td id="packageDays_0">4</td><td id="packageAmount_0">400</td><td><input id="packageFinalAmount_0" name="packageFinalAmounts" type="number" value="0"></td><td>0</td><td><textarea id="packageremarks_0"></textarea></td><td hidden>1</td></tr></table></body></html>`;

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome is required for actual-extension acceptance. Set CHROME_PATH.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-extension-e2e-'));
  const state = { held: [], holdLicence: false, rules: [], governed: false, offline: false };
  const json = (response, value) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify(value)); };
  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); response.end(); return; }
    if (request.url.startsWith('/auth/')) return json(response, { localId: 'SYN-A', idToken: 'SYN-A', refreshToken: 'SYN-REFRESH', expiresIn: '3600', email: 'synthetic@example.invalid' });
    if (request.url === '/functions/getCurrentUserProfile') return json(response, { result: { accountStatus: 'active', role: 'processor', organizationId: 'SYN-ORG' } });
    if (request.url === '/functions/getActiveProcessingRules') {
      if (state.offline) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { status: 'UNAVAILABLE' } })); return; }
      if (!state.governed) return json(response, { result: { schemaVersion: 2, mode: 'bundled', versionId: '', unchanged: true } });
      const checksum = crypto.createHash('sha256').update(canonicalJson({ schemaVersion: 2, rules: state.rules })).digest('hex');
      return json(response, { result: { schemaVersion: 2, mode: 'remote-required', versionId: 'synthetic-policy-v1',
        rules: state.rules, bundledFallbackEnabled: false, checksum: `sha256:${checksum}:central` } });
    }
    if (request.url === '/functions/verifyLicence') {
      const finish = () => json(response, { result: { status: 'active', applyAllowed: true, previewAllowed: true, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
      if (state.holdLicence) state.held.push(finish); else finish();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(request.url.startsWith('/RGHS/processSheetSearch/')
      ? fixture.replace('value="SYN-A"', `value="${request.url.includes('/SYN-B/') ? 'SYN-B' : 'SYN-A'}"`) : '<html><body></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let child, browser;
  try {
    const extension = path.join(temporary, 'extension'); fs.mkdirSync(extension);
    const config = { apiKey: 'synthetic-extension-test-key', functionsBaseUrl: `${origin}/functions`, authBaseUrl: `${origin}/auth`, tokenBaseUrl: `${origin}/token` };
    const entries = createBuildEntries({ apiKey: 'synthetic-extension-test-key', functionsBaseUrl: 'https://asia-south1-synthetic.cloudfunctions.net' });
    for (const entry of entries) {
      const destination = path.join(extension, entry.name); fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (entry.name === 'manifest.json') {
        const manifest = JSON.parse(entry.data);
        manifest.host_permissions = [`${origin}/*`];
        manifest.content_scripts.forEach(script => { script.matches = ['http://127.0.0.1/*']; });
        manifest.web_accessible_resources.forEach(resource => { resource.matches = ['http://127.0.0.1/*']; });
        fs.writeFileSync(destination, JSON.stringify(manifest));
      } else fs.writeFileSync(destination, entry.name === 'runtime-config.js' ? runtimeConfigSource(config) : entry.data);
    }
    child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${path.join(temporary, 'profile')}`],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    browser = new BrowserPipe(child);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: extension });
    const options = await browser.page(`chrome-extension://${id}/options.html`);
    await until(() => options.evaluate('Boolean(globalThis.chrome?.runtime?.id)'), 'extension options');
    const signedIn = await options.evaluate(`chrome.runtime.sendMessage({action:'authSignIn',email:'synthetic@example.invalid',password:'synthetic-only'})`);
    assert.equal(signedIn.success, true);
    const popup = await browser.page(`chrome-extension://${id}/popup.html`);
    await until(() => popup.evaluate(`document.getElementById('fillNowBtn') && !document.getElementById('fillNowBtn').disabled`), 'licensed popup unlocks claim tools');
    const page = await browser.page(`${origin}/RGHS/processSheetSearch/SYN-A/`);
    const world = await contentWorld(page);
    const evaluate = expression => page.evaluate(expression, world);
    const applied = await evaluate(`(async()=>{const p=await ClaimAutoFillActions.previewFresh();return ClaimAutoFillActions.applyFresh({token:p.token,selectedRowKeys:p.proposals.map(x=>x.key)})})()`);
    assert.equal(applied.blocked, false); assert.equal(applied.recoverySaved, true);
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_0').value`), '400');
    await evaluate(`document.getElementById('transid').value='SYN-B'`);
    assert.equal((await evaluate('ClaimAutoFillActions.undo()')).count, 0);
    await evaluate(`document.getElementById('transid').value='SYN-A'`);
    assert.equal((await evaluate('ClaimAutoFillActions.undo()')).count, 1);
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_0').value`), '0');
    // Interact with the actual closed widget through DOM/CDP, not a replacement
    // UI or substituted Chrome APIs. Saving a deselection must survive Preview.
    const widget = await widgetRoot(page, world);
    await widget(`root=>{root.querySelector('.mascot').click();root.querySelector('.preview').click();return true;}`);
    await until(() => widget(`root=>Boolean(root.querySelector('input[data-row-key]'))`), 'widget preview');
    await widget(`root=>{root.querySelector('input[data-row-key]').click();return true;}`);
    const saved = await until(async () => {
      const reply = await evaluate(`chrome.runtime.sendMessage({action:'getReviewDecisions',tid:'SYN-A'})`);
      return reply.value?.selectedKeys?.length === 0 && reply.value;
    }, 'worker-owned review memory');
    await widget(`root=>{root.querySelector('.preview').click();return true;}`);
    await until(() => widget(`root=>root.querySelector('.status').textContent.includes('Restored saved review')`), 'review resumption');
    assert.equal(await widget(`root=>root.querySelector('input[data-row-key]').checked`), false);

    let versions = [];
    browser.listeners.add(message => { if (message.sessionId === options.sessionId && message.method === 'ServiceWorker.workerVersionUpdated') versions = message.params.versions; });
    await options.send('ServiceWorker.enable');
    const version = await until(() => versions.find(item => item.scriptURL === `chrome-extension://${id}/background.js` && item.runningStatus === 'running'), 'extension worker version');
    await options.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    const resumed = await evaluate(`chrome.runtime.sendMessage({action:'getReviewDecisions',tid:'SYN-A'})`);
    assert.equal(resumed.success, true); assert.equal(resumed.value.previewToken, saved.previewToken);
    const other = await browser.page(`${origin}/RGHS/processSheetSearch/SYN-B/`), otherWorld = await contentWorld(other);
    assert.equal((await other.evaluate(`chrome.runtime.sendMessage({action:'getReviewDecisions',tid:'SYN-B'})`, otherWorld)).value, null);

    state.governed = true;
    state.rules = [require('../functions/lib/processing-rules').normalizeRule({ ruleId: 'SYN-RISK', name: 'Synthetic advisory deduction',
      processingArea: 'IPD', enabled: true, priority: 100, enforcement: 'advisory',
      conditions: { operator: 'packagePresent', packageCodes: ['INV-RISK'] },
      actions: [{ type: 'applyDeduction', targetPackageCodes: ['INV-RISK'], calculation: { method: 'percentage', basis: 'claimedAmount', value: 10 } }] })];
    await evaluate(`(()=>{document.getElementById('packageDays_0').textContent='4';document.getElementById('packageAmount_0').textContent='400';
      const row=document.getElementById('packageName_0').closest('tr').cloneNode(true);for(const e of row.querySelectorAll('[id]'))e.id=e.id.replace(/_0$/,'_1');
      row.querySelector('#packageCode_1').textContent='INV-RISK';row.querySelector('#packageAmount_1').textContent='200';row.querySelector('#packageFinalAmount_1').value='0';
      document.querySelector('table').appendChild(row);return true;})()`);
    await widget(`root=>{root.querySelector('.preview').click();return true;}`);
    await until(() => widget(`root=>Boolean(root.querySelector('.decision-buttons'))`), 'advisory decision group');
    await widget(`root=>{[...root.querySelectorAll('.decision-buttons button')].find(b=>b.textContent==='Approve both/all').click();root.querySelector('.safe').click();return true;}`);
    await until(() => widget(`root=>root.querySelector('.status').textContent.includes('remain for review')`), 'continuation after safe Apply');
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_0').value`), '400');
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_1').value`), '0');
    assert.equal(await widget(`root=>root.querySelector('.decision-item input').checked`), true);
    assert.equal(await widget(`root=>root.querySelector('.ack-check').checked`), false);
    await widget(`root=>{root.querySelector('.ack-check').click();root.querySelector('.apply').click();return true;}`);
    await until(() => evaluate(`document.getElementById('packageFinalAmount_1').value==='200'`), 'reviewed remaining Apply');
    await until(() => widget(`root=>root.querySelector('.status').textContent.includes('Recovery was saved')`), 'remaining recovery persistence');
    state.offline = true;
    assert.equal((await evaluate('ClaimAutoFillActions.previewFresh()')).blockReason, 'processing-rules-unavailable');
    assert.equal((await evaluate('ClaimAutoFillActions.undo()')).count, 1);
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_1').value`), '0');
    await until(async () => (await options.evaluate(`chrome.storage.local.get('claimRecoverySnapshots')`)).claimRecoverySnapshots?.length === 1, 'completed Undo bookkeeping');
    assert.equal((await evaluate('ClaimAutoFillActions.restoreRecovery()')).count, 1);
    assert.equal(await evaluate(`document.getElementById('packageFinalAmount_0').value`), '0');
    state.offline = false;
    state.holdLicence = true;
    await options.evaluate(`window.pendingLicence=chrome.runtime.sendMessage({action:'authRefreshLicence'});true`);
    await until(() => state.held.length, 'pending verification');
    assert.equal((await options.evaluate(`chrome.runtime.sendMessage({action:'authSignOut'})`)).success, true);
    state.held.splice(0).forEach(finish => finish()); state.holdLicence = false;
    await options.evaluate('window.pendingLicence');
    const signedOut = await options.evaluate(`chrome.storage.local.get(['authSession','licenceState','processingRuleSet'])`);
    assert.equal(signedOut.authSession, null); assert.equal(signedOut.licenceState, null); assert.equal(signedOut.processingRuleSet, null);
    await until(() => popup.evaluate(`document.getElementById('fillNowBtn').disabled && !document.getElementById('claimAccessStatus').hidden`), 'signed-out popup locks claim tools');
    const afterSignOut = await options.evaluate(`chrome.storage.session.get('claimReviewDecisions')`);
    assert.deepEqual(afterSignOut.claimReviewDecisions, []);
    console.log('PASS: actual extension, worker restart, scoped review resume, multi-tab isolation, safe-row continuation, policy freshness, offline Undo/recovery, sign-out races and review cleanup.');
  } finally {
    state.held.splice(0).forEach(finish => finish());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await closeBrowser(browser, child);
    await cleanupTestDirectory(temporary);
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { BrowserPipe, until };
