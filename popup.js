// Popup script for controlling the extension

const authSignedOut = document.getElementById('authSignedOut');
const authSignUpPanel = document.getElementById('authSignUpPanel');
const authVerifyEmail = document.getElementById('authVerifyEmail');
const authCompleteOnboarding = document.getElementById('authCompleteOnboarding');
const authAwaitingActivation = document.getElementById('authAwaitingActivation');
const authSignedIn = document.getElementById('authSignedIn');
const authEmailInput = document.getElementById('authEmail');
const authPasswordInput = document.getElementById('authPassword');
const authSignInBtn = document.getElementById('authSignInBtn');
const authEmailLabel = document.getElementById('authEmailLabel');
const licenceStatusLabel = document.getElementById('licenceStatusLabel');
const authRecheckBtn = document.getElementById('authRecheckBtn');
const authSignOutBtn = document.getElementById('authSignOutBtn');
const adminPanel = document.getElementById('adminPanel');
const adminOpenDashboardBtn = document.getElementById('adminOpenDashboardBtn');
const adminLicenceOrganization = document.getElementById('adminLicenceOrganization');
const adminMaximumUsers = document.getElementById('adminMaximumUsers');
const adminTermDays = document.getElementById('adminTermDays');
const adminActivateLicenceBtn = document.getElementById('adminActivateLicenceBtn');
const adminInviteEmail = document.getElementById('adminInviteEmail');
const adminInviteRole = document.getElementById('adminInviteRole');
const adminInviteBtn = document.getElementById('adminInviteBtn');
const adminInvitationResult = document.getElementById('adminInvitationResult');
const adminInvitationMessage = document.getElementById('adminInvitationMessage');
const adminCopyInvitationBtn = document.getElementById('adminCopyInvitationBtn');
const adminActivateEmail = document.getElementById('adminActivateEmail');
const adminActivateUserBtn = document.getElementById('adminActivateUserBtn');
const adminOrganizationId = document.getElementById('adminOrganizationId');
const adminOrganizationName = document.getElementById('adminOrganizationName');
const adminOrganizationMaximumUsers = document.getElementById('adminOrganizationMaximumUsers');
const adminOrganizationStatus = document.getElementById('adminOrganizationStatus');
const adminCreateOrganizationBtn = document.getElementById('adminCreateOrganizationBtn');
const adminUpdateOrganizationBtn = document.getElementById('adminUpdateOrganizationBtn');
const adminRefreshOrganizationsBtn = document.getElementById('adminRefreshOrganizationsBtn');
const adminOrganizationsList = document.getElementById('adminOrganizationsList');
const adminRefreshInvitationsBtn = document.getElementById('adminRefreshInvitationsBtn');
const adminInvitationsList = document.getElementById('adminInvitationsList');
const adminRefreshUsersBtn = document.getElementById('adminRefreshUsersBtn');
const adminUsersList = document.getElementById('adminUsersList');
const adminRefreshAuditBtn = document.getElementById('adminRefreshAuditBtn');
const adminAuditList = document.getElementById('adminAuditList');
const adminStatus = document.getElementById('adminStatus');
const showSignUpLink = document.getElementById('showSignUpLink');
const showSignInLink = document.getElementById('showSignInLink');
const signUpEmailInput = document.getElementById('signUpEmail');
const signUpPasswordInput = document.getElementById('signUpPassword');
const signUpConfirmPasswordInput = document.getElementById('signUpConfirmPassword');
const signUpDisplayNameInput = document.getElementById('signUpDisplayName');
const signUpBtn = document.getElementById('signUpBtn');
const verifyEmailLabel = document.getElementById('verifyEmailLabel');
const resendVerificationBtn = document.getElementById('resendVerificationBtn');
const checkVerifiedBtn = document.getElementById('checkVerifiedBtn');
const completeOnboardingError = document.getElementById('completeOnboardingError');
const completeOnboardingNameInput = document.getElementById('completeOnboardingName');
const completeOnboardingBtn = document.getElementById('completeOnboardingBtn');
const checkActivationBtn = document.getElementById('checkActivationBtn');
const cancelSignUpLinks = [
  document.getElementById('cancelSignUpLink1'),
  document.getElementById('cancelSignUpLink2'),
  document.getElementById('cancelSignUpLink3')
];
let showingSignUp = false;
const toggle = document.getElementById('autoFillToggle');
const auditModeSelect = document.getElementById('auditMode');
const fillNowBtn = document.getElementById('fillNowBtn');
const undoBtn = document.getElementById('undoBtn');
const exportLogBtn = document.getElementById('exportLogBtn');
const exportActivityBtn = document.getElementById('exportActivityBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const rulesStatsBtn = document.getElementById('rulesStatsBtn');
const statusMessage = document.getElementById('statusMessage');
const AuditCore = globalThis.RGHSAuditCore;
let previewCount = 0;
let previewToken = null;
let previewRowKeys = [];
let clearArmed = false;
let statusHideTimer = null;
document.getElementById('versionLabel').textContent = `Version ${chrome.runtime.getManifest().version}`;

function setFillButton(label = 'Preview Fill') {
  fillNowBtn.disabled = false;
  fillNowBtn.textContent = label;
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) throw new Error('No active tab');
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// Load initial state
chrome.storage.sync.get(['autoFillEnabled', 'auditMode'], (result) => {
  toggle.checked = result.autoFillEnabled !== false; // Default to true
  auditModeSelect.value = ['off', 'flag', 'deduct'].includes(result.auditMode) ? result.auditMode : 'flag';
});

sendToActiveTab({ action: 'getStatus' })
  .then(response => { undoBtn.disabled = !response?.hasUndo; })
  .catch(() => { undoBtn.disabled = true; });

const authErrorMessages = {
  EMAIL_NOT_FOUND: 'No account found for that email.',
  INVALID_PASSWORD: 'Incorrect password.',
  INVALID_LOGIN_CREDENTIALS: 'Incorrect email or password.',
  USER_DISABLED: 'This account has been disabled. Contact your administrator.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again later.',
  NETWORK_ERROR: 'Unable to reach the sign-in service. Check your connection.',
  EMAIL_EXISTS: 'An account already exists for that email. Try signing in instead.',
  WEAK_PASSWORD: 'Password must be at least 6 characters.',
  INVALID_EMAIL: 'Enter a valid email address.',
  OPERATION_NOT_ALLOWED: 'Account creation is currently disabled. Contact your administrator.'
};

const onboardingErrorMessages = {
  NOT_FOUND: 'No active invitation was found for this email. Ask your administrator to invite this exact address.',
  FAILED_PRECONDITION: 'This invitation is no longer active. Ask your administrator to create a new invitation.',
  DEADLINE_EXCEEDED: 'This invitation has expired. Ask your administrator to create a new invitation.',
  PERMISSION_DENIED: 'The signed-in email does not match the invited email.',
  DISPLAY_NAME_REQUIRED: 'Enter your name to finish setup.'
};

function describeLicenceStatus(state) {
  if (!state) return '';
  if (state.status === 'active') return `Licence active until ${new Date(state.expiresAt).toLocaleString()}`;
  if (state.status === 'grace') return `Licence expired — Preview only until ${new Date(state.graceEndsAt).toLocaleString()}`;
  if (state.status === 'unverified') return 'Verify your email to continue — check your inbox for a link from Firebase.';
  return 'Apply disabled. Contact your administrator.';
}

function renderAuthState(authSession, licenceState, pendingAuth) {
  const pendingStage = pendingAuth?.stage === 'accept-invitation'
    ? 'complete-onboarding'
    : pendingAuth?.stage;
  const stage = authSession
    ? 'signed-in'
    : pendingAuth
      ? pendingStage
      : showingSignUp ? 'sign-up' : 'signed-out';

  authSignedOut.hidden = stage !== 'signed-out';
  authSignUpPanel.hidden = stage !== 'sign-up';
  authVerifyEmail.hidden = stage !== 'verify-email';
  authCompleteOnboarding.hidden = stage !== 'complete-onboarding';
  authAwaitingActivation.hidden = stage !== 'awaiting-activation';
  authSignedIn.hidden = stage !== 'signed-in';
  adminPanel.hidden = stage !== 'signed-in' || authSession?.role !== 'platformAdmin';

  if (stage === 'signed-in') {
    authEmailLabel.textContent = authSession.email || '';
    licenceStatusLabel.textContent = describeLicenceStatus(licenceState);
    if (authSession.role === 'platformAdmin' && authSession.organizationId) {
      adminLicenceOrganization.value = authSession.organizationId;
    }
  }
  if (stage === 'verify-email') {
    verifyEmailLabel.textContent = pendingAuth.email || '';
  }
  if (stage === 'complete-onboarding') {
    completeOnboardingNameInput.value = pendingAuth.displayName || '';
    completeOnboardingError.textContent = pendingAuth.lastError
      ? (onboardingErrorMessages[pendingAuth.lastError] || 'Unable to finish setup. Contact your administrator.')
      : '';
  }
}

function loadAuthState() {
  chrome.storage.local.get(['authSession', 'licenceState', 'pendingAuth'], result => {
    renderAuthState(result.authSession, result.licenceState, result.pendingAuth);
  });
}

loadAuthState();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.authSession && !changes.licenceState && !changes.pendingAuth) return;
  loadAuthState();
});

