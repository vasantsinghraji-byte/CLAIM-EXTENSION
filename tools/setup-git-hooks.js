'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const gitEntry = path.join(root, '.git');

// Package consumers may not have repository metadata. In that case there is
// nothing to configure, and dependency installation should still succeed.
if (!fs.existsSync(gitEntry)) {
  process.exit(0);
}

try {
  const ensureConfig = (key, expected) => {
    let current = '';
    try {
      current = execFileSync('git', ['config', '--local', '--get', key], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch {
      // A missing key is expected on the first install.
    }

    if (current !== expected) {
      execFileSync('git', ['config', '--local', key, expected], {
        cwd: root,
        stdio: 'inherit'
      });
    }
  };

  ensureConfig('core.hooksPath', '.githooks');
  ensureConfig('commit.template', '.gitmessage');

  for (const hook of ['pre-commit', 'commit-msg']) {
    fs.chmodSync(path.join(root, '.githooks', hook), 0o755);
  }
} catch (error) {
  console.error(`Unable to configure Git hooks: ${error.message}`);
  process.exit(1);
}
