'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { withStagedSnapshot } = require('../tools/validate-staged');
const { createSnapshot } = require('../tools/repository-snapshot');

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-safeguards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => execFileSync('git', [
    '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${path.join(root, 'disabled-hooks')}`,
    '-c', 'user.name=Safeguards Test', '-c', 'user.email=safeguards@example.invalid', ...args
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  git('init', '--initial-branch=chore/example');
  git('config', '--local', 'core.autocrlf', 'false');
  write('.gitignore', 'artifacts/\nnode_modules/\nfunctions/node_modules/\n');
  write('sample.js', 'const base = true;\n');
  write('removed.txt', 'remove me\n');
  write('binary.dat', Buffer.from([0, 1, 2, 255]));
  git('add', '.');
  git('commit', '-m', 'chore: initialize fixture');
  return { root, git, write };
}

test('staged validation exposes staged failures and excludes unstaged fixes and untracked dependencies', (t) => {
  const { root, git, write } = repository(t);
  write('sample.js', 'const broken = ;\n');
  write('staged new.js', 'module.exports = true;\n');
  git('add', 'sample.js', 'staged new.js');
  git('rm', 'removed.txt');
  write('sample.js', 'const fixed = true;\n');
  write('unstaged.js', 'module.exports = true;\n');
  const before = git('status', '--porcelain=v1');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  let temporary;
  withStagedSnapshot(root, (directory, env) => {
    temporary = directory;
    const result = spawnSync(process.execPath, ['--check', 'sample.js'], { cwd: directory, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'unstaged syntax fix must not hide the staged syntax error');
    assert.equal(fs.existsSync(path.join(directory, 'unstaged.js')), false);
    assert.equal(fs.existsSync(path.join(directory, 'removed.txt')), false);
    assert.equal(fs.readFileSync(path.join(directory, 'staged new.js'), 'utf8'), 'module.exports = true;\n');
    const inventory = execFileSync('git', ['ls-files'], { cwd: directory, env, encoding: 'utf8' });
    assert.match(inventory, /staged new.js/);
    assert.doesNotMatch(inventory, /removed.txt|unstaged.js/);
    assert.equal(Object.keys(env).some((key) => key.startsWith('GIT_')), false);
  });
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  assert.equal(git('status', '--porcelain=v1'), before);
  assert.equal(fs.readFileSync(path.join(root, 'sample.js'), 'utf8'), 'const fixed = true;\n');
});

test('failed staged checks clean up temporary dependencies without deleting their targets', (t) => {
  const { root, write } = repository(t);
  write('node_modules/sentinel.txt', 'keep root dependencies');
  write('functions/node_modules/sentinel.txt', 'keep Functions dependencies');
  let temporary;
  assert.throws(() => withStagedSnapshot(root, (directory) => {
    temporary = directory;
    assert.equal(fs.readFileSync(path.join(directory, 'node_modules/sentinel.txt'), 'utf8'), 'keep root dependencies');
    assert.equal(fs.readFileSync(path.join(directory, 'functions/node_modules/sentinel.txt'), 'utf8'), 'keep Functions dependencies');
    throw new Error('check failed');
  }), /check failed/);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/sentinel.txt'), 'utf8'), 'keep root dependencies');
  assert.equal(fs.readFileSync(path.join(root, 'functions/node_modules/sentinel.txt'), 'utf8'), 'keep Functions dependencies');
});

test('snapshot restores staged, unstaged, deleted, binary and Unicode untracked files without changing the source', (t) => {
  const { root, git, write } = repository(t);
  write('sample.js', 'const staged = true;\n');
  git('add', 'sample.js');
  write('sample.js', 'const unstaged = true;\n');
  write('binary.dat', Buffer.from([0, 255, 3, 128, 12]));
  fs.unlinkSync(path.join(root, 'removed.txt'));
  write('new folder/notes é.txt', 'untracked content\n');
  write('new folder/image.bin', Buffer.from([0, 10, 255]));
  write('artifacts/private.txt', 'ignored output');
  const before = git('status', '--porcelain=v1', '--untracked-files=all');
  const originalIndex = fs.readFileSync(path.join(root, '.git/index'));
  const directory = createSnapshot(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.branch, 'chore/example');
  assert.equal(manifest.base, git('rev-parse', 'HEAD'));
  assert.deepEqual(manifest.untracked.map((file) => file.path), ['new folder/image.bin', 'new folder/notes é.txt']);
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), originalIndex);

  const recovery = path.join(root, 'artifacts/recovery');
  git('clone', '--quiet', '--no-hardlinks', '--config', 'core.autocrlf=false', root, recovery);
  const restore = (...args) => execFileSync('git', args, { cwd: recovery, stdio: 'pipe' });
  restore('apply', '--index', path.join(directory, 'staged.patch'));
  restore('apply', path.join(directory, 'unstaged.patch'));
  fs.cpSync(path.join(directory, 'untracked'), recovery, { recursive: true });
  assert.equal(restore('status', '--porcelain=v1', '--untracked-files=all').toString('utf8').trim(), before);
  assert.deepEqual(fs.readFileSync(path.join(recovery, 'binary.dat')), fs.readFileSync(path.join(root, 'binary.dat')));
  assert.equal(restore('show', ':sample.js').toString('utf8'), 'const staged = true;\n');
  assert.equal(fs.readFileSync(path.join(recovery, 'sample.js'), 'utf8'), 'const unstaged = true;\n');
  assert.equal(fs.existsSync(path.join(directory, 'untracked/artifacts/private.txt')), false);
});

test('snapshot refuses a destination that is not ignored', (t) => {
  const { root, write } = repository(t);
  write('.gitignore', 'node_modules/\n');
  assert.throws(() => createSnapshot(root));
  assert.equal(fs.existsSync(path.join(root, 'artifacts/repository-snapshots')), false);
});