showSignUpLink.addEventListener('click', event => {
  event.preventDefault();
  showingSignUp = true;
  loadAuthState();
});

showSignInLink.addEventListener('click', event => {
  event.preventDefault();
  showingSignUp = false;
  loadAuthState();
});

for (const link of cancelSignUpLinks) {
  link.addEventListener('click', event => {
    event.preventDefault();
    chrome.runtime.sendMessage({ action: 'authCancelSignUp' }, () => {
      showingSignUp = false;
      loadAuthState();
    });
  });
}

signUpBtn.addEventListener('click', () => {
  const email = signUpEmailInput.value.trim();
  const password = signUpPasswordInput.value;
  const confirmPassword = signUpConfirmPasswordInput.value;
  const displayName = signUpDisplayNameInput.value.trim();
  if (!email || !password || !displayName) {
    showStatus('Enter your invited email, name, and password', 'warning');
    return;
  }
  if (password !== confirmPassword) {
    showStatus('Passwords do not match', 'warning');
    return;
  }
  signUpBtn.disabled = true;
  signUpBtn.textContent = 'Creating account...';
  chrome.runtime.sendMessage({ action: 'authSignUp', email, password, displayName }, response => {
    signUpBtn.disabled = false;
    signUpBtn.textContent = 'Create Account';
    if (!response?.success) {
      showStatus(authErrorMessages[response?.error] || 'Could not create account. Try again.', 'error');
      return;
    }
    signUpPasswordInput.value = '';
    signUpConfirmPasswordInput.value = '';
    showStatus('Account created. Check your email to verify it.', 'success');
    loadAuthState();
  });
});

