'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBranchName, validateCommitMessage } = require('../tools/repository-policy');

test('accepts focused Conventional Commit subjects', () => {
  assert.equal(validateCommitMessage('feat(review): add investigation companion'), null);
  assert.equal(validateCommitMessage('fix!: reject unsafe claim mutation'), null);
  assert.equal(validateCommitMessage('Merge pull request #42 from example/feat/review'), null);
});

test('rejects vague, unknown, and oversized commit subjects', () => {
  assert.match(validateCommitMessage('updated files'), /expected/);
  assert.match(validateCommitMessage('feature(review): add companion'), /expected/);
  assert.match(validateCommitMessage(`feat(review): ${'x'.repeat(73)}`), /maximum is 72/);
});

test('accepts approved short-lived branch names', () => {
  assert.equal(validateBranchName('feat/investigation-companion'), null);
  assert.equal(validateBranchName('fix/review/empty-state'), null);
  assert.equal(validateBranchName('dependabot/npm_and_yarn/eslint-11'), null);
});

test('rejects protected, ambiguous, and malformed branch names', () => {
  assert.match(validateBranchName('main'), /protected/);
  assert.match(validateBranchName('my-work'), /approved prefix/);
  assert.match(validateBranchName('feat/Uppercase'), /lowercase slug/);
});
