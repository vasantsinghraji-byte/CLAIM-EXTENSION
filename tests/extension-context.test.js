const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'floating-widget.js'), 'utf8');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('stale floating widget guards Chrome API calls after extension reload', () => {
  assert.match(source, /function hasValidExtensionContext\(\)/);
  assert.match(source, /Refresh this process-sheet page to reconnect Claim Spark Review/);
  assert.match(source, /withValidExtensionContext\(\(\) => chrome\.storage\.local\.set/);
  assert.match(source, /if \(!hasValidExtensionContext\(\)\) return invalidateStaleWidget\(\);[\s\S]*?actions\.previewFresh/);
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
  assert.match(source, /\['CA-01', 'RGHS-IPD-INCOMPLETE-FINAL-DAY'\]\.includes\(group\.id\)/);
  assert.match(source, /policyBadge/);
  assert.match(source, /Apply LAMA\/DAMA/);
  assert.match(source, /proposal\.ruleIds\?\.includes\('RGHS-IPD-LAMA-DAMA-75'\)/);
  assert.match(source, /'RGHS-IPD-INCOMPLETE-FINAL-DAY'/);
});

test('processor-verified investigation quantities are not replaced by a later preview', () => {
  const content = read('content.js');
  assert.match(content, /claimExtensionInvestigationVerified = 'true'/);
  assert.match(content, /investigationVerificationApplied: approvedCell\.dataset\.claimExtensionInvestigationVerified === 'true'/);
  assert.match(content, /if \(record\.investigationVerificationApplied\) continue;/);
});

test('IPD action checklists keep approve, query, and reject remarks separate', () => {
  const content = read('content.js');
  assert.match(source, /Load IPD Remarks/);
  assert.match(source, /IPD_ACTION_LABELS = \{ approve: 'Approve', query: 'Query', reject: 'Reject' \}/);
  assert.match(source, /Fill selected \$\{IPD_ACTION_LABELS\[selectedAction\]\} remarks/);
  assert.match(source, /Add remark/);
  assert.match(source, /Remove/);
  assert.match(source, /claimSparkIpdActionTemplates/);
  assert.match(source, /claimSparkIpdQueryTemplates/);
  assert.match(source, /actions\.appendIpdActionRemarks\?\.\(selectedAction, remarks\)/);
  assert.match(content, /function findIpdActionSelect\(\)/);
  assert.match(content, /function findIpdActionTextBox\(action\)/);
  assert.match(content, /textarea\[id\*="remark" i\]/);
  assert.match(content, /textarea\[id\*="query" i\]/);
  assert.match(content, /function appendIpdActionRemarks\(action, remarks\)/);
  assert.match(content, /function isMainIpdClaimPage\(\)/);
  assert.match(content, /if \(!isMainIpdClaimPage\(\)\) return \{ ok: false, addedCount: 0 \};/);
  assert.match(content, /filter\(remark => remark && !existing\.includes\(remark\)\)/);
  assert.match(source, /IPD queries are available only on the Main IPD claim page\./);
  assert.match(source, /Select Action: \$\{IPD_ACTION_LABELS\[selectedAction\]\} on the Main IPD page first/);
});

test('Main IPD pages can batch-open only same-origin Mandatory and Non-Mandatory Claim Document links', () => {
  const content = read('content.js');
  const background = read('background.js');
  assert.match(source, /Open Review Documents/);
  assert.match(source, /actions\.getReviewDocuments\?\.\(\) \|\| \[\]/);
  assert.match(content, /function getReviewDocuments\(\)/);
  assert.match(content, /Mandatory Claim Documents/);
  assert.match(content, /PreAuth Documents\|Documents for Extended Stay/);
  assert.doesNotMatch(content, /Non-Mandatory Claim Documents\|PreAuth Documents\|Documents for Extended Stay/);
  assert.match(content, /header\.compareDocumentPosition\(link\)/);
  assert.match(content, /documents\.size >= 20/);
  assert.match(background, /request\?\.action === 'openReviewDocuments'/);
  assert.match(background, /parsed\.origin === origin/);
  assert.match(background, /chrome\.tabs\.create\(\{ url, active: false \}/);
});

test('floating widget leaves page zoom under browser control and keeps its own geometry bounded', () => {
  assert.match(source, /function refreshWidgetZoomCompensation\(\)/);
  assert.match(source, /host\.style\.transform = ''/);
  assert.match(source, /host\.dataset\.claimSparkZoomCompensation = '1'/);
  assert.doesNotMatch(source, /chrome\.runtime\.sendMessage\(\{ action: 'getTabZoom' \}/);
});

test('floating widget supports a persistent horizontal resize without relying on page zoom', () => {
  assert.match(source, /class="resize-handle" title="Drag horizontally to resize this panel"/);
  assert.match(source, /class="panel-width panel-wider"/);
  assert.match(source, /Make extension wider/);
  assert.match(source, /const PANEL_MIN_WIDTH = 340/);
  assert.match(source, /const PANEL_WIDTH_STEP = 120/);
  assert.match(source, /function setPanelWidth\(value, \{ persist = true \} = \{\}\)/);
  assert.match(source, /claimSparkPanelWidth/);
  assert.match(source, /resizeHandle\.addEventListener\('pointerdown'/);
});

test('floating widget offers Ctrl-wheel zoom while preserving ordinary list scrolling', () => {
  assert.match(source, /panel\.addEventListener\('wheel', event =>/);
  assert.match(source, /if \(!event\.ctrlKey && !event\.metaKey\) return/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /Ctrl \+ mouse wheel changes the entire widget/);
});

test('floating widget keeps width, whole-widget size, and close controls in its header', () => {
  assert.match(source, /class="panel-width panel-narrower"/);
  assert.match(source, /class="panel-width panel-wider"/);
  assert.match(source, /class="text-size text-smaller"/);
  assert.match(source, /class="text-size text-larger"/);
  assert.match(source, /Decrease widget size/);
});

test('widget size controls scale every widget section together', () => {
  assert.match(source, /\.panel \{[^`]*transform:scale\(var\(--panel-scale, 1\)\)/);
  assert.match(source, /max-height:calc\(\(100vh - 32px\) \/ var\(--claim-spark-page-zoom, 1\) \/ var\(--panel-scale, 1\)\)/);
  assert.match(source, /panel\.style\.setProperty\('--panel-scale', String\(panelScale\)\)/);
  assert.match(source, /displayScale: panelScale/);
});

test('the whole widget uses one scrollbar rather than a nested detail scroller', () => {
  assert.match(source, /overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain/);
  assert.match(source, /\.panel::-webkit-scrollbar/);
  assert.match(source, /reviewList\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/);
  assert.doesNotMatch(source, /panelContent/);
});

test('floating widget starts at normal size and can shrink to expose the process sheet', () => {
  assert.match(source, /const PANEL_SCALE_MIN = 0\.6/);
  assert.match(source, /const PANEL_SCALE_MAX = 1\.5/);
  assert.match(source, /setPanelScale\(1, \{ persist: false \}\)/);
});

test('opening investigation verification reveals its checklist above long review results', () => {
  assert.match(source, /function revealInvestigationChecklist\(\)/);
  assert.match(source, /focusSection\(investigationChecklist, 'investigations'\)/);
  assert.match(source, /renderInvestigationChecklist\(\);\s*revealInvestigationChecklist\(\);/);
});

test('Apply reports a missing preview or selection instead of failing silently', () => {
  assert.match(source, /Preview the current sheet before applying changes\./);
  assert.match(source, /Select at least one proposed row before applying changes\./);
  assert.match(source, /Preview the current sheet before applying safe rows\./);
});

test('Preview returns the widget to its refreshed result summary', () => {
  assert.match(source, /renderPreview\(await \(actions\.previewFresh \? actions\.previewFresh\(\) : actions\.preview\(\)\)\);\s*setSectionCollapsed\(ipdContext, 'ipd-context', true\);\s*setSectionCollapsed\(cardHistory, 'card-history', true\);/);
  assert.match(source, /Unable to prepare this sheet for preview\. Refresh the RGHS page and try again\./);
});

test('widget supports layout reset, collapsible context, and task focus', () => {
  assert.match(source, /function resetWidgetLayout\(\)/);
  assert.match(source, /claimSparkPosition: null/);
  assert.match(source, /function makeSectionCollapsible\(section, id, label\)/);
  assert.match(source, /function focusSection\(section, id\)/);
  assert.match(source, /layoutResetButton\.addEventListener\('click', resetWidgetLayout\)/);
});

test('red high-risk decision groups can jump to their related process-sheet rows', () => {
  const content = read('content.js');
  assert.match(source, /jump\.textContent = group\.proposals\.length === 1 \? 'Jump to row' : 'Jump to related rows'/);
  assert.match(source, /actions\.jumpToRows\?\.\(group\.proposals\.map\(proposal => proposal\.key\)\)/);
  assert.match(content, /jumpToRows\(keys\)/);
});

test('red decision groups present related packages as separate labelled process-sheet rows', () => {
  const content = read('content.js');
  const core = read('claim-core.js');
  assert.match(source, /related process-sheet row/);
  assert.match(source, /className = 'decision-items'/);
  assert.match(source, /proposal\.packageText \|\| proposal\.label/);
  assert.match(source, /Particular: \$\{proposal\.label\}/);
  assert.match(source, /Main package/);
  assert.match(content, /Portal-confirmed package set/);
  assert.match(core, /third\/subsequent procedure \(25%\)/);
});

test('each high-risk decision row can be individually selected and jumped to', () => {
  assert.match(source, /className = 'decision-item-controls'/);
  assert.match(source, /select\.type = 'checkbox'/);
  assert.match(source, /select\.checked \? selectedKeys\.add\(proposal\.key\) : selectedKeys\.delete\(proposal\.key\)/);
  assert.match(source, /itemJump\.textContent = 'Jump'/);
  assert.match(source, /actions\.jumpToRow\(proposal\.key\)/);
  assert.match(source, /Approve ticked rows/);
  assert.match(source, /Review\.decisionForGroup\(group, mode, individuallySelectedKeys\)/);
});

test('companion-verified investigations are removed from the active general preview', () => {
  const content = read('content.js');
  assert.match(content, /claim-autofill:investigations-verified/);
  assert.match(content, /rowIndexes: preview\.entries\.map\(entry => entry\.row\.index\)/);
  assert.match(source, /function removeVerifiedInvestigationsFromPreview\(detail\)/);
  assert.match(source, /claim-autofill:investigations-verified', event => \{/);
  assert.match(source, /investigationChecklist\.dataset\.verified = 'true'/);
});

test('pending-only mode and claim decision memory remain processor-local', () => {
  assert.match(source, /Only Pending Work/);
  assert.match(source, /panel\.classList\.toggle\('pending-only', pendingOnly\)/);
  assert.match(source, /function decisionMemoryKey\(\)/);
  assert.match(source, /chrome\.storage\.session\.set/);
  assert.match(source, /function restoreDecisionMemory\(\)/);
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

test('processor options are read-only for centrally governed rule behavior', () => {
  const options = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.doesNotMatch(options, /action: 'setRuleOverride'/);
  assert.doesNotMatch(background, /request\?\.action === 'setRuleOverride'/);
  assert.doesNotMatch(background, /request\?\.action === 'setCustomRuleConfig'/);
  assert.match(options, /chrome\.storage\.onChanged\.addListener/);
  assert.match(options, /areaName !== 'local'/);
  assert.match(options, /Managed centrally by an authorized administrator/);
  assert.match(options, /processingRuleSet/);
  assert.match(html, /processors cannot change deductions, remarks, rule priority, or rule activation/i);
  assert.doesNotMatch(options, /setCustomRuleConfig|setRuleOverride|resetRuleOverrides/);
});

test('background wires auth-core, the three auth message actions, and the licence-recheck alarm', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(background, /importScripts\('runtime-config\.js', 'auth-core\.js', 'processing-rules\.js'\)/);
  assert.match(background, /request\?\.action === 'authSignIn'/);
  assert.match(background, /request\?\.action === 'authSignOut'/);
  assert.match(background, /request\?\.action === 'authRefreshLicence'/);
  assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(background, /alarm\.name === LICENCE_RECHECK_ALARM/);
  assert.match(background, /transportFailure = error\?\.code === 'NETWORK_ERROR'/);
  assert.match(background, /cached\.checksum !== response\.checksum/);
});

test('background wires verified-email invitation matching and the activation-check chain', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  for (const action of ['authSignUp', 'authResendVerification', 'authCheckEmailVerified', 'authCancelSignUp']) {
    assert.match(background, new RegExp(`request\\?\\.action === '${action}'`));
  }
  assert.match(background, /AuthCore\.signUp\(/);
  assert.match(background, /AuthCore\.updateProfile\(/);
  assert.match(background, /AuthCore\.sendEmailVerification\(/);
  assert.match(background, /AuthCore\.accountInfo\(/);
  assert.match(background, /error\.status === 'PERMISSION_DENIED'/);
  assert.match(background, /name: 'completeInvitationOnboarding'/);
  assert.match(background, /profile\?\.accountStatus === 'invited'/);
  assert.match(background, /profile\?\.accountStatus !== 'active'/);
  assert.match(background, /error\.status === 'NOT_FOUND'/);
  assert.match(background, /requiresProfileRecovery/);
  assert.match(background, /stage: 'awaiting-activation'/);
  assert.doesNotMatch(background, /invitationToken:\s*String/);
});

test('email verification refreshes the ID token before invitation onboarding', () => {
  const background = read('background.js');
  const start = background.indexOf('async function handleCheckEmailVerified');
  const end = background.indexOf('async function handleCompleteOnboarding', start);
  const flow = background.slice(start, end);
  const lookup = flow.indexOf('AuthCore.accountInfo');
  const refresh = flow.indexOf('AuthCore.refreshIdToken');
  const completion = flow.indexOf('attemptCompleteOnboarding');
  assert.ok(lookup >= 0 && refresh > lookup && completion > refresh);
  assert.match(flow, /refreshToken: pending\.refreshToken/);
});

test('sponsored onboarding uses roster credentials while retaining the default path', () => {
  const background = read('background.js');
  const popup = read('popup.html');
  const popupSource = read('popup.js');
  assert.match(background, /name: 'completeOrganizationSponsoredOnboarding'/);
  assert.match(background, /request\?\.action === 'authOrganizationSponsoredOnboarding'/);
  assert.match(popup, /id="authChoosePath"/);
  assert.match(popup, /id="sponsoredOrganizationId"/);
  assert.match(popup, /id="sponsoredEmployeeCode"/);
  assert.match(popup, /id="individualPaymentReference"/);
  assert.match(popup, /official QR supplied with Claim Auto-Fill/);
  assert.match(popupSource, /action: 'authCompleteOnboarding'/);
});

test('individual paid onboarding submits only a bounded payment reference', () => {
  const background = read('background.js');
  const popup = read('popup.html');
  const popupSource = read('popup.js');
  assert.match(background, /name: 'submitPaymentProof'/);
  assert.match(background, /request\?\.action === 'authIndividualPaidOnboarding'/);
  assert.match(popupSource, /action: 'authIndividualPaidOnboarding'/);
  assert.match(popup, /maxlength="160"/);
  assert.match(popup, /YUVAN ENTERPRISES/);
  assert.match(popup, /yuvanent@ybl/);
  assert.match(popup, /official QR supplied with Claim Auto-Fill/i);
  assert.doesNotMatch(popup, /<img[^>]+payment-qr/i);
  for (const plan of ['1 week — ₹99', '2 weeks — ₹198', '4 weeks — ₹300', '12 weeks — ₹500']) {
    assert.match(popup, new RegExp(plan));
  }
  assert.match(popup, /Never enter a UPI PIN, OTP, card number, password, or bank-account credentials/);
});

test('accepted invitations are retry-safe for the same authenticated user', () => {
  const functions = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.match(functions, /invitation\.status === 'accepted'/);
  assert.match(functions, /invitation\.acceptedBy === auth\.uid/);
  assert.match(functions, /alreadyAccepted/);
  assert.match(functions, /recoveredAt/);
});

test('popup uses email-based signup without an invitation-token field', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  for (const action of ['authSignUp', 'authResendVerification', 'authCheckEmailVerified', 'authCancelSignUp']) {
    assert.match(popup, new RegExp(`action: '${action}'`));
  }
  assert.match(popup, /password !== confirmPassword/);
  assert.match(popup, /onboardingErrorMessages/);
  assert.doesNotMatch(html, /signUpInvitationToken/);
  assert.doesNotMatch(html, /acceptInvitationToken/);
  assert.match(html, /Create your account, verify your email once/i);
  assert.doesNotMatch(html, /id="authCompleteOnboarding"/);
  assert.doesNotMatch(html, /id="authAwaitingActivation"/);
  assert.doesNotMatch(popup, /Enter your invited email, name, and password/);
});

test('signed-in individual users can renew and manage their password', () => {
  const background = read('background.js');
  const popup = read('popup.html');
  const popupSource = read('popup.js');
  const auth = read('auth-core.js');
  assert.match(popup, /id="showPasswordResetLink"/);
  assert.match(popup, /id="showChangePasswordBtn"/);
  assert.match(popup, /id="showRenewalBtn"/);
  assert.match(popupSource, /action: 'authSendPasswordReset'/);
  assert.match(popupSource, /action: 'authChangePassword'/);
  assert.match(popupSource, /action: 'authSubmitRenewal'/);
  assert.match(popupSource, /response\?\.message\s*\|\|\s*renewalErrorMessages\[response\?\.error\]/);
  assert.match(background, /AuthCore\.sendPasswordReset/);
  assert.match(background, /AuthCore\.updatePassword/);
  assert.match(background, /async function handleIndividualRenewal/);
  assert.match(background, /message: String\(error\.message \|\| ''\)/);
  assert.match(auth, /requestType: 'PASSWORD_RESET'/);
  assert.match(auth, /returnSecureToken: true/);
});

test('server activates verified self-service registrations under the platform licence', () => {
  const functions = read('functions/index.js');
  assert.match(functions, /exports\.completeInvitationOnboarding = onCall/);
  assert.match(functions, /requireVerifiedEmail\(request\)/);
  assert.match(functions, /SELF_SERVICE_ORGANIZATION_ID = 'platform'/);
  assert.match(functions, /organizationId: SELF_SERVICE_ORGANIZATION_ID/);
  assert.match(functions, /SELF_SERVICE_ROLE = 'processor'/);
  assert.match(functions, /accountStatus: 'active'/);
  assert.match(functions, /onboardingSource: 'self-registration'/);
  assert.match(functions, /activeUsers\.size >= maximumUsers/);
});

test('active onboarding responses can establish the signed-in session immediately', () => {
  const background = read('background.js');
  const popup = read('popup.js');
  assert.match(background, /if \(!onboarding\.activationRequired\)/);
  assert.match(background, /stage: 'active'/);
  assert.match(background, /establishActiveSession\(pending, profile\)/);
  assert.match(popup, /Email verified\. Your account is ready\./);
  assert.match(popup, /Email verified\. Your account is ready\./);
});

test('all popup authentication fields use the full-width accessible input style', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');
  assert.match(css, /\.auth-section input\[type="text"\]/);
  assert.match(css, /min-height:\s*40px/);
});

test('popup and floating widget explain every auth/licence block reason', () => {
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const widget = fs.readFileSync(path.join(__dirname, '..', 'floating-widget.js'), 'utf8');
  for (const reason of ['signed-out', 'licence-unverified', 'licence-apply-blocked']) {
    assert.match(popup, new RegExp(`'${reason}':`));
    assert.match(widget, new RegExp(`'${reason}':`));
  }
});

test('platform administrators get licence, invitation, and user activation controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  for (const id of ['adminPanel', 'adminActivateLicenceBtn', 'adminInviteBtn', 'adminActivateUserBtn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(popup, /authSession\?\.role !== 'platformAdmin'/);
  for (const action of ['adminActivateLicence', 'adminInviteUser', 'adminActivateUser']) {
    assert.match(popup, new RegExp(`'${action}'`));
    assert.match(background, new RegExp(`${action}:`));
  }
  assert.match(html, /id="adminOpenDashboardBtn"/);
  assert.match(html, /<script src="runtime-config\.js"><\/script>/);
  assert.match(popup, /ClaimSparkRuntimeConfig\?\.adminDashboardUrl/);
  assert.match(popup, /chrome\.tabs\.create\(\{ url \}\)/);
  assert.match(background, /adminRejectUserRegistration: 'rejectUserRegistration'/);
  assert.match(popup, /user\.accountStatus === 'active'[\s\S]*'suspend-user'[\s\S]*'activate-user'/);
  assert.match(popup, /user\.accountStatus === 'active'[\s\S]*'Suspend'[\s\S]*'Activate'/);
  assert.match(background, /authSession\.role !== 'platformAdmin'/);
  assert.match(background, /name: functionName/);
  assert.doesNotMatch(background, /invitationToken:\s*result/);
});

test('individual licence controls remain server-enforced while organisation access inherits its licence', () => {
  const functions = read('functions/index.js');
  assert.match(functions, /exports\.setUserLicense = onCall/);
  assert.match(functions, /user\.license_updated/);
  assert.match(functions, /const organizationEntitlement = license\?\.type === 'organisation'/);
  assert.match(functions, /access = organisationAccess/);
  assert.match(functions, /license\.status === 'inactive'/);
  assert.match(functions, /latestUser\.data\(\)\.accountStatus === 'invited'/);
});

test('Phase 4 administrator lifecycle controls are server-routed and rendered safely', () => {
  const popupHtml = read('popup.html');
  const popup = read('popup.js');
  const background = read('background.js');
  const functions = read('functions/index.js');
  for (const id of [
    'adminOrganizationsList',
    'adminInvitationsList',
    'adminUsersList',
    'adminAuditList',
    'adminCreateOrganizationBtn',
    'adminUpdateOrganizationBtn'
  ]) {
    assert.match(popupHtml, new RegExp(`id="${id}"`));
  }
  for (const action of [
    'adminListUsers',
    'adminListInvitations',
    'adminRevokeInvitation',
    'adminReplaceInvitation',
    'adminSuspendUser',
    'adminReactivateUser',
    'adminChangeUserRole',
    'adminDeleteUserAccount',
    'adminCreateOrganization',
    'adminUpdateOrganization',
    'adminListOrganizations',
    'adminListAuditEvents'
  ]) {
    assert.match(background, new RegExp(`${action}:`));
    assert.match(popup, new RegExp(`['"]${action}['"]`));
  }
  for (const callable of [
    'listUsers',
    'listInvitations',
    'revokeInvitation',
    'replaceInvitation',
    'changeUserRole',
    'deleteUserAccount',
    'rejectUserRegistration',
    'updateOrganization',
    'listOrganizations',
    'listAuditEvents'
  ]) {
    assert.match(functions, new RegExp(`exports\\.${callable} = onCall`));
  }
  assert.doesNotMatch(popup, /\.innerHTML\s*=/);
  assert.match(functions, /You cannot suspend your own administrator account/);
  assert.match(functions, /You cannot delete your own administrator account/);
  assert.match(functions, /You cannot change your own administrator role/);
  assert.match(functions, /profile\.accountStatus !== 'active' \|\| profile\.role !== 'platformAdmin'/);
  assert.doesNotMatch(functions, /const auth = requirePlatformAdmin\(request\)/);
});

test('Phase 4 invitation and account deletion controls preserve secret and privacy boundaries', () => {
  const functions = read('functions/index.js');
  assert.match(functions, /invitationId: replacementId/);
  assert.match(functions, /status: 'replaced'/);
  assert.match(functions, /status: 'revoked'/);
  assert.match(functions, /email: `deleted-\$\{uid\}@redacted\.invalid`/);
  assert.match(functions, /await getAuth\(\)\.revokeRefreshTokens\(uid\)/);
  assert.match(functions, /await getAuth\(\)\.deleteUser\(uid\)/);
  assert.doesNotMatch(functions, /token,\s*\n\s*\.\.\.invitation/);
});

test('navigation clears stale badges and popup BOM is explicit', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const popup = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(background, /changeInfo\.status !== 'loading'/);
  assert.match(background, /setTabBadge\(tabId, ''\)/);
  assert.match(background, /setBadgeText\(\{ tabId, text \}, ignoreMissingTabError\)/);
  assert.match(background, /void globalThis\.chrome\?\.runtime\?\.lastError/);
  assert.match(popup, /'\\uFEFF' \+ csv/);
  assert.equal(popup.includes(String.fromCharCode(0xFEFF)), false);
});
