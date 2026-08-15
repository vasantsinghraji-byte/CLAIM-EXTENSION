(function () {
  'use strict';

  const Api = globalThis.ClaimSparkAdminApi;
  const byId = id => document.getElementById(id);
  const signInView = byId('signInView');
  const dashboardView = byId('dashboardView');
  const globalMessage = byId('globalMessage');
  let profile = null;
  let processingRuleDrafts = [];
  let validatedRuleImpact = null;

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
    const seconds = value && typeof value === 'object' ? (value._seconds ?? value.seconds) : null;
    const date = new Date(Number.isFinite(seconds) ? seconds * 1000 : value);
    return Number.isNaN(date.getTime()) ? 'invalid date' : date.toLocaleString();
  }

  function dateMillis(value) {
    const seconds = value && typeof value === 'object' ? (value._seconds ?? value.seconds) : null;
    const millis = Number.isFinite(seconds) ? seconds * 1000 : new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }

  function empty(container, text) {
    container.replaceChildren(element('p', 'empty', text));
  }

  function builderField(labelText, fieldName, value = '', type = 'text') {
    const label = element('label', '');
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = type;
    input.dataset.field = fieldName;
    if (type === 'checkbox') input.checked = value === true;
    else input.value = String(value ?? '');
    label.append(input);
    return label;
  }

  function builderSelect(labelText, fieldName, options, value) {
    const label = element('label', '');
    label.append(document.createTextNode(labelText));
    const select = document.createElement('select');
    select.dataset.field = fieldName;
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      option.selected = optionValue === value;
      select.append(option);
    }
    label.append(select);
    return label;
  }

  function csv(value) {
    return String(value || '').split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
  }

  const conditionOptions = [
    ['all', 'Nested: all conditions'], ['any', 'Nested: any condition'], ['not', 'Nested: not condition'],
    ['packagePresent', 'Package present'], ['packageAbsent', 'Package absent'],
    ['packageCombinationPresent', 'Package combination present'], ['packageCombinationAbsent', 'Package combination absent'],
    ['packageCodeEquals', 'Current package equals'], ['processingOutcomeEquals', 'Processing outcome equals'],
    ['claimedAmountGreaterThan', 'Claimed amount greater than'], ['claimedAmountLessThan', 'Claimed amount less than'],
    ['approvedAmountGreaterThan', 'Approved amount greater than'], ['deductionGreaterThan', 'Deduction greater than']
  ];

  function addConditionRow(item = { operator: 'packagePresent', packageCodes: ['PACKAGE-X'] }, target = byId('conditionBuilder')) {
    const row = element('div', 'builder-row condition-node');
    const operatorField = builderSelect('Condition', 'operator', conditionOptions, item.operator);
    const codesField = builderField('Package codes (comma separated)', 'packageCodes', (item.packageCodes || []).join(', '));
    const valueField = builderField('Value / outcome', 'value', item.value ?? '');
    codesField.classList.add('condition-leaf');
    valueField.classList.add('condition-leaf');
    const nested = element('div', 'builder-list builder-wide condition-children');
    const addNested = button('Add nested condition', 'add-nested-condition');
    addNested.classList.add('condition-group-control');
    const refresh = () => {
      const operator = operatorField.querySelector('select').value;
      const grouped = ['all', 'any', 'not'].includes(operator);
      const packageOperator = operator.startsWith('package');
      codesField.hidden = grouped || operator === 'processingOutcomeEquals';
      valueField.hidden = grouped || packageOperator;
      nested.hidden = !grouped;
      addNested.hidden = !grouped || (operator === 'not' && nested.children.length >= 1);
      if (grouped && !nested.children.length) addConditionRow(undefined, nested);
    };
    operatorField.querySelector('select').addEventListener('change', refresh);
    row.append(operatorField, codesField, valueField, addNested, button('Remove', 'remove-builder-row', {}, true), nested);
    target.append(row);
    const children = item.operator === 'not' ? [item.condition] : item.conditions;
    for (const child of children || []) addConditionRow(child, nested);
    refresh();
  }

  const actionOptions = [
    ['warn', 'Show warning'], ['blockProcessing', 'Block processing'], ['excludePackage', 'Exclude package'],
    ['applyDeduction', 'Apply deduction'], ['writeRemark', 'Write sheet remark'], ['requireValidation', 'Require validation']
  ];

  function addActionRow(item = { type: 'warn', message: 'Review this package before processing.' }) {
    const row = element('div', 'builder-row');
    const typeField = builderSelect('Action', 'type', actionOptions, item.type);
    row.append(
      typeField,
      builderField('Target package codes', 'targetPackageCodes', (item.targetPackageCodes || []).join(', ')),
      builderField('Message / remark template', 'message', item.message || item.template || ''),
      builderField('Validation code', 'validationCode', item.validationCode || ''),
      builderSelect('Deduction method', 'method', [['fixedAmount', 'Fixed amount'], ['percentage', 'Percentage'], ['minimumAmount', 'Minimum amount'], ['fullAmount', 'Full amount']], item.calculation?.method || 'fixedAmount'),
      builderSelect('Deduction basis', 'basis', [['claimedAmount', 'Claimed amount'], ['currentApprovedAmount', 'Current approved amount']], item.calculation?.basis || 'claimedAmount'),
      builderField('Deduction value', 'value', item.calculation?.value ?? 0, 'number'),
      builderField('Cumulative', 'cumulative', item.cumulative === true, 'checkbox'),
      builderSelect('Target sheet', 'sheet', [['OPD', 'OPD'], ['PHARMACY', 'Pharmacy'], ['IPD', 'IPD']], item.target?.sheet || 'OPD'),
      builderSelect('Target column', 'columnKey', [['remarks', 'Remarks'], ['deductionRemarks', 'Deduction remarks'], ['pharmacyRemarks', 'Pharmacy remarks'], ['validationRemarks', 'Validation remarks']], item.target?.columnKey || 'remarks'),
      builderSelect('Write mode', 'writeMode', [['append', 'Append'], ['replace', 'Replace']], item.writeMode || 'append'),
      button('Remove', 'remove-builder-row', {}, true)
    );
    const refresh = () => {
      const type = typeField.querySelector('select').value;
      const visible = new Set(['type']);
      if (['warn', 'blockProcessing'].includes(type)) visible.add('message');
      if (type === 'requireValidation') for (const name of ['message', 'validationCode']) visible.add(name);
      if (type === 'excludePackage') visible.add('targetPackageCodes');
      if (type === 'applyDeduction') for (const name of ['targetPackageCodes', 'method', 'basis', 'value', 'cumulative']) visible.add(name);
      if (type === 'writeRemark') for (const name of ['targetPackageCodes', 'message', 'sheet', 'columnKey', 'writeMode']) visible.add(name);
      for (const field of row.querySelectorAll('[data-field]')) field.closest('label').hidden = !visible.has(field.dataset.field);
    };
    typeField.querySelector('select').addEventListener('change', refresh);
    byId('actionBuilder').append(row);
    refresh();
  }

  function addScenarioRow(item = {}) {
    const line = item.lines?.[0] || {};
    const amounts = Object.entries(item.expected?.approvedAmounts || {}).map(([code, amount]) => `${code}=${amount}`).join(', ');
    const row = element('div', 'builder-row scenario-row');
    row.append(
      builderField('Scenario ID', 'scenarioId', item.scenarioId || 'SCENARIO-1'),
      builderField('Scenario name', 'name', item.name || 'Expected processing outcome'),
      builderSelect('Area', 'processingArea', [['OPD', 'OPD'], ['PHARMACY', 'Pharmacy'], ['IPD', 'IPD']], item.processingArea || 'IPD'),
      builderField('Starting outcome (optional)', 'outcome', item.outcome || ''),
      builderField('Input package codes', 'packageCodes', (line.packageCodes || ['PACKAGE-X']).join(', ')),
      builderField('Claim amount', 'claimAmount', line.claimAmount ?? 1000, 'number'),
      builderField('Current approved amount', 'approvedAmount', line.approvedAmount ?? line.claimAmount ?? 1000, 'number'),
      builderField('Expected matched rule IDs', 'matchedRuleIds', (item.expected?.matchedRuleIds || []).join(', ')),
      builderField('Expected blocked', 'blocked', item.expected?.blocked === true, 'checkbox'),
      builderField('Expected approved amounts (CODE=AMOUNT)', 'approvedAmounts', amounts),
      button('Remove scenario', 'remove-builder-row', {}, true)
    );
    byId('scenarioBuilder').append(row);
  }

  function collectConditions() {
    const collectRow = row => {
      const operator = row.querySelector('[data-field="operator"]').value;
      const directChildren = row.querySelector('.condition-children');
      if (operator === 'all' || operator === 'any') {
        const conditions = [...directChildren.children].map(collectRow);
        if (!conditions.length) throw new Error('Nested condition groups cannot be empty.');
        return { operator, conditions };
      }
      if (operator === 'not') {
        const children = [...directChildren.children];
        if (children.length !== 1) throw new Error('A Not condition must contain exactly one nested condition.');
        return { operator, condition: collectRow(children[0]) };
      }
      const packageCodes = csv(row.querySelector('[data-field="packageCodes"]').value);
      const rawValue = row.querySelector('[data-field="value"]').value.trim();
      if (operator === 'processingOutcomeEquals') return { operator, value: rawValue };
      else if (operator.includes('Amount') || operator === 'deductionGreaterThan') {
        return { operator, value: Number(rawValue), ...(packageCodes.length ? { packageCodes } : {}) };
      }
      return { operator, packageCodes };
    };
    const conditions = [...byId('conditionBuilder').children].map(collectRow);
    if (!conditions.length) throw new Error('Add at least one condition.');
    return conditions.length === 1 ? conditions[0] : { operator: byId('conditionMode').value, conditions };
  }

  function collectActions() {
    const actions = [...byId('actionBuilder').children].map(row => {
      const get = name => row.querySelector(`[data-field="${name}"]`);
      const type = get('type').value;
      const targets = csv(get('targetPackageCodes').value);
      if (type === 'warn' || type === 'blockProcessing') return { type, message: get('message').value.trim() };
      if (type === 'requireValidation') return { type, validationCode: get('validationCode').value.trim().toUpperCase(), message: get('message').value.trim() };
      if (type === 'excludePackage') return { type, targetPackageCodes: targets };
      if (type === 'applyDeduction') return { type, targetPackageCodes: targets, calculation: { method: get('method').value, basis: get('basis').value, value: Number(get('value').value) }, cumulative: get('cumulative').checked };
      return { type, targetPackageCodes: targets, target: { sheet: get('sheet').value, columnKey: get('columnKey').value }, writeMode: get('writeMode').value, template: get('message').value.trim() };
    });
    if (!actions.length) throw new Error('Add at least one action.');
    return actions;
  }

  function collectScenarios() {
    return [...byId('scenarioBuilder').children].map(row => {
      const get = name => row.querySelector(`[data-field="${name}"]`);
      const approvedAmounts = {};
      for (const pair of get('approvedAmounts').value.split(',').map(item => item.trim()).filter(Boolean)) {
        const [code, amount] = pair.split('=').map(item => item.trim());
        if (!code || amount === undefined || !Number.isFinite(Number(amount))) throw new Error('Expected approved amounts must use CODE=AMOUNT.');
        approvedAmounts[code.toUpperCase()] = Number(amount);
      }
      return {
        scenarioId: get('scenarioId').value.trim().toUpperCase(), name: get('name').value.trim(),
        processingArea: get('processingArea').value, ...(get('outcome').value.trim() ? { outcome: get('outcome').value.trim() } : {}),
        lines: [{ packageCodes: csv(get('packageCodes').value), claimAmount: Number(get('claimAmount').value), approvedAmount: Number(get('approvedAmount').value) }],
        expected: { matchedRuleIds: csv(get('matchedRuleIds').value), blocked: get('blocked').checked, approvedAmounts }
      };
    });
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
    await Promise.all([
      loadUsers(), loadInvitations(), loadOrganizations(), loadAudit(),
      loadProcessingRules(), loadProcessingRuleFeedback()
    ]);
  }

  async function loadUsers() {
    const pendingContainer = byId('pendingUsersList');
    const paymentContainer = byId('pendingPaymentsList');
    const expiringContainer = byId('expiringUsersList');
    const usersContainer = byId('usersList');
    empty(pendingContainer, 'Loading pending approvals...');
    empty(paymentContainer, 'Loading payment submissions...');
    empty(expiringContainer, 'Loading expiry warnings...');
    empty(usersContainer, 'Loading users...');
    const result = await action('listUsers', {});
    if (!result) {
      empty(pendingContainer, 'Unable to load pending approvals.');
      return empty(usersContainer, 'Unable to load users.');
    }

    function userRecord(user, pending = false) {
      const record = element('article', 'record');
      const license = user.license || {};
      record.append(
        element('h3', '', `${user.displayName || 'Unnamed user'} · ${user.email}`),
        element('p', 'meta', `${pending ? 'pending approval' : user.accountStatus} · ${user.role} · ${user.organizationId}`),
        element('p', 'meta', `Registered ${formatDate(user.createdAt)} · ${user.onboardingSource}`),
        element('p', 'meta', `License: ${license.type || 'individual'} · ${license.status || 'inactive'} · activated ${formatDate(license.activatedAt)} · expires ${formatDate(license.expiresAt)}`)
      );
      if (license.type === 'individual') {
        record.append(element('p', 'meta', `Payment: ${license.paymentStatus || 'not_required'} · ${license.paymentReference || 'no reference'}`));
      }
      if (user.accountStatus !== 'deleted') {
        const controls = element('div', 'record-actions');
        const durationPreset = element('select');
        durationPreset.dataset.licenseDurationPreset = user.uid;
        durationPreset.setAttribute('aria-label', `License duration preset for ${user.email}`);
        for (const weeks of [1, 2, 4, 12]) {
          const option = element('option', '', `${weeks} week${weeks === 1 ? '' : 's'}`);
          option.value = String(weeks);
          durationPreset.append(option);
        }
        const durationCustom = document.createElement('input');
        durationCustom.type = 'number';
        durationCustom.min = '1';
        durationCustom.max = '52';
        durationCustom.placeholder = 'Custom weeks';
        durationCustom.dataset.licenseDurationCustom = user.uid;
        durationCustom.setAttribute('aria-label', `Custom license duration in weeks for ${user.email}`);
        controls.append(
          durationPreset,
          durationCustom,
          button('Activate license', 'license-activate', { uid: user.uid }),
          button('Extend license', 'license-extend', { uid: user.uid }),
          button('Deactivate license', 'license-deactivate', { uid: user.uid }, true)
        );
        if (user.uid === profile.uid) {
          record.append(controls);
          return record;
        }
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
    const pendingPayments = users.filter(user => user.license?.type === 'individual'
      && user.license?.paymentStatus === 'pending_verification');
    const otherUsers = users.filter(user => !user.pendingApproval);
    const now = Date.now();
    const warningEnd = now + 7 * 24 * 60 * 60 * 1000;
    const expiringUsers = users.filter(user => {
      const expiry = dateMillis(user.license?.expiresAt);
      return user.accountStatus === 'active' && user.license?.status === 'active'
        && Number.isFinite(expiry) && expiry >= now && expiry <= warningEnd;
    });
    byId('pendingCount').textContent = `${result.pendingCount ?? pendingUsers.length} pending`;
    pendingContainer.replaceChildren(...pendingUsers.map(user => userRecord(user, true)));
    paymentContainer.replaceChildren(...pendingPayments.map(user => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${user.displayName || 'Unnamed user'} · ${user.email}`),
        element('p', 'meta', `UPI transaction ID (UTR): ${user.license.paymentReference}`),
        element('p', 'meta', `Selected plan: ${user.license.requestedDurationWeeks} week(s) · expected ₹${user.license.paymentAmount}`),
        element('p', 'meta', `${user.accountStatus} · ${user.organizationId}`),
        button('Verify payment', 'payment-verify', { uid: user.uid }),
        button('Mark unverified', 'payment-decline', { uid: user.uid }, true)
      );
      return record;
    }));
    byId('pendingPaymentCount').textContent = `${pendingPayments.length} pending`;
    byId('expiringUserCount').textContent = `${expiringUsers.length} user${expiringUsers.length === 1 ? '' : 's'}`;
    expiringContainer.replaceChildren(...expiringUsers.map(user => userRecord(user)));
    usersContainer.replaceChildren(...otherUsers.map(user => userRecord(user)));
    if (!pendingUsers.length) empty(pendingContainer, 'No registrations are waiting for approval.');
    if (!pendingPayments.length) empty(paymentContainer, 'No individual payments are waiting for verification.');
    if (!expiringUsers.length) empty(expiringContainer, 'No active user licences expire within seven days.');
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

  async function loadRoster() {
    const container = byId('rosterList');
    const organizationId = byId('rosterForm').elements.organizationId.value.trim();
    if (!organizationId) return empty(container, 'Enter an organization ID, then refresh the roster.');
    empty(container, 'Loading roster...');
    const result = await action('listRoster', { organizationId });
    if (!result) return empty(container, 'Unable to load roster.');
    const records = (result.entries || []).map(entry => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', entry.employeeCode),
        element('p', 'meta', entry.email || 'No bound email'),
        element('p', 'meta', `${entry.status} · ${entry.role} · ${entry.organizationId}`),
        element('p', 'meta', entry.status === 'claimed'
          ? `Claimed ${formatDate(entry.claimedAt)} · user ${entry.claimedByUid}`
          : `Added ${formatDate(entry.createdAt)}`)
      );
      if (entry.status === 'available') {
        record.append(button('Remove', 'remove-roster-entry', {
          organizationId: entry.organizationId,
          employeeCode: entry.employeeCode
        }, true));
      }
      return record;
    });
    container.replaceChildren(...records);
    if (!records.length) empty(container, 'No roster entries found for this organization.');
  }

  function resetRuleEditor() {
    const form = byId('ruleForm');
    form.reset();
    form.elements.ruleId.readOnly = false;
    form.elements.priority.value = '300';
    form.elements.enabled.checked = true;
    byId('conditionMode').value = 'all';
    byId('conditionBuilder').replaceChildren();
    byId('actionBuilder').replaceChildren();
    byId('scenarioBuilder').replaceChildren();
    addConditionRow();
    addActionRow();
  }

  function editProcessingRule(rule) {
    const form = byId('ruleForm');
    form.elements.ruleId.value = rule.ruleId;
    form.elements.ruleId.readOnly = true;
    form.elements.name.value = rule.name;
    form.elements.description.value = rule.description || '';
    form.elements.processingArea.value = rule.processingArea;
    form.elements.priority.value = String(rule.priority);
    form.elements.enforcement.value = rule.enforcement;
    form.elements.enabled.checked = rule.enabled === true;
    byId('conditionBuilder').replaceChildren();
    byId('actionBuilder').replaceChildren();
    byId('scenarioBuilder').replaceChildren();
    const conditions = ['all', 'any'].includes(rule.conditions.operator) ? rule.conditions.conditions : [rule.conditions];
    byId('conditionMode').value = ['all', 'any'].includes(rule.conditions.operator) ? rule.conditions.operator : 'all';
    for (const condition of conditions) addConditionRow(condition);
    for (const item of rule.actions) addActionRow(item);
    for (const scenario of rule.scenarios || []) addScenarioRow(scenario);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderRuleImpact(validation) {
    const container = byId('ruleImpact');
    const impact = validation.impact || {};
    container.replaceChildren(
      element('h3', '', 'Publish impact'),
      element('p', 'meta', `${validation.ruleCount} rule(s) · checksum ${validation.checksum}`),
      element('p', '', `Added: ${(impact.added || []).join(', ') || 'none'}`),
      element('p', '', `Modified: ${(impact.modified || []).join(', ') || 'none'}`),
      element('p', '', `Removed: ${(impact.removed || []).join(', ') || 'none'}`),
      element('p', impact.highImpact?.length ? 'message error' : 'meta',
        `High impact: ${(impact.highImpact || []).join(', ') || 'none'}`),
      element('p', validation.scenarios?.publishable ? 'message success' : (validation.scenarios?.requiredRuleIds?.length ? 'message error' : 'meta'),
        `Synthetic tests: ${validation.scenarios?.total || 0} run, ${validation.scenarios?.failed || 0} failed. Missing coverage: ${(validation.scenarios?.missingRuleIds || []).join(', ') || 'none'}`)
    );
    container.hidden = false;
  }

  async function validateProcessingRules() {
    const result = await action('validateProcessingRuleDrafts', { bundledFallbackEnabled: byId('bundledFallbackEnabled').checked });
    validatedRuleImpact = result;
    byId('publishRules').disabled = !result;
    byId('ruleValidationSummary').textContent = result
      ? `Validated ${result.ruleCount} rule(s).`
      : 'Validation failed.';
    if (result) renderRuleImpact(result);
    return result;
  }

  async function loadProcessingRules() {
    const rulesContainer = byId('rulesList');
    const versionsContainer = byId('ruleVersionsList');
    const historyContainer = byId('ruleHistoryList');
    const approvalsContainer = byId('ruleApprovalsList');
    empty(rulesContainer, 'Loading rule drafts...');
    empty(versionsContainer, 'Loading published versions...');
    empty(historyContainer, 'Loading rule history...');
    empty(approvalsContainer, 'Loading publication approvals...');
    const [draftResult, versionResult, historyResult, approvalResult] = await Promise.all([
      action('listProcessingRuleDrafts', {}),
      action('listProcessingRuleVersions', {}),
      action('listProcessingRuleHistory', {}),
      action('listProcessingRuleApprovals', {})
    ]);
    processingRuleDrafts = draftResult?.rules || [];
    const ruleRecords = processingRuleDrafts.map(rule => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${rule.ruleId} · ${rule.name}`),
        element('p', 'meta', `${rule.enabled ? 'active' : 'inactive'} · ${rule.processingArea} · priority ${rule.priority} · ${rule.enforcement}`),
        element('p', 'meta', rule.description || 'No description')
      );
      const controls = element('div', 'record-actions');
      controls.append(
        button('Edit draft', 'edit-rule', { ruleId: rule.ruleId }),
        button(rule.enabled ? 'Deactivate' : 'Activate', 'toggle-rule', {
          ruleId: rule.ruleId,
          enabled: String(!rule.enabled)
        }, rule.enabled)
      );
      record.append(controls);
      return record;
    });
    rulesContainer.replaceChildren(...ruleRecords);
    if (!ruleRecords.length) empty(rulesContainer, 'No processing-rule drafts found.');

    const versionRecords = (versionResult?.versions || []).map(version => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${version.active ? 'Active · ' : ''}${version.versionId}`),
        element('p', 'meta code-meta', `${version.ruleCount} rule(s) · ${version.checksum}`),
        element('p', 'meta', version.bundledFallbackEnabled
          ? 'Bundled safety fallback retained'
          : 'Central rules only; bundled business fallback disabled'),
        element('p', 'meta', `Published ${formatDate(version.createdAt)} by ${version.createdBy || 'unknown'}`)
      );
      if (!version.active) record.append(button('Activate / roll back', 'activate-rule-version', { versionId: version.versionId }, true));
      return record;
    });
    versionsContainer.replaceChildren(...versionRecords);
    if (!versionRecords.length) empty(versionsContainer, 'No published processing-rule versions found.');

    const historyRecords = (historyResult?.events || []).map(history => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', history.action),
        element('p', 'meta', `${formatDate(history.timestamp)} · ${history.targetId}`),
        element('p', 'meta code-meta', JSON.stringify(history.details || {}))
      );
      return record;
    });
    historyContainer.replaceChildren(...historyRecords);
    if (!historyRecords.length) empty(historyContainer, 'No processing-rule history found.');
    const approvalRecords = (approvalResult?.approvals || []).map(approval => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${approval.status} · ${approval.kind || 'publish'} · ${approval.approvalId}`),
        element('p', 'meta code-meta', approval.checksum),
        element('p', 'meta', `Requested ${formatDate(approval.requestedAt)} by ${approval.requestedBy}; expires ${formatDate(approval.expiresAt)}`),
        element('p', 'meta', `High-impact rules: ${(approval.impact?.highImpact || []).join(', ') || 'fallback control'}`)
      );
      if (approval.status === 'pending' && approval.requestedBy !== profile?.uid) {
        const controls = element('div', 'record-actions');
        controls.append(
          button('Approve and publish', 'approve-rule-publication', { approvalId: approval.approvalId }),
          button('Reject', 'reject-rule-publication', { approvalId: approval.approvalId }, true)
        );
        record.append(controls);
      }
      return record;
    });
    approvalsContainer.replaceChildren(...approvalRecords);
    if (!approvalRecords.length) empty(approvalsContainer, 'No publication approvals found.');
    validatedRuleImpact = null;
    byId('publishRules').disabled = true;
    byId('publishRules').dataset.confirm = '';
    byId('publishRules').textContent = 'Publish validated rules';
    byId('ruleImpact').hidden = true;
  }

  async function loadProcessingRuleFeedback() {
    const container = byId('ruleFeedbackList');
    empty(container, 'Loading processor feedback...');
    const result = await action('listProcessingRuleFeedback', {});
    const records = (result?.feedback || []).map(feedback => {
      const record = element('article', 'record');
      record.append(
        element('h3', '', `${feedback.ruleId} · ${feedback.category}`),
        element('p', 'meta', `${feedback.status} · ${feedback.processingArea} · version ${feedback.ruleSetVersion}`),
        element('p', 'meta', `Packages: ${feedback.packageCodes.join(', ') || 'not supplied'} · submitted ${formatDate(feedback.submittedAt)}`)
      );
      const controls = element('div', 'record-actions');
      for (const status of ['under_review', 'accepted', 'rejected', 'resolved']) {
        if (feedback.status === status) continue;
        controls.append(button(status.replace('_', ' '), 'review-rule-feedback', {
          feedbackId: feedback.feedbackId,
          status
        }));
      }
      record.append(controls);
      return record;
    });
    container.replaceChildren(...records);
    if (!records.length) empty(container, 'No processing-rule feedback found.');
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
  byId('refreshRoster').addEventListener('click', loadRoster);
  byId('refreshRules').addEventListener('click', loadProcessingRules);
  byId('refreshRuleFeedback').addEventListener('click', loadProcessingRuleFeedback);
  byId('refreshAudit').addEventListener('click', loadAudit);

  byId('resetRuleForm').addEventListener('click', resetRuleEditor);
  byId('validateRules').addEventListener('click', validateProcessingRules);
  byId('addCondition').addEventListener('click', () => addConditionRow());
  byId('addAction').addEventListener('click', () => addActionRow());
  byId('addScenario').addEventListener('click', () => addScenarioRow());
  for (const builderId of ['conditionBuilder', 'actionBuilder', 'scenarioBuilder']) {
    byId(builderId).addEventListener('click', event => {
      const remove = event.target.closest('[data-action="remove-builder-row"]');
      if (remove) remove.closest('.builder-row')?.remove();
      const addNested = event.target.closest('[data-action="add-nested-condition"]');
      if (addNested) {
        const row = addNested.closest('.condition-node');
        addConditionRow(undefined, row.querySelector('.condition-children'));
        const operator = row.querySelector('[data-field="operator"]').value;
        if (operator === 'not') addNested.hidden = true;
      }
    });
  }

  byId('ruleForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    let conditions;
    let actions;
    let scenarios;
    try {
      conditions = collectConditions();
      actions = collectActions();
      scenarios = collectScenarios();
    } catch (error) {
      message(error.message || 'Complete the guided rule fields.', 'error');
      return;
    }
    const rule = {
      ruleId: form.elements.ruleId.value.trim().toUpperCase(),
      name: form.elements.name.value.trim(),
      description: form.elements.description.value.trim(),
      schemaVersion: 2,
      processingArea: form.elements.processingArea.value,
      enabled: form.elements.enabled.checked,
      priority: Number(form.elements.priority.value),
      enforcement: form.elements.enforcement.value,
      conditions,
      actions,
      scenarios
    };
    const result = await action('saveProcessingRuleDraft', { rule }, 'Rule draft saved. Publish after reviewing impact.');
    if (result) {
      resetRuleEditor();
      loadProcessingRules();
    }
  });

  byId('publishRules').addEventListener('click', async () => {
    if (!validatedRuleImpact) return;
    const bundledFallbackEnabled = byId('bundledFallbackEnabled').checked;
    const result = await action('publishProcessingRuleDrafts', {
      bundledFallbackEnabled
    });
    if (!result) return;
    message(result.approvalRequired
      ? 'Publication approval requested. A different platform administrator must approve it within 24 hours.'
      : 'Processing rules published. Processors will receive the new version automatically.', 'success');
    loadProcessingRules();
  });

  byId('ruleApprovalsList').addEventListener('click', async event => {
    const buttonNode = event.target.closest('[data-action]');
    if (!buttonNode) return;
    const approvalId = buttonNode.dataset.approvalId;
    if (buttonNode.dataset.action === 'approve-rule-publication') {
      const result = await action('approveProcessingRulePublication', { approvalId }, 'Approved and published. Processors will receive the new version automatically.');
      if (result) loadProcessingRules();
    }
    if (buttonNode.dataset.action === 'reject-rule-publication') {
      const result = await action('rejectProcessingRulePublication', { approvalId }, 'Publication request rejected.');
      if (result) loadProcessingRules();
    }
  });

  byId('rulesList').addEventListener('click', async event => {
    const buttonNode = event.target.closest('[data-action]');
    if (!buttonNode) return;
    if (buttonNode.dataset.action === 'edit-rule') {
      const rule = processingRuleDrafts.find(item => item.ruleId === buttonNode.dataset.ruleId);
      if (rule) editProcessingRule(rule);
      return;
    }
    if (buttonNode.dataset.action === 'toggle-rule') {
      const result = await action('setProcessingRuleStatus', {
        ruleId: buttonNode.dataset.ruleId,
        enabled: buttonNode.dataset.enabled === 'true'
      }, 'Rule draft status updated. Publish to make the change active.');
      if (result) loadProcessingRules();
    }
  });

  byId('ruleVersionsList').addEventListener('click', async event => {
    const buttonNode = event.target.closest('[data-action="activate-rule-version"]');
    if (!buttonNode) return;
    if (buttonNode.dataset.confirm !== 'true') {
      buttonNode.dataset.confirm = 'true';
      buttonNode.textContent = 'Confirm activation';
      message('Activating this immutable version changes processing for every processor.', 'error');
      return;
    }
    const result = await action('activateProcessingRuleVersion', { versionId: buttonNode.dataset.versionId });
    if (result) {
      message(result.approvalRequired
        ? 'Activation approval requested. A different platform administrator must approve it within 24 hours.'
        : 'Published rule version activated.', 'success');
      loadProcessingRules();
    }
  });

  byId('ruleFeedbackList').addEventListener('click', async event => {
    const buttonNode = event.target.closest('[data-action="review-rule-feedback"]');
    if (!buttonNode) return;
    const status = buttonNode.dataset.status;
    const result = await action('reviewProcessingRuleFeedback', {
      feedbackId: buttonNode.dataset.feedbackId,
      status,
      resolution: status === 'resolved' ? 'rule_updated' : null
    }, 'Rule feedback updated.');
    if (result) loadProcessingRuleFeedback();
  });

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
    if (result) {
      loadOrganizations();
      loadAudit();
    }
  });

  byId('rosterForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await action('addRosterEntry', {
      organizationId: String(form.get('organizationId')).trim(),
      employeeCode: String(form.get('employeeCode')).trim(),
      email: String(form.get('email')).trim().toLowerCase(),
      role: String(form.get('role'))
    }, 'Roster entry added.');
    if (result) {
      event.currentTarget.elements.employeeCode.value = '';
      event.currentTarget.elements.email.value = '';
      loadRoster();
      loadAudit();
    }
  });

  byId('bulkRosterForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = String(form.get('csv')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0]?.toLowerCase().replace(/\s/g, '') === 'employeecode,email,role') lines.shift();
    if (!lines.length || lines.length > 100) return message('CSV must contain between 1 and 100 data rows.', 'error');
    const entries = [];
    for (let index = 0; index < lines.length; index++) {
      const columns = lines[index].split(',').map(value => value.trim());
      if (columns.length !== 3 || !columns.every(Boolean)) {
        return message(`CSV row ${index + 1} must contain employeeCode,email,role.`, 'error');
      }
      entries.push({ employeeCode: columns[0], email: columns[1].toLowerCase(), role: columns[2] });
    }
    const organizationId = String(form.get('organizationId')).trim();
    const result = await action('bulkAddRosterEntries', { organizationId, entries }, 'Roster CSV imported.');
    if (result) {
      event.currentTarget.elements.csv.value = '';
      byId('rosterForm').elements.organizationId.value = organizationId;
      message(`Roster import complete: ${result.created} created, ${result.updated} updated.`, 'success');
      loadRoster();
      loadAudit();
    }
  });

  byId('rosterList').addEventListener('click', async event => {
    const control = event.target.closest('[data-action="remove-roster-entry"]');
    if (!control) return;
    if (control.dataset.armed !== 'true') {
      control.dataset.armed = 'true';
      control.textContent = 'Confirm remove';
      return message(`Remove roster code ${control.dataset.employeeCode}? Click again to confirm.`, 'error');
    }
    const result = await action('removeRosterEntry', {
      organizationId: control.dataset.organizationId,
      employeeCode: control.dataset.employeeCode
    }, 'Roster entry removed.');
    if (result) {
      loadRoster();
      loadAudit();
    }
  });

  byId('usersPanel').addEventListener('click', async event => {
    const control = event.target.closest('[data-action]');
    if (!control) return;
    const uid = control.dataset.uid;
    let result = null;
    if (control.dataset.action === 'approve') {
      result = await action('activateUser', { uid }, 'Registration approved.');
    } else if (control.dataset.action === 'payment-verify') {
      result = await action('verifyUserPayment', { uid, verified: true }, 'Payment verified. Approve the account and activate its license for the purchased term.');
    } else if (control.dataset.action === 'payment-decline') {
      const reason = globalThis.prompt('Reason shown in the audit record (required):', 'UPI transaction could not be verified');
      if (!reason?.trim()) return message('A reason is required to mark a payment unverified.', 'error');
      result = await action('verifyUserPayment', {
        uid,
        verified: false,
        reason: reason.trim()
      }, 'Payment remains unverified. Ask the user to check and resubmit the UTR.');
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
    } else if (['license-activate', 'license-extend', 'license-deactivate'].includes(control.dataset.action)) {
      const record = control.closest('.record');
      const custom = Number(record.querySelector(`[data-license-duration-custom="${uid}"]`)?.value);
      const preset = Number(record.querySelector(`[data-license-duration-preset="${uid}"]`)?.value);
      const licenseAction = control.dataset.action.replace('license-', '');
      const data = { uid, action: licenseAction };
      if (licenseAction !== 'deactivate') {
        data.durationWeeks = Number.isInteger(custom) && custom >= 1 && custom <= 52 ? custom : preset;
      }
      const success = { activate: 'activated', extend: 'extended', deactivate: 'deactivated' }[licenseAction];
      result = await action('setUserLicense', data, `User license ${success}.`);
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

  resetRuleEditor();
  if (Api.load()) establishDashboard();
})();
