'use strict';

const crypto = require('node:crypto');

const ROLES = Object.freeze(['processor', 'organizationAdmin', 'platformAdmin']);
const INVITABLE_ROLES = Object.freeze(['processor', 'organizationAdmin']);
const ACCOUNT_STATUSES = Object.freeze(['invited', 'active', 'suspended', 'deleted']);
const LICENCE_STATUSES = Object.freeze(['active', 'suspended', 'expired']);
const ORGANIZATION_STATUSES = Object.freeze(['active', 'suspended']);
const EVENT_ACTIONS = Object.freeze([
  'extension_opened',
  'licence_checked',
  'preview_created',
  'apply_completed',
  'undo_completed'
]);
const FORBIDDEN_KEYS = new Set([
  'patient',
  'patientname',
  'tid',
  'transactionid',
  'claimid',
  'claimamount',
  'approvedamount',
  'deductionamount',
  'diagnosis',
  'treatment',
  'remark',
  'remarks',
  'portalurl',
  'url'
]);

function callableData(request) {
  const data = request && typeof request.data === 'object' && request.data !== null
    ? request.data
    : {};
  return data;
}

function assertKeys(data, allowed, required = []) {
  const keys = Object.keys(data);
  const unknown = keys.filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown field: ${unknown[0]}`);
  const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(data, key));
  if (missing.length) throw new Error(`Missing field: ${missing[0]}`);
}

function requiredString(value, name, maximum = 200) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${name} is invalid`);
  return normalized;
}

function normalizedEmail(value) {
  const email = requiredString(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is invalid');
  return email;
}

function enumValue(value, name, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} is invalid`);
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function assertNoClaimContent(value, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoClaimContent(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`Claim content is forbidden: ${path}.${key}`);
    assertNoClaimContent(child, `${path}.${key}`);
  }
}

function invitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(requiredString(token, 'token', 512)).digest('hex');
}

function safeDocumentId(value, name = 'id') {
  const id = requiredString(value, name, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${name} is invalid`);
  return id;
}

// activateUser accepts either a uid or an email (never both/neither) so an
// admin activating an invited processor doesn't need to look up their uid in
// the console first. The actual Auth lookup for the email case stays in
// index.js (Admin SDK I/O); this only validates the request shape.
function resolveActivationTarget(data) {
  const hasUid = Object.prototype.hasOwnProperty.call(data, 'uid');
  const hasEmail = Object.prototype.hasOwnProperty.call(data, 'email');
  if (hasUid === hasEmail) throw new Error('Provide exactly one of uid or email');
  return hasUid
    ? { by: 'uid', value: safeDocumentId(data.uid, 'uid') }
    : { by: 'email', value: normalizedEmail(data.email) };
}

function selectEmailInvitation(records, uid, now = Date.now()) {
  const candidates = records
    .filter(record => (record.status === 'accepted' && record.acceptedBy === uid)
      || (record.status === 'pending' && Number.isFinite(record.expiresAtMs) && record.expiresAtMs >= now))
    .sort((left, right) => (right.createdAtMs || 0) - (left.createdAtMs || 0));
  return candidates.find(record => record.status === 'accepted' && record.acceptedBy === uid)
    || candidates.find(record => record.status === 'pending')
    || null;
}

function licenceAccessDecision({ status, expiryMs, now, gracePeriodMs }) {
  if (status === 'suspended') {
    return { status: 'suspended', previewAllowed: false, applyAllowed: false };
  }
  if (status === 'active' && Number.isFinite(expiryMs) && expiryMs >= now) {
    return { status: 'active', previewAllowed: true, applyAllowed: true };
  }
  if (Number.isFinite(expiryMs) && expiryMs < now && expiryMs + gracePeriodMs >= now) {
    return { status: 'grace', previewAllowed: true, applyAllowed: false };
  }
  return { status: 'expired', previewAllowed: false, applyAllowed: false };
}

module.exports = {
  ACCOUNT_STATUSES,
  EVENT_ACTIONS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  ORGANIZATION_STATUSES,
  ROLES,
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  callableData,
  enumValue,
  invitationToken,
  licenceAccessDecision,
  normalizedEmail,
  requiredString,
  resolveActivationTarget,
  safeDocumentId,
  selectEmailInvitation,
  tokenHash
};
