'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lockMetadataErrors } = require('../tools/repository-health');

test('lock metadata detects dependency drift even when versions match', () => {
  const pkg = { version: '1.0.0', dependencies: { example: '^2.0.0' } };
  const lock = { version: '1.0.0', packages: { '': { version: '1.0.0', dependencies: { example: '^1.0.0', stale: '1.0.0' } } } };
  assert.deepEqual(lockMetadataErrors(pkg, lock), ['dependencies.example differs', 'dependencies.stale differs']);
});

test('lock metadata checks package versions and requires root metadata', () => {
  assert.match(lockMetadataErrors({ version: '2.0.0' }, { version: '1.0.0', packages: { '': { version: '1.0.0' } } })[0], /versions differ/);
  assert.match(lockMetadataErrors({}, {})[0], /root package metadata/);
});

test('lock metadata accepts matching manifests without optional dependencies', () => {
  const pkg = { version: '1.0.0', devDependencies: { example: '^1.0.0' } };
  assert.deepEqual(lockMetadataErrors(pkg, { version: pkg.version, packages: { '': pkg } }), []);
});

test('health reports Git failures instead of declaring a clean worktree', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/repository-health.js')], {
    encoding: 'utf8', env: { ...env, PATH: '' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository-health: git .* failed/);
  assert.doesNotMatch(result.stdout, /Worktree: clean/);
});
