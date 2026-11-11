'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function validationEnv() {
  // Git sets these when invoking hooks. Do not let child checks or test
  // repositories accidentally use the real repository's index or metadata.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function withStagedSnapshot(root, validate) {
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (git('ls-files', '--unmerged')) throw new Error('Resolve staged merge conflicts before committing');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-staged-'));
  const env = validationEnv();
  try {
    git('-c', 'core.autocrlf=false', 'checkout-index', '--all', `--prefix=${directory.replace(/\\/g, '/')}/`);
    // Secret scanning needs a tracked-file inventory. A disposable repository
    // and a copy of the index provide it without exposing the real Git metadata.
    execFileSync('git', ['init', '--quiet', '--initial-branch=staged-validation', directory], { env });
    fs.copyFileSync(git('rev-parse', '--path-format=absolute', '--git-path', 'index'), path.join(directory, '.git', 'index'));

    for (const relative of ['node_modules', 'functions/node_modules']) {
      const source = path.join(root, relative);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(directory, relative);
      if (fs.existsSync(destination)) throw new Error(`${relative} must not be tracked`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return validate(directory, env);
  } finally {
    // rm removes the dependency links themselves, never their targets.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  return withStagedSnapshot(root, (directory, env) => {
    for (const script of ['check', 'lint', 'test:functions']) {
      console.log(`pre-commit: validating staged files with npm run ${script}`);
      const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
        cwd: directory, env, stdio: 'inherit', shell: process.platform === 'win32'
      });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status || 1;
    }
    return 0;
  });
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`pre-commit: staged validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { withStagedSnapshot };
