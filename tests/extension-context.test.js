const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'floating-widget.js'), 'utf8');

test('stale floating widget guards Chrome API calls after extension reload', () => {
  assert.match(source, /function hasValidExtensionContext\(\)/);
  assert.match(source, /Refresh this process-sheet page to reconnect Claim Spark Review/);
  assert.match(source, /withValidExtensionContext\(\(\) => chrome\.storage\.local\.set/);
  assert.match(source, /withValidExtensionContext\(\(\) => renderPreview\(actions\.preview\(\)\)\)/);
  assert.match(source, /withValidExtensionContext\(\(\) => \{ result = actions\.undo\(\); \}\)/);
  assert.match(source, /if \(!hasValidExtensionContext\(\)\) \{[\s\S]*?invalidateStaleWidget\(\);[\s\S]*?setOpen\(panel\.hidden\)/);
  assert.match(source, /withValidExtensionContext\(\(\) => chrome\.storage\.local\.get/);
  assert.match(source, /withValidExtensionContext\(\(\) => \{[\s\S]*?actions\.hasRecovery/);
});

test('floating widget exposes safe-row automation and grouped decision controls', () => {
  assert.match(source, /Apply Safe Rows Now/);
  assert.match(source, /Review\.groupProposals\(result\.proposals\)/);
  assert.match(source, /Approve both\/all/);
  assert.match(source, /Approve main only/);
  assert.match(source, /Apply package deduction/);
  assert.match(source, /exceptionalGroups\.size === 0 \|\| ackCheck\.checked/);
  assert.match(source, /actions\.highlightDecisionRows\(approvedOverrides\)/);
  assert.match(source, /group\.id === 'CA-01' && recommendedButton/);
});

test('popup and widget explain disabled apply blocks', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  assert.match(popup, /'autofill-disabled': 'Claim Extension is OFF/);
  assert.match(source, /'autofill-disabled': 'BLOCKED: Claim Extension is OFF/);
});

test('popup status messages own one resettable hide timer', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const showStatusSource = popup.slice(popup.indexOf('function showStatus'), popup.length).trim();
  const statusMessage = { textContent: '', className: '', style: { display: 'none' } };
  const timers = new Map();
  const cleared = [];
  let nextTimer = 0;
  const showStatus = Function(
    'statusMessage', 'setTimeout', 'clearTimeout',
    `let statusHideTimer = null; return (${showStatusSource});`
  )(
    statusMessage,
    callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    id => { cleared.push(id); timers.delete(id); }
  );

  showStatus('First', 'info');
  showStatus('Second', 'success');
  assert.deepEqual(cleared, [1]);
  assert.deepEqual([...timers.keys()], [2]);
  assert.equal(statusMessage.textContent, 'Second');
  assert.equal(statusMessage.style.display, 'block');

  timers.get(2)();
  assert.equal(statusMessage.style.display, 'none');
});

test('options updates are serialized and refresh from storage changes', () => {
  const options = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  assert.match(options, /action: 'setRuleOverride'/);
  assert.match(options, /chrome\.storage\.onChanged\.addListener/);
  assert.match(options, /areaName !== 'local'/);
  assert.match(options, /ruleOverrides = normalizeRuleOverrides\(changes\.ruleOverrides\.newValue\)/);
  assert.doesNotMatch(options, /chrome\.storage\.sync\.set\(\{ ruleOverrides \}/);
  assert.match(options, /ensureRuleOverridesMigration/);
  assert.match(options, /Edit remarks/);
  assert.match(options, /builtInRemarkOverrides/);
  assert.match(options, /openBuiltInRemarkEditor/);
});

test('background wires auth-core, the three auth message actions, and the licence-recheck alarm', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(background, /importScripts\('auth-core\.js'\)/);
  assert.match(background, /request\?\.action === 'authSignIn'/);
  assert.match(background, /request\?\.action === 'authSignOut'/);
  assert.match(background, /request\?\.action === 'authRefreshLicence'/);
  assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(background, /alarm\.name === LICENCE_RECHECK_ALARM/);
});

test('background wires the full sign-up, verify-email, accept-invitation, and activation-check chain', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  for (const action of ['authSignUp', 'authResendVerification', 'authCheckEmailVerified', 'authAcceptInvitation', 'authCheckActivation', 'authCancelSignUp']) {
    assert.match(background, new RegExp(`request\\?\\.action === '${action}'`));
  }
  assert.match(background, /AuthCore\.signUp\(/);
  assert.match(background, /AuthCore\.sendEmailVerification\(/);
  assert.match(background, /AuthCore\.accountInfo\(/);
  assert.match(background, /error\.status === 'PERMISSION_DENIED'/);
  assert.match(background, /name: 'acceptInvitation'/);
});

test('popup wires sign-up, verify-email, accept-invitation, and activation-check UI', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  for (const action of ['authSignUp', 'authResendVerification', 'authCheckEmailVerified', 'authAcceptInvitation', 'authCheckActivation', 'authCancelSignUp']) {
    assert.match(popup, new RegExp(`action: '${action}'`));
  }
  assert.match(popup, /password !== confirmPassword/);
  assert.match(popup, /inviteErrorMessages/);
});

test('popup and floating widget explain every auth/licence block reason', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const widget = fs.readFileSync(path.join(__dirname, '..', 'floating-widget.js'), 'utf8');
  for (const reason of ['signed-out', 'licence-unverified', 'licence-apply-blocked']) {
    assert.match(popup, new RegExp(`'${reason}':`));
    assert.match(widget, new RegExp(`'${reason}':`));
  }
});

test('navigation clears stale badges and popup BOM is explicit', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /changeInfo\.status !== 'loading'/);
  assert.match(background, /setBadgeText\(\{ tabId, text: '' \}\)/);
  assert.match(popup, /'\\uFEFF' \+ csv/);
  assert.equal(popup.includes(String.fromCharCode(0xFEFF)), false);
});