resendVerificationBtn.addEventListener('click', () => {
  resendVerificationBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'authResendVerification' }, response => {
    resendVerificationBtn.disabled = false;
    showStatus(response?.success ? 'Verification email sent' : 'Unable to resend right now', response?.success ? 'success' : 'error');
  });
});

checkVerifiedBtn.addEventListener('click', () => {
  checkVerifiedBtn.disabled = true;
  checkVerifiedBtn.textContent = 'Checking...';
  chrome.runtime.sendMessage({ action: 'authCheckEmailVerified' }, response => {
    checkVerifiedBtn.disabled = false;
    checkVerifiedBtn.textContent = "I've Verified — Continue";
    if (!response?.success) {
      showStatus('Unable to check verification status right now', 'error');
      return;
    }
    if (!response.emailVerified) {
      showStatus('Not verified yet. Check your inbox (and spam) for the link.', 'warning');
      return;
    }
    showStatus(
      response.error
        ? 'Email verified, but setup needs attention.'
        : (response.stage === 'active' ? 'Email verified. Account ready.' : 'Email verified. Waiting for administrator approval.'),
      response.error ? 'warning' : 'success'
    );
    loadAuthState();
  });
});

completeOnboardingBtn.addEventListener('click', () => {
  const displayName = completeOnboardingNameInput.value.trim();
  if (!displayName) {
    showStatus('Enter your name to finish setup', 'warning');
    return;
  }
  completeOnboardingBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'authCompleteOnboarding', displayName }, response => {
    completeOnboardingBtn.disabled = false;
    if (!response?.success) {
      showStatus('Unable to finish setup right now', 'error');
      return;
    }
    showStatus(
      response.stage === 'active'
        ? 'Setup complete. Signed in.'
        : (response.stage === 'awaiting-activation' ? 'Setup complete. Waiting for administrator approval.' : 'Unable to finish setup'),
      ['active', 'awaiting-activation'].includes(response.stage) ? 'success' : 'error'
    );
    loadAuthState();
  });
});

checkActivationBtn.addEventListener('click', () => {
  checkActivationBtn.disabled = true;
  checkActivationBtn.textContent = 'Checking...';
  chrome.runtime.sendMessage({ action: 'authCheckActivation' }, response => {
    checkActivationBtn.disabled = false;
    checkActivationBtn.textContent = 'Check Status';
    if (!response?.success) {
      showStatus('Unable to check activation status right now', 'error');
      return;
    }
    showStatus(
      response.active
        ? 'Account approved. Signed in.'
        : (response.rejected ? 'Registration rejected. Contact your administrator.' : 'Still waiting for your administrator to approve your account.'),
      response.active ? 'success' : (response.rejected ? 'error' : 'info')
    );
    loadAuthState();
  });
});

