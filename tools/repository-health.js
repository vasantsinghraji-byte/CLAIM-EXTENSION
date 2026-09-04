'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const branch = run('git', ['branch', '--show-current']) || '(detached HEAD)';
const statusLines = run('git', ['status', '--porcelain=v1']).split('\n').filter(Boolean);
const hooksPath = run('git', ['config', '--local', '--get', 'core.hooksPath']);
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const lockRoot = packageLock.packages && packageLock.packages[''];
const versionsMatch = packageJson.version === packageLock.version
  && (!lockRoot || packageJson.version === lockRoot.version);
const mergedBranches = run('git', ['branch', '--merged', 'main', '--format=%(refname:short)'])
  .split('\n')
  .filter((name) => name && name !== 'main' && name !== branch);

console.log(`Branch: ${branch}`);
console.log(`Worktree: ${statusLines.length ? `${statusLines.length} changed/untracked path(s)` : 'clean'}`);
console.log(`Hooks: ${hooksPath === '.githooks' ? 'configured' : `not configured (found '${hooksPath || 'unset'}')`}`);
console.log(`Lock metadata: ${versionsMatch ? 'consistent' : `mismatch (${packageJson.version} vs ${packageLock.version})`}`);
console.log(`Merged local branches: ${mergedBranches.length ? mergedBranches.join(', ') : 'none'}`);

if (statusLines.length) {
  console.log('\nChanged paths:');
  console.log(statusLines.join('\n'));
}

if (!versionsMatch || hooksPath !== '.githooks') {
  process.exitCode = 1;
}
