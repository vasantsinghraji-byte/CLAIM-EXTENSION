'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('processing-rule mutations are server-authorized and absent from processor options', () => {
  const functions = read('functions/index.js');
  const background = read('background.js');
  const options = read('options.js');
  for (const callable of [
    'listProcessingRuleDrafts', 'saveProcessingRuleDraft', 'setProcessingRuleStatus',
    'validateProcessingRuleDrafts', 'publishProcessingRuleDrafts', 'listProcessingRuleVersions',
    'activateProcessingRuleVersion', 'listProcessingRuleHistory', 'listProcessingRuleFeedback',
    'reviewProcessingRuleFeedback', 'listProcessingRuleApprovals',
    'approveProcessingRulePublication', 'rejectProcessingRulePublication'
  ]) {
    const start = functions.indexOf(`exports.${callable} = onCall`);
    assert.ok(start >= 0, `${callable} is exported`);
    assert.match(functions.slice(start, start + 600), /requirePlatformAdmin\(request\)/);
  }
  assert.doesNotMatch(background, /request\?\.action === 'setRuleOverride'/);
  assert.doesNotMatch(background, /request\?\.action === 'setCustomRuleConfig'/);
  assert.doesNotMatch(options, /action: 'setRuleOverride'/);
});

test('published rules are immutable snapshots with version-bound extension processing', () => {
  const functions = read('functions/index.js');
  const background = read('background.js');
  const content = read('content.js');
  assert.match(functions, /transaction\.create\(versionReference/);
  assert.match(functions, /processingRuleState\/active/);
  assert.match(functions, /latestVersionId !== activeVersionId/);
  assert.match(background, /name: 'getActiveProcessingRules'/);
  assert.match(content, /ruleSetVersion: processingRuleSet\?\.versionId/);
  assert.match(content, /processing-rules-changed/);
  assert.match(content, /mandatory-action-required/);
  assert.match(content, /mandatory-action-override/);
  assert.match(content, /bundledFallbackEnabled/);
  assert.match(functions, /bundledFallbackEnabled/);
});

test('admin dashboard exposes draft, impact, publish, rollback, history, and feedback workflows', () => {
  const html = read('hosting/admin.html');
  const admin = read('hosting/admin.js');
  for (const id of [
    'ruleForm', 'validateRules', 'publishRules', 'ruleImpact', 'rulesList',
    'ruleVersionsList', 'ruleHistoryList', 'ruleFeedbackList', 'conditionBuilder',
    'actionBuilder', 'scenarioBuilder', 'ruleApprovalsList'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const callable of [
    'saveProcessingRuleDraft', 'validateProcessingRuleDrafts', 'publishProcessingRuleDrafts',
    'activateProcessingRuleVersion', 'listProcessingRuleHistory', 'reviewProcessingRuleFeedback',
    'listProcessingRuleApprovals', 'approveProcessingRulePublication', 'rejectProcessingRulePublication'
  ]) assert.match(admin, new RegExp(`['"]${callable}['"]`));
  assert.doesNotMatch(html, /Conditions \(JSON\)|Actions \(JSON array\)/);
  assert.doesNotMatch(admin, /JSON\.parse\(form\.elements\.(conditions|actions)/);
  assert.doesNotMatch(admin, /\.innerHTML\s*=/);
});

test('high-impact publication requires synthetic coverage and a distinct second administrator', () => {
  const functions = read('functions/index.js');
  const publish = functions.slice(functions.indexOf('exports.publishProcessingRuleDrafts = onCall'), functions.indexOf('exports.listProcessingRuleApprovals = onCall'));
  const approve = functions.slice(functions.indexOf('exports.approveProcessingRulePublication = onCall'), functions.indexOf('exports.rejectProcessingRulePublication = onCall'));
  assert.match(publish, /scenarioPublicationCheck/);
  assert.match(publish, /processingRuleApprovals/);
  assert.match(publish, /status: 'pending'/);
  assert.match(approve, /approval\.requestedBy === auth\.uid/);
  assert.match(approve, /different platform administrator/);
  assert.match(approve, /transaction\.create\(versionReference/);
});

test('processor feedback is structured and excludes claim identifiers, amounts, and free text', () => {
  const functions = read('functions/index.js');
  const start = functions.indexOf('exports.submitProcessingRuleFeedback = onCall');
  const end = functions.indexOf('exports.listProcessingRuleFeedback = onCall', start);
  const endpoint = functions.slice(start, end);
  assert.match(endpoint, /FEEDBACK_CATEGORIES/);
  assert.match(endpoint, /activeUser\(auth\.uid\)/);
  assert.doesNotMatch(endpoint, /claimId|transactionId|patient|diagnosis|freeText/i);
  assert.match(endpoint, /packageCodes/);
});

test('Firestore denies direct client access to every processing-rule collection', () => {
  const rules = read('firestore.rules');
  for (const collection of [
    'processingRuleDrafts', 'processingRuleSets', 'processingRuleState',
    'processingRuleHistory', 'processingRuleFeedback', 'processingRuleApprovals'
  ]) {
    assert.match(rules, new RegExp(`match /${collection}/\\{document=\\*\\*\\}`));
  }
});