authSignInBtn.addEventListener('click', () => {
  const email = authEmailInput.value.trim();
  const password = authPasswordInput.value;
  if (!email || !password) {
    showStatus('Enter both email and password', 'warning');
    return;
  }
  authSignInBtn.disabled = true;
  authSignInBtn.textContent = 'Signing in...';
  chrome.runtime.sendMessage({ action: 'authSignIn', email, password }, response => {
    authSignInBtn.disabled = false;
    authSignInBtn.textContent = 'Sign In';
    if (!response?.success) {
      showStatus(authErrorMessages[response?.error] || 'Sign-in failed. Try again.', 'error');
      return;
    }
    authPasswordInput.value = '';
    showStatus(
      response.requiresEmailVerification
        ? 'Signed in. Verify your email to continue.'
        : response.requiresProfileRecovery
          ? 'Account verified. Confirm your name once to finish setup.'
          : response.awaitingActivation
            ? 'Email verified. Waiting for administrator approval.'
            : 'Signed in',
      response.requiresEmailVerification || response.requiresProfileRecovery || response.awaitingActivation ? 'warning' : 'success'
    );
  });
});

authSignOutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'authSignOut' }, () => {
    authEmailInput.value = '';
    authPasswordInput.value = '';
    showStatus('Signed out', 'info');
  });
});

authRecheckBtn.addEventListener('click', () => {
  authRecheckBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'authRefreshLicence' }, response => {
    authRecheckBtn.disabled = false;
    showStatus(response?.success ? 'Licence rechecked' : 'Unable to recheck licence', response?.success ? 'success' : 'error');
  });
});

function setAdminStatus(message, type = '') {
  adminStatus.textContent = message;
  adminStatus.className = `admin-status ${type}`.trim();
}

function sendAdminAction(action, data, button, pendingLabel) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = pendingLabel;
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action, data }, response => {
      button.disabled = false;
      button.textContent = originalLabel;
      resolve(response || { success: false, error: chrome.runtime.lastError?.message || 'No response' });
    });
  });
}

function adminElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatAdminDate(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'invalid date' : date.toLocaleString();
}

function adminButton(label, action, className = 'btn btn-secondary btn-small') {
  const button = adminElement('button', className, label);
  button.type = 'button';
  button.dataset.adminAction = action;
  return button;
}

function showAdminEmpty(container, message) {
  container.replaceChildren(adminElement('p', 'admin-empty', message));
}

async function loadAdminOrganizations() {
  showAdminEmpty(adminOrganizationsList, 'Loading organizations...');
  const response = await sendAdminAction('adminListOrganizations', {}, adminRefreshOrganizationsBtn, 'Loading...');
  if (!response.success) {
    showAdminEmpty(adminOrganizationsList, `Unable to load: ${response.error}`);
    return;
  }
  const records = response.result.organizations || [];
  adminOrganizationsList.replaceChildren(...records.map(organization => {
    const record = adminElement('article', 'admin-record');
    record.append(
      adminElement('div', 'admin-record-title', `${organization.name} (${organization.organizationId})`),
      adminElement('div', 'admin-record-meta',
        `${organization.status} · maximum ${organization.maximumUsers} · updated ${formatAdminDate(organization.updatedAt)}`)
    );
    const select = adminButton('Edit', 'select-organization');
    select.dataset.organization = JSON.stringify(organization);
    record.append(adminElement('div', 'admin-record-actions')).lastChild.append(select);
    return record;
  }));
  if (!records.length) showAdminEmpty(adminOrganizationsList, 'No organizations found.');
}

async function loadAdminInvitations() {
  showAdminEmpty(adminInvitationsList, 'Loading invitations...');
  const response = await sendAdminAction('adminListInvitations', {}, adminRefreshInvitationsBtn, 'Loading...');
  if (!response.success) {
    showAdminEmpty(adminInvitationsList, `Unable to load: ${response.error}`);
    return;
  }
  const records = response.result.invitations || [];
  adminInvitationsList.replaceChildren(...records.map(invitation => {
    const record = adminElement('article', 'admin-record');
    record.append(
      adminElement('div', 'admin-record-title', invitation.email),
      adminElement('div', 'admin-record-meta',
        `${invitation.status} · ${invitation.role} · ${invitation.organizationId}`),
      adminElement('div', 'admin-record-meta', `Expires ${formatAdminDate(invitation.expiresAt)}`)
    );
    if (invitation.status === 'pending') {
      const actions = adminElement('div', 'admin-record-actions');
      for (const [label, action] of [['Revoke', 'revoke-invitation'], ['Replace', 'replace-invitation']]) {
        const button = adminButton(label, action, action === 'revoke-invitation'
          ? 'btn btn-secondary btn-small admin-danger'
          : 'btn btn-secondary btn-small');
        button.dataset.invitationId = invitation.invitationId;
        button.dataset.email = invitation.email;
        actions.append(button);
      }
      record.append(actions);
    }
    return record;
  }));
  if (!records.length) showAdminEmpty(adminInvitationsList, 'No invitations found.');
}

