(function () {
  'use strict';

  const Api = globalThis.ClaimSparkAdminApi;
  const byId = id => document.getElementById(id);
  const signInView = byId('signInView');
  const dashboardView = byId('dashboardView');
  const globalMessage = byId('globalMessage');
  let profile = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, action, data = {}, danger = false) {
    const node = element('button', `button secondary${danger ? ' danger' : ''}`, label);
    node.type = 'button';
    node.dataset.action = action;
    for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
    return node;
  }

  function message(text, type = '') {
    globalMessage.textContent = text;
    globalMessage.className = `message ${type}`.trim();
  }

  function errorText(error) {
    const values = {
      INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect.',
      EMAIL_NOT_FOUND: 'Email or password is incorrect.',
      INVALID_PASSWORD: 'Email or password is incorrect.',
      USER_DISABLED: 'This account is disabled.',
      PERMISSION_DENIED: 'Platform administrator access is required.',
      UNAUTHENTICATED: 'Your session ended. Sign in again.',
      NETWORK_ERROR: 'Network unavailable. Try again.'
    };
    return values[error.message] || error.message || 'Request failed.';
  }

  async function action(name, data, successMessage) {
    try {
      const result = await Api.call(name, data);
      if (successMessage) message(successMessage, 'success');
      return result;
    } catch (error) {
      message(errorText(error), 'error');
      if (error.message === 'UNAUTHENTICATED') showSignedOut();
      return null;
    }
  }

  function formatDate(value) {
    if (!value) return 'not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'invalid date' : date.toLocaleString();
  }

  function empty(container, text) {
    container.replaceChildren(element('p', 'empty', text));
  }

  function showSignedOut() {
    Api.signOut();
    profile = null;
    dashboardView.hidden = true;
    signInView.hidden = false;
    byId('password').value = '';
  }

  async function establishDashboard() {
    const result = await action('getCurrentUserProfile', {});
    if (!result || result.role !== 'platformAdmin' || result.accountStatus !== 'active') {
      showSignedOut();
      byId('signInError').textContent = 'Active platform administrator access is required.';
      return;
    }
    profile = result;
    signInView.hidden = true;
    dashboardView.hidden = false;
    byId('sessionLabel').textContent = `${profile.email} · ${profile.organizationId}`;
    await Promise.all([loadUsers(), loadInvitations(), loadOrganizations(), loadAudit()]);
  }

  async function loadUsers() {
    const pendingContainer = byId('pendingUsersList');
    const usersContainer = byId('usersList');
    empty(pendingContainer, 'Loading pending approvals...');
    empty(usersContainer, 'Loading users...');
    const result = await action('listUsers', {});
    if (!result) {
      empty(pendingContainer, 'Unable to load pending approvals.');
      return empty(usersContainer, 'Unable to load users.');
    }

    function userRecord(user, pending = false) {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${user.displayName || 'Unnamed user'} · ${user.email}`),
        element('p', 'meta', `${pending ? 'pending approval' : user.accountStatus} · ${user.role} · ${user.organizationId}`),
        element('p', 'meta', `Registered ${formatDate(user.createdAt)} · ${user.onboardingSource}`)
      );
      if (user.accountStatus !== 'deleted' && user.uid !== profile.uid) {
        const controls = element('div', 'record-actions');
        if (pending) {
          const approve = button('Approve', 'approve', { uid: user.uid });
          approve.className = 'button primary';
          controls.append(
            approve,
            button('Reject', 'reject', { uid: user.uid, email: user.email }, true)
          );
          record.append(controls);
          return record;
        }
        const role = element('select');
        role.setAttribute('aria-label', `Role for ${user.email}`);
        role.dataset.uid = user.uid;
        for (const value of ['processor', 'organizationAdmin', 'platformAdmin']) {
          const option = element('option', '', value);
          option.value = value;
          option.selected = value === user.role;
          role.append(option);
        }
        const statusLabel = user.accountStatus === 'active' ? 'Suspend' : 'Reactivate';
        const statusAction = user.accountStatus === 'active' ? 'suspend' : 'reactivate';
        controls.append(
          role,
          button('Save role', 'role', { uid: user.uid }),
          button(statusLabel, statusAction, { uid: user.uid }),
          button('Delete account', 'delete', { uid: user.uid, email: user.email }, true)
        );
        record.append(controls);
      }
      return record;
    }

    const users = result.users || [];
    const pendingUsers = users.filter(user => user.pendingApproval);
    const otherUsers = users.filter(user => !user.pendingApproval);
    byId('pendingCount').textContent = `${result.pendingCount ?? pendingUsers.length} pending`;
    pendingContainer.replaceChildren(...pendingUsers.map(user => userRecord(user, true)));
    usersContainer.replaceChildren(...otherUsers.map(user => userRecord(user)));
    if (!pendingUsers.length) empty(pendingContainer, 'No registrations are waiting for approval.');
    if (!otherUsers.length) empty(usersContainer, 'No approved or inactive users found.');
  }

  async function loadInvitations() {
    const container = byId('invitationsList');
    empty(container, 'Loading invitations...');
    const result = await action('listInvitations', {});
    if (!result) return empty(container, 'Unable to load invitations.');
    const records = (result.invitations || []).map(invitation => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', invitation.email),
        element('p', 'meta', `${invitation.status} · ${invitation.role} · ${invitation.organizationId}`),
        element('p', 'meta', `Expires ${formatDate(invitation.expiresAt)}`)
      );
      if (invitation.status === 'pending') {
        const controls = element('div', 'record-actions');
        controls.append(
          button('Revoke', 'revoke', { invitationId: invitation.invitationId }, true),
          button('Replace', 'replace', {
            invitationId: invitation.invitationId,
            email: invitation.email
          })
        );
        record.append(controls);
      }
      return record;
    });
    container.replaceChildren(...records);
    if (!records.length) empty(container, 'No invitations found.');
  }

  async function loadOrganizations() {
    const container = byId('organizationsList');
    empty(container, 'Loading organizations...');
    const result = await action('listOrganizations', {});
    if (!result) return empty(container, 'Unable to load organizations.');
    const records = (result.organizations || []).map(organization => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${organization.name} · ${organization.organizationId}`),
        element('p', 'meta', `${organization.status} · maximum ${organization.maximumUsers}`)
      );
      record.append(button('Edit', 'edit-organization', {
        organization: JSON.stringify(organization)
      }));
      return record;
    });
    container.replaceChildren(...records);
    if (!records.length) empty(container, 'No organizations found.');
  }

  async function loadAudit() {
    const container = byId('auditList');
    empty(container, 'Loading audit events...');
    const result = await action('listAuditEvents', {});
    if (!result) return empty(container, 'Unable to load audit events.');
    const records = (result.events || []).map(event => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', event.action || 'Unknown action'),
        element('p', 'meta', `${formatDate(event.timestamp)} · actor ${event.actorId || 'system'}`),
        element('p', 'meta', event.targetType ? `${event.targetType}: ${event.targetId}` : (event.result || ''))
      );
      return record;
    });
    container.replaceChildren(...records);
    if (!records.length) empty(container, 'No audit events found.');
  }

  function displayInvitation(email, replacement = false) {
    byId('invitationMessage').value = [
      replacement ? 'Your Claim Spark invitation has been replaced.' : 'You have been invited to Claim Spark.',
      '',
      `Use this email: ${email}`,
      '',
      'Open Claim Spark and choose "New processor? Create an account".',
      'Verify this email once. Claim Spark will match the invitation automatically; no invitation code is required.'
    ].join('\n');
    byId('invitationSecret').hidden = false;
  }

  byId('signInForm').addEventListener('submit', async event => {
    event.preventDefault();
    byId('signInError').textContent = '';
    const form = new FormData(event.currentTarget);
    const buttonNode = byId('signInButton');
    buttonNode.disabled = true;
    try {
      await Api.signIn(String(form.get('email')).trim().toLowerCase(), String(form.get('password')));
      await establishDashboard();
    } catch (error) {
      byId('signInError').textContent = errorText(error);
      showSignedOut();
    } finally {
      byId('password').value = '';
      buttonNode.disabled = false;
    }
  });

  byId('signOutButton').addEventListener('click', showSignedOut);
  byId('refreshUsers').addEventListener('click', loadUsers);
  byId('refreshInvitations').addEventListener('click', loadInvitations);
  byId('refreshOrganizations').addEventListener('click', loadOrganizations);
  byId('refreshAudit').addEventListener('click', loadAudit);

  document.querySelector('.tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    for (const buttonNode of document.querySelectorAll('[data-tab]')) {
      buttonNode.classList.toggle('active', buttonNode === tab);
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
  });

  byId('inviteForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim().toLowerCase();
    const result = await action('inviteUser', {
      email,
      organizationId: String(form.get('organizationId')).trim(),
      role: String(form.get('role'))
    }, 'Invitation created. Send the instructions to the user.');
    if (result) {
      displayInvitation(email);
      loadInvitations();
      loadAudit();
    }
  });

  byId('copyInvitation').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('invitationMessage').value);
      message('Invitation message copied.', 'success');
    } catch {
      byId('invitationMessage').select();
      message('Copy was blocked. Press Ctrl+C to copy the selected message.', 'error');
    }
  });

  byId('organizationForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submitter = event.submitter?.value || 'create';
    const data = {
      organizationId: String(form.get('organizationId')).trim(),
      name: String(form.get('name')).trim(),
      maximumUsers: Number(form.get('maximumUsers'))
    };
    if (submitter === 'update') data.status = String(form.get('status'));
    const result = await action(
      submitter === 'update' ? 'updateOrganization' : 'createOrganization',
      data,
      `Organization ${submitter === 'update' ? 'updated' : 'created'}.`
    );
    if (result) {
      loadOrganizations();
      loadAudit();
    }
  });

  byId('licenceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const organizationId = String(form.get('organizationId')).trim();
    const suspend = event.submitter?.value === 'suspend';
    const result = await action(
      suspend ? 'suspendLicence' : 'activateLicence',
      suspend ? { organizationId } : {
        organizationId,
        maximumUsers: Number(form.get('maximumUsers')),
        termDays: Number(form.get('termDays'))
      },
      suspend ? 'Licence suspended.' : 'Licence activated or renewed.'
    );
    if (result) loadAudit();
  });

  byId('usersPanel').addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const uid = control.dataset.uid;
    let result = null;
    if (control.dataset.action === 'approve') {
      result = await action('activateUser', { uid }, 'Registration approved.');
    } else if (control.dataset.action === 'reject') {
      if (control.dataset.armed !== 'true') {
        control.dataset.armed = 'true';
        control.textContent = 'Confirm reject';
        return message(`Rejecting disables ${control.dataset.email}. Click again to confirm.`, 'error');
      }
      result = await action('rejectUserRegistration', { uid }, 'Registration rejected.');
    } else if (control.dataset.action === 'role') {
      const role = [...byId('usersList').querySelectorAll('select[data-uid]')]
        .find(node => node.dataset.uid === uid);
      result = await action('changeUserRole', { uid, role: role.value }, 'User role changed.');
    } else if (control.dataset.action === 'suspend') {
      result = await action('suspendUser', { uid }, 'User suspended.');
    } else if (control.dataset.action === 'reactivate') {
      result = await action('activateUser', { uid }, 'User reactivated.');
    } else if (control.dataset.action === 'delete') {
      if (control.dataset.armed !== 'true') {
        control.dataset.armed = 'true';
        control.textContent = 'Click again to confirm';
        return message(`Deletion is permanent. Click again to delete ${control.dataset.email}.`, 'error');
      }
      result = await action('deleteUserAccount', {
        uid,
        confirmEmail: control.dataset.email
      }, 'User account deleted and profile redacted.');
    }
    if (result) {
      loadUsers();
      loadAudit();
    }
  });

  byId('invitationsList').addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    if (control.dataset.action === 'revoke') {
      const result = await action('revokeInvitation', {
        invitationId: control.dataset.invitationId
      }, 'Invitation revoked.');
      if (result) {
        loadInvitations();
        loadAudit();
      }
    } else if (control.dataset.action === 'replace') {
      const result = await action('replaceInvitation', {
        invitationId: control.dataset.invitationId
      }, 'Invitation replaced. Send the updated instructions.');
      if (result) {
        displayInvitation(control.dataset.email, true);
        loadInvitations();
        loadAudit();
      }
    }
  });

  byId('organizationsList').addEventListener('click', event => {
    const control = event.target.closest('[data-action="edit-organization"]');
    if (!control) return;
    const organization = JSON.parse(control.dataset.organization);
    const form = byId('organizationForm').elements;
    form.organizationId.value = organization.organizationId;
    form.name.value = organization.name;
    form.maximumUsers.value = organization.maximumUsers;
    form.status.value = organization.status;
    message('Organization loaded into the update form.', 'success');
  });

  if (Api.load()) establishDashboard();
})();
