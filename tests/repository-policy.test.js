'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validateBranchName, validateCommitMessage } = require('../tools/repository-policy');

test('accepts focused Conventional Commit subjects', () => {
  assert.equal(validateCommitMessage('feat(review): add investigation companion'), null);
  assert.equal(validateCommitMessage('fix!: reject unsafe claim mutation'), null);
  assert.equal(validateCommitMessage('Merge pull request #42 from example/feat/review'), null);
});

test('rejects vague, unknown, and oversized commit subjects', () => {
  assert.match(validateCommitMessage('updated files'), /expected/);
  assert.match(validateCommitMessage('feature(review): add companion'), /expected/);
  assert.match(validateCommitMessage('feat:    '), /expected/);
  assert.match(validateCommitMessage(`feat(review): ${'x'.repeat(73)}`), /maximum is 72/);
});

function repository(t, initialMessage = 'chore: initialize repository') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-repository-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [
    '-c', `core.hooksPath=${path.join(directory, 'disabled-hooks')}`,
    '-c', 'user.name=Policy Test', '-c', 'user.email=policy@example.invalid', ...args
  ], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('commit', '--allow-empty', '-m', initialMessage);
  const base = git('rev-parse', 'HEAD');
  const policy = (...args) => spawnSync(process.execPath, [
    path.resolve(__dirname, '../tools/repository-policy.js'), ...args
  ], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: path.join(directory, 'event.json') } });
  const event = (payload) => {
    fs.writeFileSync(path.join(directory, 'event.json'), JSON.stringify(payload));
    return policy('ci');
  };
  return { git, base, policy, event };
}

test('range policy rejects autosquash commits and fake merge subjects', (t) => {
  const { git, base, policy } = repository(t);
  git('commit', '--allow-empty', '-m', 'fixup! chore: initialize repository');
  assert.equal(validateCommitMessage('fixup! chore: initialize repository'), null);
  let result = policy('range', base, 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /autosquash commits must be resolved/);
  git('commit', '--amend', '--allow-empty', '-m', 'Merge bypass validation');
  result = policy('range', base, 'HEAD');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected/);
});

test('range policy accepts genuine merge commits and conventional changes', (t) => {
  const { git, base, policy } = repository(t);
  git('switch', '-c', 'docs/example');
  git('commit', '--allow-empty', '-m', 'docs: explain the workflow');
  git('switch', 'main');
  git('merge', '--no-ff', 'docs/example', '-m', 'Merge branch docs/example');
  const result = policy('range', base, 'HEAD');
  assert.equal(result.status, 0, result.stderr);
});

test('CI rejects unfinished experiments and incomplete event payloads', (t) => {
  const { git, base, event } = repository(t);
  git('commit', '--allow-empty', '-m', 'test: try a new approach');
  const head = git('rev-parse', 'HEAD');
  const result = event({ pull_request: { base: { sha: base }, head: { sha: head, ref: 'experiment/example' } } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /graduate experiments/);
  assert.equal(event({}).status, 1);
  assert.equal(event({ pull_request: { base: {}, head: { ref: 'feat/example' } } }).status, 1);
});

test('initial push validates history instead of silently skipping policy', (t) => {
  const { base, event } = repository(t, 'unstructured initial commit');
  const result = event({ before: '0'.repeat(40), after: base });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected/);
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