async function loadAdminUsers() {
  showAdminEmpty(adminUsersList, 'Loading users...');
  const response = await sendAdminAction('adminListUsers', {}, adminRefreshUsersBtn, 'Loading...');
  if (!response.success) {
    showAdminEmpty(adminUsersList, `Unable to load: ${response.error}`);
    return;
  }
  const records = response.result.users || [];
  adminUsersList.replaceChildren(...records.map(user => {
    const record = adminElement('article', 'admin-record');
    record.append(
      adminElement('div', 'admin-record-title', `${user.displayName || 'Unnamed user'} · ${user.email}`),
      adminElement('div', 'admin-record-meta', `${user.accountStatus} · ${user.role} · ${user.organizationId}`)
    );
    if (user.accountStatus !== 'deleted') {
      const actions = adminElement('div', 'admin-record-actions');
      const role = adminElement('select');
      role.dataset.uid = user.uid;
      role.setAttribute('aria-label', `Role for ${user.email}`);
      for (const value of ['processor', 'organizationAdmin', 'platformAdmin']) {
        const option = adminElement('option', '', value);
        option.value = value;
        option.selected = value === user.role;
        role.append(option);
      }
      actions.append(role);
      const changeRole = adminButton('Save role', 'change-role');
      changeRole.dataset.uid = user.uid;
      actions.append(changeRole);
      const statusAction = user.accountStatus === 'active'
        ? 'suspend-user'
        : (user.accountStatus === 'suspended' ? 'reactivate-user' : 'activate-user');
      const statusButton = adminButton(
        user.accountStatus === 'active'
          ? 'Suspend'
          : (user.accountStatus === 'suspended' ? 'Reactivate' : 'Activate'),
        statusAction,
        'btn btn-secondary btn-small'
      );
      statusButton.dataset.uid = user.uid;
      actions.append(statusButton);
      const deleteButton = adminButton('Delete account', 'delete-user', 'btn btn-secondary btn-small admin-danger');
      deleteButton.dataset.uid = user.uid;
      deleteButton.dataset.email = user.email;
      actions.append(deleteButton);
      record.append(actions);
    }
    return record;
  }));
  if (!records.length) showAdminEmpty(adminUsersList, 'No users found.');
}

async function loadAdminAudit() {
  showAdminEmpty(adminAuditList, 'Loading audit events...');
  const response = await sendAdminAction('adminListAuditEvents', {}, adminRefreshAuditBtn, 'Loading...');
  if (!response.success) {
    showAdminEmpty(adminAuditList, `Unable to load: ${response.error}`);
    return;
  }
  const records = response.result.events || [];
  adminAuditList.replaceChildren(...records.map(event => {
    const record = adminElement('article', 'admin-record');
    record.append(
      adminElement('div', 'admin-record-title', event.action || 'unknown action'),
      adminElement('div', 'admin-record-meta',
        `${formatAdminDate(event.timestamp)} · actor ${event.actorId || 'system'}`),
      adminElement('div', 'admin-record-meta',
        event.targetType ? `${event.targetType}: ${event.targetId || 'unknown'}` : (event.result || ''))
    );
    return record;
  }));
  if (!records.length) showAdminEmpty(adminAuditList, 'No audit events found.');
}

async function refreshAdminData() {
  await Promise.all([
    loadAdminOrganizations(),
    loadAdminInvitations(),
    loadAdminUsers(),
    loadAdminAudit()
  ]);
}

adminPanel.addEventListener('toggle', () => {
  if (adminPanel.open) refreshAdminData();
});

adminOpenDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://claimextension-prod.web.app/admin' });
});

adminRefreshOrganizationsBtn.addEventListener('click', loadAdminOrganizations);
adminRefreshInvitationsBtn.addEventListener('click', loadAdminInvitations);
adminRefreshUsersBtn.addEventListener('click', loadAdminUsers);
adminRefreshAuditBtn.addEventListener('click', loadAdminAudit);

adminCreateOrganizationBtn.addEventListener('click', async () => {
  const data = {
    organizationId: adminOrganizationId.value.trim(),
    name: adminOrganizationName.value.trim(),
    maximumUsers: Number(adminOrganizationMaximumUsers.value)
  };
  const response = await sendAdminAction(
    'adminCreateOrganization', data, adminCreateOrganizationBtn, 'Creating...'
  );
  setAdminStatus(response.success ? 'Organization created.' : `Create failed: ${response.error}`,
    response.success ? 'success' : 'error');
  if (response.success) {
    adminLicenceOrganization.value = data.organizationId;
    loadAdminOrganizations();
  }
});

