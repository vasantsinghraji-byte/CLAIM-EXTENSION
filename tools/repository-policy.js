'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const COMMIT_PATTERN = /^(feat|fix|refactor|chore|docs|test|build|ci|perf|style|revert)(\([a-z0-9./-]+\))?!?: .+$/;
const BRANCH_PATTERN = /^(feat|fix|hotfix|refactor|chore|docs|test|build|ci|perf|release|experiment|dependabot|renovate)\/[a-z0-9][a-z0-9._/-]*$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop']);

function validateCommitMessage(message) {
  const firstLine = String(message || '').split(/\r?\n/, 1)[0];

  if (/^(Merge |Revert |fixup!|squash!)/.test(firstLine)) {
    return null;
  }

  if (firstLine.length > 72) {
    return `commit subject is ${firstLine.length} characters; maximum is 72`;
  }

  if (!COMMIT_PATTERN.test(firstLine)) {
    return 'expected <type>(<scope>)?: <subject> using an approved Conventional Commit type';
  }

  return null;
}

function validateBranchName(branch) {
  const name = String(branch || '').trim();

  if (PROTECTED_BRANCHES.has(name)) {
    return `direct commits to protected branch '${name}' are not allowed`;
  }

  if (!BRANCH_PATTERN.test(name)) {
    return `branch '${name}' must use an approved prefix and a lowercase slug`;
  }

  return null;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fail(label, detail) {
  console.error(`repository-policy: ${label}: ${detail}`);
  process.exitCode = 1;
}

function checkCommit(message, label = 'commit message') {
  const error = validateCommitMessage(message);
  if (error) fail(label, error);
}

function checkRange(base, head) {
  if (!base || !head || /^0+$/.test(base)) return;

  const records = git(['log', '--format=%H%x00%s', `${base}..${head}`]);
  if (!records) return;

  for (const record of records.split('\n')) {
    const [sha, subject] = record.split('\0');
    checkCommit(subject, `commit ${sha.slice(0, 12)}`);
  }
}

function checkCiEvent(eventPath) {
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

  if (event.pull_request) {
    const branchError = validateBranchName(event.pull_request.head.ref);
    if (branchError) fail('pull-request branch', branchError);
    checkRange(event.pull_request.base.sha, event.pull_request.head.sha);
    return;
  }

  if (event.before && event.after) {
    checkRange(event.before, event.after);
  }
}

function main(argv) {
  const [command, ...args] = argv;

  if (command === 'commit-msg' && args[0]) {
    checkCommit(fs.readFileSync(args[0], 'utf8'));
  } else if (command === 'branch' && args[0]) {
    const error = validateBranchName(args[0]);
    if (error) fail('branch', error);
  } else if (command === 'current-branch') {
    const error = validateBranchName(git(['symbolic-ref', '--quiet', '--short', 'HEAD']));
    if (error) fail('branch', error);
  } else if (command === 'range' && args.length === 2) {
    checkRange(args[0], args[1]);
  } else if (command === 'ci') {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error('GITHUB_EVENT_PATH is required for CI policy validation');
    }
    checkCiEvent(process.env.GITHUB_EVENT_PATH);
  } else {
    console.error('Usage: repository-policy.js commit-msg <file> | branch <name> | current-branch | range <base> <head> | ci');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail('unable to validate repository policy', error.message);
  }
}

module.exports = { validateBranchName, validateCommitMessage };
