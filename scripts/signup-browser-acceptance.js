#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createBuildEntries, runtimeConfigSource } = require('../build');
const { BrowserPipe, until } = require('./extension-browser-e2e');
const { findChrome } = require('./browser-smoke-e2e');

function cleanup(directory) {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'claim-signup-e2e-')) throw new Error('Unexpected test cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
}

// Actual unpacked extension + actual Auth/Functions/Firestore emulators.
// No production identities, verification emails or customer writes.
async function testSignupBrowser({ db, adminToken, callFunction }) {
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  assert.equal(process.env.GCLOUD_PROJECT, 'demo-claimextension');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-signup-e2e-'));
  const email = `signup-browser-${Date.now()}@claim-spark.local`;
  const password = 'Synthetic!Signup2026';
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><body><input id="transid" value="SIGNUP-QA">
      <table><tr><th>Particular</th><th>Package Code(Package Name)</th><th>Rate</th><th>Unit/Hours/Days</th><th>Claim Amount(Rs.)</th><th>Approved Amount(Rs.)</th><th>Deductions</th><th>Remarks</th><th hidden></th></tr>
      <tr><td hidden>1</td><td id="packageName_0">Investigation</td><td id="packageCode_0">INV-SYN</td><td id="packageRate_0">100</td><td id="packageDays_0">1</td><td id="packageAmount_0">100</td><td><input id="packageFinalAmount_0" name="packageFinalAmounts" type="number" value="0"></td><td>0</td><td><textarea id="packageremarks_0"></textarea></td><td hidden>1</td></tr></table></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, child;
  try {
    const extension = path.join(temporary, 'extension'); fs.mkdirSync(extension);
    const config = { apiKey: 'signup-emulator-key',
      authBaseUrl: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1',
      tokenBaseUrl: 'http://127.0.0.1:9099/securetoken.googleapis.com/v1',
      functionsBaseUrl: 'http://127.0.0.1:5001/demo-claimextension/asia-south1' };
    for (const entry of createBuildEntries({ apiKey: config.apiKey, functionsBaseUrl: 'https://asia-south1-synthetic.cloudfunctions.net' })) {
      const destination = path.join(extension, entry.name); fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (entry.name === 'manifest.json') {
        const manifest = JSON.parse(entry.data);
        manifest.host_permissions = ['http://127.0.0.1/*'];
        manifest.content_scripts.forEach(script => { script.matches = ['http://127.0.0.1/*']; });
        manifest.web_accessible_resources.forEach(resource => { resource.matches = ['http://127.0.0.1/*']; });
        fs.writeFileSync(destination, JSON.stringify(manifest));
      } else fs.writeFileSync(destination, entry.name === 'runtime-config.js' ? runtimeConfigSource(config) : entry.data);
    }
    const chrome = findChrome(); assert(chrome, 'Chrome required');
    child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${path.join(temporary, 'profile')}`],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    browser = new BrowserPipe(child);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: extension });
    const popup = await browser.page(`chrome-extension://${id}/popup.html`);
    await until(() => popup.evaluate(`Boolean(document.getElementById('showSignUpLink')) && typeof renderAuthState==='function'`), 'popup ready');
    const create = `document.getElementById('showSignUpLink').click();document.getElementById('signUpEmail').value=${JSON.stringify(email)};document.getElementById('signUpPassword').value=${JSON.stringify(password)};document.getElementById('signUpConfirmPassword').value=${JSON.stringify(password)};document.getElementById('signUpDisplayName').value='Synthetic Signup Processor';document.getElementById('signUpBtn').click()`;
    await popup.evaluate(create);
    await until(() => popup.evaluate(`!document.getElementById('authVerifyEmail').hidden`), 'pending verification');
    const identity = await popup.evaluate(`chrome.storage.local.get(['authSession','pendingAuth']) .then(s=>({uid:s.pendingAuth?.uid,signedIn:Boolean(s.authSession)}))`);
    assert(identity.uid); assert.equal(identity.signedIn, false);
    await popup.evaluate(`document.getElementById('checkVerifiedBtn').click()`);
    await until(() => popup.evaluate(`document.getElementById('verificationStatus').textContent.includes('Not verified yet')`), 'unverified inline feedback');
    assert.equal(await popup.evaluate(`document.getElementById('verificationStatus').previousElementSibling.querySelector('#checkVerifiedBtn') !== null`), true, 'verification feedback immediately follows its buttons');
    const duplicatePending = await popup.evaluate(`chrome.runtime.sendMessage({action:'authSignUp',email:${JSON.stringify(email)},password:${JSON.stringify(password)},displayName:'Duplicate'})`);
    assert.equal(duplicatePending.error, 'EMAIL_EXISTS');
    assert.equal(await popup.evaluate(`chrome.storage.local.get('pendingAuth').then(s=>s.pendingAuth.uid)`), identity.uid);
    await popup.evaluate(`document.getElementById('cancelSignUpLink1').click()`);
    await until(() => popup.evaluate(`!document.getElementById('authSignedOut').hidden`), 'back to sign in');
    await popup.evaluate(create);
    await until(() => popup.evaluate(`document.getElementById('signUpStatus').textContent.includes('already exists')`), 'Firebase duplicate signup rejected inline');
    assert.equal(await popup.evaluate(`document.getElementById('signUpStatus').previousElementSibling.id`), 'signUpBtn');
    await popup.evaluate(`document.getElementById('showSignInLink').click();document.getElementById('authEmail').value=${JSON.stringify(email)};document.getElementById('authPassword').value=${JSON.stringify(password)};document.getElementById('authSignInBtn').click()`);
    await until(() => popup.evaluate(`!document.getElementById('authVerifyEmail').hidden`), 'unverified sign-in resumes verification');
    await popup.send('Page.navigate', { url: `chrome-extension://${id}/popup.html` });
    await until(() => popup.evaluate(`!document.getElementById('authVerifyEmail')?.hidden && typeof renderAuthState==='function'`), 'verification survives reopening popup');
    const codes = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-claimextension/oobCodes').then(r => r.json());
    const code = codes.oobCodes.find(item => item.email === email && item.requestType === 'VERIFY_EMAIL');
    assert(code, 'Emulator verification code missing');
    const verified = await fetch(`${config.authBaseUrl}/accounts:update?key=${config.apiKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: code.oobCode })
    });
    assert.equal(verified.ok, true);
    await popup.evaluate(`document.getElementById('checkVerifiedBtn').click()`);
    await until(() => popup.evaluate(`!document.getElementById('authChoosePath').hidden`), 'verified account chooses access');
    let profile = (await db.doc(`users/${identity.uid}`).get()).data();
    assert.equal(profile.accountStatus, 'invited'); assert.equal(profile.license.status, 'inactive');
    assert.equal(profile.license.type, 'individual');
    const portal = await browser.page(`${origin}/RGHS/processSheetSearch/SIGNUP-QA/`);
    const world = await until(async () => {
      for (const context of portal.contexts.values()) {
        if (context.auxData?.isDefault) continue;
        try { if (await portal.evaluate('Boolean(globalThis.ClaimAutoFillActions)', context.id)) return context.id; } catch { /* navigation */ }
      }
      return null;
    }, 'actual claim content script');
    assert.equal((await portal.evaluate('ClaimAutoFillActions.previewFresh()', world)).blocked, true, 'unactivated account cannot preview claims');
    await popup.evaluate(`document.getElementById('individualAccessBtn').click();document.getElementById('individualPlan').value='4';document.getElementById('individualPaymentReference').value='SIGNUP-BROWSER-UTR';document.getElementById('submitPaymentReferenceBtn').click()`);
    await until(() => popup.evaluate(`!document.getElementById('authAwaitingActivation').hidden`), 'payment waits for activation');
    await callFunction('setUserLicense', adminToken, { uid: identity.uid, action: 'activate', durationWeeks: 4 }, 'FAILED_PRECONDITION');
    await callFunction('activateUser', adminToken, { uid: identity.uid });
    await popup.evaluate(`document.getElementById('checkActivationBtn').click()`);
    await until(() => popup.evaluate(`!document.getElementById('checkActivationBtn').disabled`), 'activation check finished');
    assert.equal(await popup.evaluate(`document.getElementById('authSignedIn').hidden`), true, 'account approval without licence does not finish activation');
    await callFunction('verifyUserPayment', adminToken, { uid: identity.uid, verified: true });
    assert.equal((await portal.evaluate('ClaimAutoFillActions.previewFresh()', world)).blocked, true, 'payment verification alone does not activate access');
    await callFunction('setUserLicense', adminToken, { uid: identity.uid, action: 'activate', durationWeeks: 4 });
    await popup.evaluate(`document.getElementById('checkActivationBtn').click()`);
    await until(() => popup.evaluate(`!document.getElementById('authSignedIn').hidden`), 'verified paid licence signs in');
    const preview = await portal.evaluate('ClaimAutoFillActions.previewFresh()', world);
    assert.equal(preview.blocked, false); assert(preview.proposals.length);
    const applyOptions = JSON.stringify({ token: preview.token, selectedRowKeys: preview.proposals.map(row => row.key) });
    await callFunction('setUserLicense', adminToken, { uid: identity.uid, action: 'deactivate' });
    const denied = await portal.evaluate(`ClaimAutoFillActions.applyFresh(${applyOptions})`, world);
    assert.equal(denied.blocked, true, 'fresh Apply refuses stale cached active licence');
    assert.equal(await portal.evaluate(`document.getElementById('packageFinalAmount_0').value`, world), '0');
    profile = (await db.doc(`users/${identity.uid}`).get()).data();
    assert.equal(profile.license.status, 'inactive');
    console.log('PASS: actual extension signup, duplicate detection, inline verification feedback, reopen/sign-in recovery, real email-code verification, unpaid locks, payment/activation separation and stale-entitlement Apply denial. Local Firebase emulators only.');
  } finally {
    if (browser) await browser.send('Browser.close').catch(() => {});
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 2000); }); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    cleanup(temporary);
  }
}
module.exports = { testSignupBrowser };