adminUpdateOrganizationBtn.addEventListener('click', async () => {
  const data = {
    organizationId: adminOrganizationId.value.trim(),
    name: adminOrganizationName.value.trim(),
    maximumUsers: Number(adminOrganizationMaximumUsers.value),
    status: adminOrganizationStatus.value
  };
  const response = await sendAdminAction(
    'adminUpdateOrganization', data, adminUpdateOrganizationBtn, 'Updating...'
  );
  setAdminStatus(response.success ? 'Organization updated.' : `Update failed: ${response.error}`,
    response.success ? 'success' : 'error');
  if (response.success) loadAdminOrganizations();
});

adminOrganizationsList.addEventListener('click', event => {
  const button = event.target.closest('[data-admin-action="select-organization"]');
  if (!button) return;
  const organization = JSON.parse(button.dataset.organization);
  adminOrganizationId.value = organization.organizationId;
  adminOrganizationName.value = organization.name;
  adminOrganizationMaximumUsers.value = organization.maximumUsers;
  adminOrganizationStatus.value = organization.status;
  adminLicenceOrganization.value = organization.organizationId;
  setAdminStatus('Organization loaded into the form.', 'success');
});

adminInvitationsList.addEventListener('click', async event => {
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const action = button.dataset.adminAction;
  if (!['revoke-invitation', 'replace-invitation'].includes(action)) return;
  const response = await sendAdminAction(
    action === 'revoke-invitation' ? 'adminRevokeInvitation' : 'adminReplaceInvitation',
    { invitationId: button.dataset.invitationId },
    button,
    action === 'revoke-invitation' ? 'Revoking...' : 'Replacing...'
  );
  if (!response.success) {
    setAdminStatus(`Invitation change failed: ${response.error}`, 'error');
    return;
  }
  if (action === 'replace-invitation') {
    adminInvitationMessage.value = [
      'Your Claim Spark invitation has been replaced.',
      '',
      `Use this email: ${button.dataset.email}`,
      '',
      'Open Claim Spark, create an account with this exact email, and verify it once.',
      'Claim Spark will match the replacement invitation automatically; no code is required.'
    ].join('\n');
    adminInvitationResult.hidden = false;
  }
  setAdminStatus(action === 'revoke-invitation' ? 'Invitation revoked.' : 'Invitation replaced. Send the updated instructions.', 'success');
  loadAdminInvitations();
  loadAdminAudit();
});

adminUsersList.addEventListener('click', async event => {
  const button = event.target.closest('[data-admin-action]');
  if (!button) return;
  const action = button.dataset.adminAction;
  const uid = button.dataset.uid;
  let adminAction;
  let data = { uid };
  if (action === 'change-role') {
    const select = [...adminUsersList.querySelectorAll('select[data-uid]')]
      .find(element => element.dataset.uid === uid);
    if (!select) return;
    adminAction = 'adminChangeUserRole';
    data = { uid, role: select.value };
  } else if (action === 'suspend-user') {
    adminAction = 'adminSuspendUser';
  } else if (action === 'reactivate-user') {
    adminAction = 'adminReactivateUser';
  } else if (action === 'activate-user') {
    adminAction = 'adminActivateUser';
  } else if (action === 'delete-user') {
    if (button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = 'Click again to confirm';
      setAdminStatus(`Deletion is permanent. Click again to delete ${button.dataset.email}.`, 'error');
      return;
    }
    adminAction = 'adminDeleteUserAccount';
    data = { uid, confirmEmail: button.dataset.email };
  } else {
    return;
  }
  const response = await sendAdminAction(adminAction, data, button, 'Working...');
  setAdminStatus(response.success ? 'User updated.' : `User change failed: ${response.error}`,
    response.success ? 'success' : 'error');
  if (response.success) {
    loadAdminUsers();
    loadAdminAudit();
  }
});

adminActivateLicenceBtn.addEventListener('click', async () => {
  const organizationId = adminLicenceOrganization.value.trim();
  const maximumUsers = Number(adminMaximumUsers.value);
  const termDays = Number(adminTermDays.value);
  if (!organizationId || !Number.isInteger(maximumUsers) || maximumUsers < 1 || maximumUsers > 500
      || !Number.isInteger(termDays) || termDays < 1 || termDays > 366) {
    setAdminStatus('Enter an organization, 1-500 users, and a term of 1-366 days.', 'error');
    return;
  }
  const response = await sendAdminAction(
    'adminActivateLicence',
    { organizationId, maximumUsers, termDays },
    adminActivateLicenceBtn,
    'Activating...'
  );
  if (!response.success) {
    setAdminStatus(`Licence activation failed: ${response.error}`, 'error');
    return;
  }
  setAdminStatus(`Licence active for ${termDays} days (maximum ${maximumUsers} users).`, 'success');
  loadAuthState();
});

