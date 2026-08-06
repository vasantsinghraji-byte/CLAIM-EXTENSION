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
  assert.match(approval, /activeUsers >= maximumUsers/);

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

test('pending count and both dashboard launchers target production administration', () => {
  const functions = read('functions/index.js');
  const dashboardHtml = read('hosting/admin.html');
  const popup = read('popup.js');
  const launcher = read('launch-admin-dashboard.bat');

  assert.match(functions, /pendingCount: users\.filter\(user => user\.pendingApproval\)\.length/);
  assert.match(dashboardHtml, /id="pendingCount"/);
  assert.match(dashboardHtml, /id="pendingUsersList"/);
  assert.match(popup, /adminOpenDashboardBtn/);
  assert.match(popup, /https:\/\/claimextension-prod\.web\.app\/admin/);
  assert.match(launcher, /start "" "https:\/\/claimextension-prod\.web\.app\/admin"/);
});
