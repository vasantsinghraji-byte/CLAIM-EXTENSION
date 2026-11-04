'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateBranchName } = require('./repository-policy');

const root = path.resolve(__dirname, '..');
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function lockMetadataErrors(pkg, lock) {
  const errors = [];
  const lockRoot = lock.packages?.[''];
  if (!lockRoot) return ['lockfile must contain root package metadata; regenerate with npm install'];
  if (pkg.version !== lock.version || pkg.version !== lockRoot.version) {
    errors.push('package and lockfile versions differ');
  }
  for (const field of DEPENDENCY_FIELDS) {
    const expected = pkg[field] || {};
    const actual = lockRoot[field] || {};
    for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (expected[name] !== actual[name]) errors.push(`${field}.${name} differs`);
    }
  }
  return errors;
}

function main() {
  function git(args, { optional = false } = {}) {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trimEnd();
    } catch (error) {
      if (optional) return '';
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`, { cause: error });
    }
  }

  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  const branchError = validateBranchName(branch);
  const statusLines = git(['status', '--porcelain=v1']).split('\n').filter(Boolean);
  const hooksPath = git(['config', '--local', '--get', 'core.hooksPath'], { optional: true });
  const template = git(['config', '--local', '--get', 'commit.template'], { optional: true });
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { optional: true });
  const base = 'refs/remotes/origin/main';
  const hasBase = git(['rev-parse', '--verify', base], { optional: true });
  const mergedBranches = hasBase
    ? git(['branch', '--merged', base, '--format=%(refname:short)'])
      .split('\n').filter((name) => name && !['main', 'master', 'develop', branch].includes(name))
    : [];

  console.log(`Branch: ${branch}${branchError ? ` (policy: ${branchError})` : ''}`);
  console.log(`Worktree: ${statusLines.length ? `${statusLines.length} changed/untracked path(s)` : 'clean'}`);
  console.log(`Linked worktrees:\n${git(['worktree', 'list'])}`);
  console.log(`Hooks: ${hooksPath === '.githooks' ? 'configured' : `not configured (found '${hooksPath || 'unset'}')`}`);
  console.log(`Commit template: ${template === '.gitmessage' ? 'configured' : 'not configured'}`);
  console.log(`Upstream: ${upstream || 'unset (expected for a new local branch)'}`);
  if (upstream) {
    const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/);
    console.log(`Upstream divergence: ${ahead} ahead, ${behind} behind`);
  }
  if (hasBase) {
    const [ahead, behind] = git(['rev-list', '--left-right', '--count', `HEAD...${base}`]).split(/\s+/);
    console.log(`Cached origin/main: ${ahead} ahead, ${behind} behind (run git fetch --prune to refresh)`);
  } else {
    console.log('Cached origin/main: unavailable; fetch origin before starting new work');
  }
  console.log(`Merged local branches: ${mergedBranches.length ? mergedBranches.join(', ') : 'none'}`);

  let lockErrors = false;
  for (const directory of ['', 'functions']) {
    const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, directory, name), 'utf8'));
    const errors = lockMetadataErrors(readJson('package.json'), readJson('package-lock.json'));
    lockErrors ||= errors.length > 0;
    console.log(`Lock metadata (${directory || 'root'}): ${errors.length ? errors.join('; ') : 'consistent'}`);
  }

  if (statusLines.length) console.log(`\nChanged paths:\n${statusLines.join('\n')}`);
  if (branchError || lockErrors || hooksPath !== '.githooks' || template !== '.gitmessage') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`repository-health: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { lockMetadataErrors };