adminInviteBtn.addEventListener('click', async () => {
  const email = adminInviteEmail.value.trim().toLowerCase();
  const organizationId = adminLicenceOrganization.value.trim();
  const role = adminInviteRole.value;
  adminInvitationResult.hidden = true;
  adminInvitationMessage.value = '';
  if (!email || !organizationId || !['processor', 'organizationAdmin'].includes(role)) {
    setAdminStatus('Enter the user email, organization, and role.', 'error');
    return;
  }
  const response = await sendAdminAction(
    'adminInviteUser',
    { email, organizationId, role },
    adminInviteBtn,
    'Generating...'
  );
  if (!response.success) {
    setAdminStatus(`Invitation failed: ${response?.error || 'Unable to create invitation'}`, 'error');
    return;
  }
  const validHours = Math.round(Number(response.result.expiresInSeconds || 0) / 3600);
  adminInvitationMessage.value = [
    'You have been invited to Claim Spark.',
    '',
    `Use this email: ${email}`,
    'Open Claim Spark and choose "New processor? Create an account".',
    '',
    validHours ? `This invitation expires in ${validHours} hours.` : 'This invitation expires automatically.',
    'Verify this email once. Claim Spark will match the invitation automatically; no invitation code is required.'
  ].join('\n');
  adminInvitationResult.hidden = false;
  setAdminStatus('Email invitation created. Send the instructions to the user.', 'success');
  loadAdminInvitations();
  loadAdminAudit();
});

adminCopyInvitationBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(adminInvitationMessage.value);
    setAdminStatus('Invitation message copied.', 'success');
  } catch {
    adminInvitationMessage.focus();
    adminInvitationMessage.select();
    setAdminStatus('Copy was blocked. The invitation message is selected; press Ctrl+C.', 'error');
  }
});

adminActivateUserBtn.addEventListener('click', async () => {
  const email = adminActivateEmail.value.trim().toLowerCase();
  if (!email) {
    setAdminStatus('Enter the invited user email.', 'error');
    return;
  }
  const response = await sendAdminAction(
    'adminActivateUser',
    { email },
    adminActivateUserBtn,
    'Activating...'
  );
  if (!response.success) {
    setAdminStatus(`User activation failed: ${response.error}`, 'error');
    return;
  }
  setAdminStatus(`${email} is active. Ask the user to click Check Status.`, 'success');
  loadAdminUsers();
  loadAdminAudit();
});

// Handle toggle change
toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;

  // Save to storage
  chrome.storage.sync.set({ autoFillEnabled: enabled });

  // Send message to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    chrome.tabs.sendMessage(tab.id, {
      action: 'toggleAutoFill',
      enabled: enabled
    }, () => {
      if (chrome.runtime.lastError) {
        showStatus('Please refresh the page for changes to take effect', 'warning');
        return;
      }
      showStatus(enabled ? 'Claim tools enabled' : 'Claim tools disabled', 'success');
    });
  } catch (error) {
    showStatus('Please refresh the page', 'warning');
  }
});

// Handle audit mode change (content script picks it up via storage.onChanged)
auditModeSelect.addEventListener('change', () => {
  const mode = auditModeSelect.value;
  chrome.storage.sync.set({ auditMode: mode });
  const labels = {
    off: 'Audit disabled',
    flag: 'Audit: flag-only mode',
    deduct: 'Audit: auto-deduct enabled for allowlisted rules'
  };
  showStatus(`${labels[mode]}. Applies on the next fill.`, mode === 'deduct' ? 'warning' : 'success');
});

function describeCounts(response) {
  const parts = [
    `${response?.approvedCount || 0} amount(s)`,
    `${response?.remarksCount || 0} remark(s)`
  ];
  if (response?.auditDeducted) parts.push(`${response.auditDeducted} audit deduction(s)`);
  if (response?.auditFlagged) parts.push(`${response.auditFlagged} audit flag(s)`);
  return parts.join(', ');
}

function blockedMessage(reason) {
  const messages = {
    'autofill-disabled': 'Claim Extension is OFF. Turn it on, then preview again.',
    'unsupported-layout': 'Unsupported RGHS portal layout. No fields were changed.',
    'invalid-rule-set': 'Audit rule validation failed. Reload a verified build.',
    'signed-out': 'Sign in to Claim Spark to apply changes.',
    'licence-unverified': 'Verify your email to continue — check your inbox for a link from Firebase.',
    'licence-apply-blocked': 'Your licence does not currently allow Apply. Preview remains available if allowed.',
    'licence-preview-blocked': 'Your licence does not currently allow Preview. Contact your administrator.'
  };
  return messages[reason] || 'Apply was blocked because the preview is stale or unsafe. Preview again.';
}

