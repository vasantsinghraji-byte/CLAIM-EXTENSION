'use strict';

const crypto = require('node:crypto');

const ROLES = Object.freeze(['processor', 'organizationAdmin', 'platformAdmin']);
const INVITABLE_ROLES = Object.freeze(['processor', 'organizationAdmin']);
const ACCOUNT_STATUSES = Object.freeze(['invited', 'active', 'rejected', 'suspended', 'deleted']);
const LICENCE_STATUSES = Object.freeze(['active', 'suspended', 'expired']);
const LICENSE_TYPES = Object.freeze(['organisation', 'individual']);
const LICENSE_STATUSES = Object.freeze(['inactive', 'active', 'expired']);
const PAYMENT_STATUSES = Object.freeze(['not_required', 'pending_verification', 'verified']);
const INDIVIDUAL_PLAN_PRICES = Object.freeze({ 1: 99, 2: 198, 4: 300, 12: 500 });
const DEFAULT_LICENSE = Object.freeze({
  type: 'individual',
  status: 'inactive',
  durationWeeks: 0,
  activatedAt: null,
  expiresAt: null,
  organizationId: null,
  paymentStatus: 'not_required',
  paymentReference: null,
  paymentProvider: 'upi',
  requestedDurationWeeks: null,
  paymentAmount: null,
  verifiedBy: null,
  verifiedAt: null
});
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

function semanticVersion(value, name = 'version') {
  const version = requiredString(value, name, 32);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`${name} is invalid`);
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error(`${name} is invalid`);
  return { value: version, parts };
}

function compareSemanticVersions(left, right) {
  const leftParts = semanticVersion(left, 'leftVersion').parts;
  const rightParts = semanticVersion(right, 'rightVersion').parts;
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function normalizedPaymentReference(value) {
  const reference = requiredString(value, 'paymentReference', 160)
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!/^[A-Z0-9_-]{6,160}$/.test(reference)) throw new Error('paymentReference is invalid');
  return reference;
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

function rosterDocumentId(organizationId, employeeCode) {
  const organization = safeDocumentId(organizationId, 'organizationId');
  const code = safeDocumentId(String(employeeCode).toUpperCase(), 'employeeCode');
  return `${organization}_${code}`;
}

function individualPlan(durationWeeks) {
  const weeks = boundedInteger(durationWeeks, 'durationWeeks', 1, 12);
  const price = INDIVIDUAL_PLAN_PRICES[weeks];
  if (!price) throw new Error('durationWeeks is not an available individual plan');
  return { durationWeeks: weeks, price };
}

function computeLicenseExpiry(durationWeeks, from = Date.now()) {
  return from + durationWeeks * 7 * 24 * 60 * 60 * 1000;
}

module.exports = {
  ACCOUNT_STATUSES,
  DEFAULT_LICENSE,
  EVENT_ACTIONS,
  INVITABLE_ROLES,
  LICENCE_STATUSES,
  LICENSE_STATUSES,
  LICENSE_TYPES,
  ORGANIZATION_STATUSES,
  PAYMENT_STATUSES,
  INDIVIDUAL_PLAN_PRICES,
  ROLES,
  assertKeys,
  assertNoClaimContent,
  boundedInteger,
  callableData,
  compareSemanticVersions,
  computeLicenseExpiry,
  enumValue,
  invitationToken,
  licenceAccessDecision,
  normalizedEmail,
  normalizedPaymentReference,
  individualPlan,
  requiredString,
  resolveActivationTarget,
  rosterDocumentId,
  safeDocumentId,
  semanticVersion,
  selectEmailInvitation,
  tokenHash
};
