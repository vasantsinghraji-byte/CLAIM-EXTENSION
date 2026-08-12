'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('verified registration is pending until an audited administrator approval', () => {
  const functions = read('functions/index.js');
  const dashboard = read('hosting/admin.js');
  const background = read('background.js');

  const registration = functions.slice(
    functions.indexOf('exports.completeInvitationOnboarding'),
    functions.indexOf('async function resolveUid')
  );
  assert.match(registration, /accountStatus: 'invited'/);
  assert.match(registration, /user\.registration_requested/);

  const approval = functions.slice(
    functions.indexOf('exports.activateUser'),
    functions.indexOf('exports.rejectUserRegistration')
  );
  assert.match(approval, /accountStatus: 'active'/);
  assert.match(approval, /user\.registration_approved/);
  assert.match(approval, /transaction\.get\(activeUsersQuery\)/);
  assert.match(approval, /activeUsers\.size >= maximumUsers/);
  assert.match(approval, /expiryDate\) < Date\.now\(\)/);
  assert.match(approval, /latestUser\.data\(\)\.accountStatus === 'invited'/);

  assert.match(functions, /exports\.setUserLicense = onCall/);
  assert.match(functions, /action === 'activate'/);
  assert.match(functions, /action === 'extend'/);
  assert.match(functions, /status: 'inactive'/);

  assert.match(dashboard, /pendingUsersList/);
  assert.match(dashboard, /action\('activateUser', \{ uid \}, 'Registration approved\.'\)/);
  assert.match(background, /profile\?\.accountStatus !== 'active'/);
  assert.match(background, /establishActiveSession\(pending, profile\)/);
});

test('administrator rejection disables the pending identity and is audited end to end', () => {
  const functions = read('functions/index.js');
  const dashboard = read('hosting/admin.js');
  const popup = read('popup.js');

  const rejection = functions.slice(
    functions.indexOf('exports.rejectUserRegistration'),
    functions.indexOf('exports.suspendUser')
  );
  assert.match(rejection, /user\.accountStatus !== 'invited'/);
  assert.match(rejection, /accountStatus: 'rejected'/);
  assert.match(rejection, /updateUser\(uid, \{ disabled: true \}\)/);
  assert.match(rejection, /user\.registration_rejected/);

  assert.match(dashboard, /Confirm reject/);
  assert.match(dashboard, /action\('rejectUserRegistration', \{ uid \}, 'Registration rejected\.'\)/);
  assert.match(popup, /Registration rejected\. Contact your administrator\./);
});

test('sponsored roster claims are single-use and activate a matching user license on approval', () => {
  const functions = read('functions/index.js');
  const onboarding = functions.slice(
    functions.indexOf('exports.completeOrganizationSponsoredOnboarding'),
    functions.indexOf('async function resolveUid')
  );
  assert.match(onboarding, /db\.doc\(`orgRoster\/\$\{rosterId\}`\)/);
  assert.match(onboarding, /roster\.status !== 'available'/);
  assert.match(onboarding, /roster\.email !== authenticatedEmail/);
  assert.match(onboarding, /status: 'claimed'/);
  assert.match(onboarding, /claimedByUid: auth\.uid/);
  assert.match(onboarding, /type: 'organisation'/);

  const rosterAdministration = functions.slice(
    functions.indexOf('exports.addRosterEntry'),
    functions.indexOf('exports.removeRosterEntry')
  );
  assert.match(rosterAdministration, /existing\.data\(\)\.status !== 'available'/);
  assert.match(rosterAdministration, /transaction\.update\(reference, \{[\s\S]*?email,[\s\S]*?role/);

  const approval = functions.slice(
    functions.indexOf('exports.activateUser'),
    functions.indexOf('exports.addRosterEntry')
  );
  assert.match(approval, /latestLicense\?\.type === 'organisation'/);
  assert.match(approval, /status: 'active'/);
  assert.match(approval, /paymentStatus: 'not_required'/);
  assert.match(approval, /expiresAt: licenceSnapshot\.data\(\)\.expiryDate/);
});

test('individual payment submission, verification, and license activation stay separate', () => {
  const functions = read('functions/index.js');
  const dashboard = read('hosting/admin.js');
  const background = read('background.js');

  const submission = functions.slice(
    functions.indexOf('exports.submitPaymentProof'),
    functions.indexOf('exports.verifyUserPayment')
  );
  assert.match(submission, /requireVerifiedEmail\(request\)/);
  assert.match(submission, /submitPaymentProof', 5/);
  assert.match(submission, /paymentStatus: 'pending_verification'/);
  assert.match(submission, /paymentProvider: 'upi'/);
  assert.match(submission, /individualPlan\(data\.durationWeeks\)/);
  assert.match(submission, /paymentClaims\/\$\{tokenHash\(paymentReference\)\}/);
  assert.match(submission, /paymentClaim\.data\(\)\.uid !== auth\.uid/);
  assert.match(submission, /requestedDurationWeeks: plan\.durationWeeks/);
  assert.match(submission, /paymentAmount: plan\.price/);
  assert.match(submission, /user\.payment_submitted/);

  const verification = functions.slice(
    functions.indexOf('exports.verifyUserPayment'),
    functions.indexOf('exports.deleteUserAccount')
  );
  assert.match(verification, /requirePlatformAdmin\(request\)/);
  assert.match(verification, /user\.payment_verified/);
  assert.doesNotMatch(verification, /setUserLicense/);

  assert.match(functions, /Individual payment must be verified before license activation/);
  assert.match(functions, /License duration must match the verified individual plan/);
  assert.match(dashboard, /action\('verifyUserPayment', \{ uid, verified: true \}/);
  assert.match(dashboard, /action\('verifyUserPayment', \{[\s\S]*verified: false/);
  assert.match(background, /name: 'submitPaymentProof'/);
});

test('licence policy and filtered administration queries are enforced server-side', () => {
  const functions = read('functions/index.js');
  const verification = functions.slice(
    functions.indexOf('exports.verifyLicence'),
    functions.indexOf('exports.getExtensionConfig')
  );
  assert.match(verification, /config\.maintenanceMode === true/);
  assert.match(verification, /compareSemanticVersions\(extensionVersion, minimumVersion\) < 0/);

  for (const exportName of ['listUsers', 'listInvitations']) {
    const start = functions.indexOf(`exports.${exportName}`);
    const end = functions.indexOf('exports.', start + 8);
    const listing = functions.slice(start, end);
    assert.ok(
      listing.indexOf("where('organizationId', '==', organizationId)") < listing.indexOf('.limit(ADMIN_LIST_LIMIT)'),
      `${exportName} must filter by organization before limiting results`
    );
  }
});

test('pending count and dashboard launchers use their explicit environment targets', () => {
  const functions = read('functions/index.js');
  const dashboardHtml = read('hosting/admin.html');
  const popup = read('popup.js');
  const launcher = read('launch-admin-dashboard.bat');

  assert.match(functions, /pendingCount: users\.filter\(user => user\.pendingApproval\)\.length/);
  assert.match(dashboardHtml, /id="pendingCount"/);
  assert.match(dashboardHtml, /id="pendingUsersList"/);
  assert.match(popup, /adminOpenDashboardBtn/);
  assert.match(popup, /ClaimSparkRuntimeConfig\?\.adminDashboardUrl/);
  assert.match(launcher, /start "" "https:\/\/claimextension-prod\.web\.app\/admin"/);
});