// Handle Fill Now button
fillNowBtn.addEventListener('click', async () => {
  fillNowBtn.disabled = true;
  fillNowBtn.textContent = previewCount > 0 ? 'Applying...' : 'Previewing...';

  try {
    if (previewCount === 0) {
      const response = await sendToActiveTab({ action: 'preview' });
      if (response?.blocked) {
        setFillButton();
        showStatus(blockedMessage(response.blockReason), 'error');
        return;
      }
      const proposals = response?.proposals || [];
      const hasHighRisk = proposals.some(proposal => proposal.risk === 'high');
      previewCount = hasHighRisk ? 0 : proposals.length;
      previewToken = hasHighRisk ? null : response?.token;
      previewRowKeys = hasHighRisk ? [] : proposals.map(proposal => proposal.key);
      if (hasHighRisk) {
        setFillButton();
        showStatus('High-risk findings require per-row review in Claim Spark.', 'warning');
        return;
      }
      if (previewCount > 0) {
        setFillButton(`Apply ${previewCount} Change${previewCount === 1 ? '' : 's'}`);
        showStatus(describeCounts(response), 'info');
      } else {
        setFillButton();
        undoBtn.disabled = !response?.hasUndo;
        showStatus(
          response?.hasUndo ? 'The previous manual fill can be undone.' : 'No eligible empty fields found',
          response?.hasUndo ? 'success' : 'info'
        );
      }
    } else {
      const response = await sendToActiveTab({
        action: 'fillNow',
        token: previewToken,
        selectedRowKeys: previewRowKeys,
        acknowledgedHighRisk: false
      });
      if (response?.blocked) {
        previewCount = 0;
        previewToken = null;
        previewRowKeys = [];
        setFillButton();
        showStatus(blockedMessage(response.blockReason), 'error');
        return;
      }
      previewCount = 0;
      previewToken = null;
      previewRowKeys = [];
      setFillButton();
      undoBtn.disabled = !response?.count;
      showStatus(`Applied: ${describeCounts(response)}`, 'success');
    }
  } catch (error) {
    previewCount = 0;
    previewToken = null;
    previewRowKeys = [];
    setFillButton();
    showStatus('Open an RGHS claim page, then refresh and try again', 'error');
  }
});

undoBtn.addEventListener('click', async () => {
  undoBtn.disabled = true;
  try {
    const response = await sendToActiveTab({ action: 'undo' });
    showStatus(response?.count ? `Restored ${response.count} field(s)` : 'Nothing to undo', response?.count ? 'success' : 'info');
  } catch (error) {
    showStatus('Unable to undo on this page', 'error');
  }
});

// Export the audit log as CSV (no downloads permission needed: blob + anchor)
exportLogBtn.addEventListener('click', () => {
  chrome.storage.local.get(['rghsAuditLog'], result => {
    const log = Array.isArray(result.rghsAuditLog) ? result.rghsAuditLog : [];
    if (log.length === 0) {
      showStatus('Audit log is empty', 'info');
      return;
    }
    const csv = AuditCore.auditLogToCsv(log);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rghs-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${log.length} audit entr${log.length === 1 ? 'y' : 'ies'}`, 'success');
  });
});

exportActivityBtn.addEventListener('click', () => {
  chrome.storage.local.get(['claimActivityLog'], result => {
    const log = Array.isArray(result.claimActivityLog) ? result.claimActivityLog : [];
    if (!log.length) {
      showStatus('Claim activity log is empty', 'info');
      return;
    }
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `claim-activity-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus(`Exported ${log.length} privacy-safe activity event(s)`, 'success');
  });
});

// Two-step clear (popup windows cannot show confirm dialogs reliably)
clearLogBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearLogBtn.textContent = 'Really clear?';
    showStatus('Click again to permanently clear both local logs', 'warning');
    setTimeout(() => {
      clearArmed = false;
      clearLogBtn.textContent = 'Clear Log';
    }, 4000);
    return;
  }
  clearArmed = false;
  clearLogBtn.textContent = 'Clear Log';
  chrome.storage.local.set({ rghsAuditLog: [], claimActivityLog: [] }, () => {
    showStatus('Local audit and activity logs cleared', 'success');
  });
});

// Open the options page: per-rule statistics and auto-deduct promotion toggles
rulesStatsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Show status message
function showStatus(message, type = 'info') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.style.display = 'block';

  if (statusHideTimer !== null) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => {
    statusMessage.style.display = 'none';
    statusHideTimer = null;
  }, 3000);
}
